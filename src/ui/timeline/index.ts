/**
 * Timeline orchestrator.
 *
 * Owns only what is SHARED across every track kind: the canvas/DOM lifecycle,
 * the time ruler, the playhead, the left gutter (track headers), zoom, and the
 * unified pointer-event dispatch. All track-type-specific drawing and
 * interaction is delegated to a `TrackView` (textView / audioView) looked up by
 * `track.type`. Adding a new track kind = add a view module + register it here.
 *
 * Layout: a fixed LEFT GUTTER of track headers + a horizontally-scrollable
 * canvas on the right. Time is measured from the canvas left edge (x=0).
 */
import { store } from '../../state/store';
import { audioEngine } from '../../lib/audioEngine';
import { timingCapture } from '../../lib/timing';
import { flatSyllables } from '../../lib/textParser';
import { Project, AudioTrack, createTextTrack, getAudioTrackByRole } from '../../types';
import {
  loadAudioIntoRole,
  loadAudioBytesIntoRole,
  clearAudioRole,
  getAudioBytesMap,
} from '../../lib/audioLoader';
import { separateVocals, getSeparationStatus } from '../../lib/separation';
import { openSeparationDialog } from '../separationDialog';
import type { ToastFn } from '../controls';
import { RULER_H, TOP_PAD, TRACK_PAD, rowHeight, trackTopForIndex, trackIndexAtY } from './coords';
import { Ctx, TimelineEnv, TrackDrag, TrackView } from './types';
import { textView, pickMarker } from './textView';
import { audioView } from './audioView';

/** Registry of track views by `type`. A new track kind adds one entry here. */
const VIEWS: Record<string, TrackView> = {
  text: textView as TrackView,
  audio: audioView as TrackView,
};

export function createTimeline(toast: ToastFn): { root: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'timeline';

  const head = document.createElement('div');
  head.className = 'timeline-head';
  const headTitle = document.createElement('span');
  headTitle.textContent = 'Таймлайн';
  head.appendChild(headTitle);
  const headHint = document.createElement('span');
  headHint.className = 'hint';
  headHint.textContent = '— клик = перемотка, перетаскивайте маркеры';
  head.appendChild(headHint);

  // Zoom controls (always visible; on desktop Shift+wheel still works too).
  const zoomControls = document.createElement('div');
  zoomControls.className = 'tl-zoom-controls';
  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'tl-zoom-btn';
  zoomOutBtn.textContent = '➖';
  zoomOutBtn.title = 'Уменьшить';
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'tl-zoom-label';
  zoomLabel.textContent = '100%';
  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'tl-zoom-btn';
  zoomInBtn.textContent = '➕';
  zoomInBtn.title = 'Увеличить';
  zoomControls.appendChild(zoomOutBtn);
  zoomControls.appendChild(zoomLabel);
  zoomControls.appendChild(zoomInBtn);
  head.appendChild(zoomControls);
  root.appendChild(head);

  // Body: fixed gutter (left) + scrollable canvas (right).
  const body = document.createElement('div');
  body.className = 'timeline-body';

  const gutter = document.createElement('div');
  gutter.className = 'timeline-gutter';
  body.appendChild(gutter);

  const scroll = document.createElement('div');
  scroll.className = 'timeline-scroll';
  // Spacer that defines the scrollable content width; the canvas is sticky
  // inside it so it stays viewport-wide while the spacer scrolls underneath
  // (see CSS .timeline-canvas-wrap / .timeline-canvas). This keeps the canvas
  // backing store small (= viewport × dpr) regardless of zoom.
  const wrap = document.createElement('div');
  wrap.className = 'timeline-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'timeline-canvas';
  const ctx = canvas.getContext('2d')!;
  wrap.appendChild(canvas);
  scroll.appendChild(wrap);
  body.appendChild(scroll);

  root.appendChild(body);

  let zoom = 1; // multiplied onto the base width
  let playheadMs = 0;
  // Recording state: whether we're capturing timings, and the flat index of the
  // syllable that the next Space will stamp. Used to preview it beside the playhead.
  let recording = false;
  let recordCursor = 0;

  // Viewport width = the on-screen canvas. Content width = the full virtual
  // timeline (viewport × zoom); the spacer is sized to it so the scroll
  // container can pan, while the canvas itself stays viewport-wide.
  const viewportWidth = () => Math.max(1, scroll.clientWidth - 4);
  const contentWidth = () => viewportWidth() * zoom;

  function durationMs(p?: Project): number {
    const proj = p ?? store.getProject();
    return Math.max(proj.durationMs, 1);
  }

  const msToX = (ms: number) => (ms / durationMs()) * contentWidth();
  const xToMs = (x: number) => (x / contentWidth()) * durationMs();

  /** Convert a pointer's clientX to a CONTENT-space x. The canvas is sticky and
   *  viewport-wide, so rect.left is the viewport's left edge; adding scrollLeft
   *  maps it into the [0, contentWidth] space the views and msToX work in. */
  const pointerContentX = (clientX: number): number =>
    clientX - canvas.getBoundingClientRect().left + scroll.scrollLeft;

  /** Reflect the current zoom level in the header label (e.g. "230%"). */
  function updateZoomLabel(): void {
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  /**
   * Apply a zoom factor anchored at a given time (ms), keeping that time under the
   * same screen X after the zoom by adjusting scrollLeft. Shared by the zoom
   * buttons, pinch and Shift+wheel. `factor` >1 zooms in, <1 zooms out.
   */
  function zoomAt(anchorMs: number, factor: number): void {
    const anchorX = msToX(anchorMs);
    zoom = Math.max(1, Math.min(40, zoom * factor));
    const newAnchorX = msToX(anchorMs);
    scroll.scrollLeft += newAnchorX - anchorX;
    updateZoomLabel();
    draw();
  }

  /** Zoom centered on the middle of the currently visible timeline span. */
  function zoomCentered(factor: number): void {
    const centerMs = xToMs(scroll.scrollLeft + scroll.clientWidth / 2);
    zoomAt(centerMs, factor);
  }
  zoomInBtn.addEventListener('click', () => zoomCentered(1.15));
  zoomOutBtn.addEventListener('click', () => zoomCentered(1 / 1.15));

  // The active drag (claimed by some track view's hitTest), carried across moves.
  let drag: TrackDrag | null = null;
  // True while a 2-finger pinch is active; pointermove ignores drags during it.
  let isPinching = false;

  // --- Pointer dispatch ---
  // Single pipeline: for each row, ask its view to hitTest; the first claim
  // wins and owns the drag. Otherwise, a background-click handler may act; the
  // fallback is a seek.
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = pointerContentX(e.clientX);
    const y = e.clientY - rect.top;
    const project = store.getProject();
    const tracks = project.tracks;
    const env = makeEnv();

    // 1. Try each row's view to claim the pointer (object hit).
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      const view = VIEWS[track.type];
      if (!view) continue;
      const rowY = trackTopForIndex(ti, tracks);
      // Text rows use a dedicated marker scan (needs the live track); other
      // kinds use the generic hitTest.
      const hit =
        track.type === 'text'
          ? pickMarker(ti, track, rowY, x, y, env)
          : view.hitTest(track, rowY, x, y, env);
      if (hit) {
        drag = hit;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    // 2. Background click within a row (e.g. add a volume point).
    const ti = trackIndexAtY(y, tracks);
    if (ti >= 0) {
      const track = tracks[ti];
      const view = VIEWS[track.type];
      if (view?.onBackgroundClick) {
        const rowY = trackTopForIndex(ti, tracks);
        view.onBackgroundClick(track, rowY, x, y, env);
        return;
      }
    }

    // 3. Fallback: seek.
    audioEngine.seek(xToMs(x));
  });

  // Double-click → delete a claimed object (e.g. a volume point).
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = pointerContentX(e.clientX);
    const y = e.clientY - rect.top;
    const project = store.getProject();
    const tracks = project.tracks;
    const env = makeEnv();
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      const view = VIEWS[track.type];
      if (!view?.onDoubleTap) continue;
      const rowY = trackTopForIndex(ti, tracks);
      const hit =
        track.type === 'text'
          ? pickMarker(ti, track, rowY, x, y, env)
          : view.hitTest(track, rowY, x, y, env);
      if (hit) {
        view.onDoubleTap(hit);
        return;
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || isPinching) return;
    const rect = canvas.getBoundingClientRect();
    const x = pointerContentX(e.clientX);
    const y = e.clientY - rect.top;
    const project = store.getProject();
    const tracks = project.tracks;
    const view = VIEWS[tracks[drag.trackIndex]?.type ?? ''];
    if (!view) return;
    const rowY = trackTopForIndex(drag.trackIndex, tracks);
    view.onDrag(drag, rowY, x, y, makeEnv());
  });

  canvas.addEventListener('pointerup', (e) => {
    if (drag) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      drag = null;
    }
  });

  // Zoom: Shift+wheel zooms (anchored at the cursor); plain wheel scrolls.
  scroll.addEventListener(
    'wheel',
    (e) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      const anchorMs = xToMs(pointerContentX(e.clientX));
      zoomAt(anchorMs, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false },
  );

  // --- Pinch-to-zoom (two-finger) on the timeline, for touch devices. ---
  // One finger still drags markers / pans (via pointer events above + the
  // scroll container's native pan-x). Two fingers zoom, anchored at the midpoint
  // between them — like a map. We track the gesture across touchstart/move/end.
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  /** Distance between the two touches, in canvas-local X coords (timeline only
   *  cares about the horizontal axis). */
  const pinchDistance = (t: TouchList): number => {
    const rect = canvas.getBoundingClientRect();
    const x1 = t[0].clientX - rect.left;
    const x2 = t[1].clientX - rect.left;
    return Math.abs(x2 - x1);
  };

  scroll.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 2) return;
      // Cancel any in-progress marker drag so the pinch owns the gesture.
      if (drag) {
        drag = null;
      }
      isPinching = true;
      pinchStartDist = pinchDistance(e.touches) || 1;
      pinchStartZoom = zoom;
    },
    { passive: true },
  );

  scroll.addEventListener(
    'touchmove',
    (e) => {
      if (!isPinching || e.touches.length !== 2) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      // Anchor at the midpoint between the two fingers, in CONTENT space.
      const midX =
        (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left + scroll.scrollLeft;
      const anchorMs = xToMs(midX);
      const factor = pinchDistance(e.touches) / pinchStartDist;
      // Reset to the gesture's start zoom, then apply the accumulated factor
      // through zoomAt so the anchor stays put.
      zoom = pinchStartZoom;
      zoomAt(anchorMs, factor);
    },
    { passive: false },
  );

  const endPinch = (): void => {
    if (!isPinching) return;
    isPinching = false;
  };
  scroll.addEventListener('touchend', endPinch);
  scroll.addEventListener('touchcancel', endPinch);

  audioEngine.onTime((t) => {
    playheadMs = t;
    draw();
  });
  store.subscribe(() => {
    renderGutter();
    draw();
  });
  timingCapture.onState((isRecording, cursor) => {
    recording = isRecording;
    recordCursor = cursor;
    draw();
  });

  // The canvas is viewport-wide and content is offset via translate(-scrollLeft),
  // so native scrolling no longer moves the painted pixels — we must redraw on
  // every scroll to keep the visible slice current. Throttle to one draw per
  // animation frame (scroll can fire many times per gesture).
  let drawScheduled = false;
  function scheduleDraw(): void {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      draw();
    });
  }
  scroll.addEventListener('scroll', scheduleDraw, { passive: true });
  // Repaint on viewport resize too (e.g. panel toggling, orientation change) —
  // otherwise the canvas would keep its old size until the next store/audio event.
  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(scroll);

  /** Build the shared env for the current frame. */
  function makeEnv(): TimelineEnv {
    return {
      msToX,
      xToMs,
      durationMs,
      width: contentWidth(),
      scrollLeft: scroll.scrollLeft,
      viewportWidth: scroll.clientWidth,
    };
  }

  // --- Gutter (left headers) ---
  // Rebuilt only when the set of tracks, their types/names or the active id
  // changes — NOT on every frame. Each header's height matches its canvas row.
  let lastGutterSig = '';
  function renderGutter(): void {
    const project = store.getProject();
    const sig =
      project.tracks.map((t) =>
        `${t.id}:${t.type}:${t.name}:${t.type === 'audio' ? `${t.audioFileName}:${(t as AudioTrack).muted ? 'M' : ''}:${(t as AudioTrack).solo ? 'S' : ''}` : ''}`,
      ).join('|') +
      '@' + project.activeTrackId;
    if (sig === lastGutterSig) return;
    lastGutterSig = sig;
    gutter.innerHTML = '';

    const rulerSpacer = document.createElement('div');
    rulerSpacer.className = 'timeline-gutter-ruler';
    // "Add text track" button, aligned with the ruler row so it sits above the
    // track headers (where the tabs used to live in the lyrics editor).
    const addBtn = document.createElement('button');
    addBtn.className = 'timeline-add-track';
    addBtn.textContent = '+ Текстовая дорожка';
    addBtn.title = 'Добавить текстовую дорожку';
    addBtn.addEventListener('click', () => {
      store.mutate((p) => {
        const t = createTextTrack(`Дорожка ${p.tracks.length + 1}`);
        p.tracks.push(t);
        p.activeTrackId = t.id;
      });
    });
    rulerSpacer.appendChild(addBtn);
    gutter.appendChild(rulerSpacer);

    for (const track of project.tracks) {
      const th = document.createElement('div');
      th.className =
        'timeline-track-head' +
        (track.id === project.activeTrackId ? ' active' : '') +
        (track.type === 'audio' ? ' audio' : '');
      th.style.height = rowHeight(track) + TRACK_PAD + 'px';
      th.title = 'Сделать эту дорожку активной';

      const name = document.createElement('span');
      name.className = 'timeline-track-name';
      if (track.type === 'audio') {
        name.textContent = '🎵 ' + track.name;
      } else {
        name.textContent = '🎤 ' + track.name;
      }
      th.appendChild(name);

      // "Extract" action: run Mel-RoFormer on the loaded original and fill the
      // lead-vocal and instrumental (minus) slots from a single run. Shown on
      // either empty 'lead' or 'minus' role when an original is loaded. If the
      // browser can't run the model, the click explains why.
      if (
        track.type === 'audio' &&
        (track.role === 'lead' || track.role === 'minus') &&
        !track.audioFileName &&
        getAudioBytesMap().has('original')
      ) {
        const extractBtn = document.createElement('span');
        extractBtn.className = 'timeline-track-extract';
        extractBtn.textContent = '✨';
        extractBtn.title = 'Извлечь вокал и минус из оригинала';
        extractBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void runSeparation();
        });
        th.appendChild(extractBtn);
      }

      // Mute / Solo buttons (audio roles only). M = gain 0; S = isolate.
      if (track.type === 'audio') {
        const at = track as AudioTrack;
        const muteBtn = document.createElement('span');
        muteBtn.className = 'timeline-track-ms mute' + (at.muted ? ' active' : '');
        muteBtn.textContent = 'M';
        muteBtn.title = at.muted ? 'Включить звук' : 'Заглушить';
        muteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          store.mutate((p) => {
            const t = p.tracks.find((x) => x.id === at.id);
            if (t && t.type === 'audio') t.muted = !t.muted;
          });
        });
        th.appendChild(muteBtn);

        const soloBtn = document.createElement('span');
        soloBtn.className = 'timeline-track-ms solo' + (at.solo ? ' active' : '');
        soloBtn.textContent = 'S';
        soloBtn.title = at.solo ? 'Снять соль' : 'Соль';
        soloBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          store.mutate((p) => {
            const t = p.tracks.find((x) => x.id === at.id);
            if (t && t.type === 'audio') t.solo = !t.solo;
          });
        });
        th.appendChild(soloBtn);
      }

      // Click on the header body: activate the track; for an empty audio role,
      // also open the load-audio dialog.
      th.addEventListener('click', (e) => {
        // Let inner buttons (extract / mute / solo / delete) handle their own clicks.
        if ((e.target as HTMLElement).closest('.timeline-track-del')) return;
        if ((e.target as HTMLElement).closest('.timeline-track-extract')) return;
        if ((e.target as HTMLElement).closest('.timeline-track-ms')) return;
        store.mutate((p) => (p.activeTrackId = track.id));
        if (track.type === 'audio' && !track.audioFileName) {
          openAudioPicker(track);
        }
      });

      // Delete / clear button.
      const del = document.createElement('span');
      del.className = 'timeline-track-del';
      del.textContent = '×';
      if (track.type === 'audio') {
        // Audio: clear the audio (slot stays). Only show if audio is loaded.
        del.title = 'Очистить аудио';
        del.style.display = track.audioFileName ? '' : 'none';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Очистить аудио в дорожке «${track.name}»?`)) return;
          clearAudioRole(track.role);
        });
      } else {
        // Text: delete the track (needs at least one text track to remain).
        del.title = 'Удалить дорожку';
        const proj = store.getProject();
        del.style.display = proj.tracks.filter((t) => t.type === 'text').length > 1 ? '' : 'none';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Удалить дорожку «${track.name}»?`)) return;
          store.mutate((p) => {
            const idx = p.tracks.findIndex((t) => t.id === track.id);
            if (idx < 0) return;
            p.tracks.splice(idx, 1);
            // Pick a neighbor as the new active track.
            const nextIdx = Math.min(idx, p.tracks.length - 1);
            p.activeTrackId = p.tracks[nextIdx].id;
          });
        });
      }
      th.appendChild(del);

      gutter.appendChild(th);
    }
  }

  /** Hidden file input reused for loading audio into a role. */
  const audioInput = document.createElement('input');
  audioInput.type = 'file';
  audioInput.accept = 'audio/mpeg,audio/mp3,.mp3,audio/wav,.wav,audio/ogg,.ogg';
  audioInput.style.display = 'none';
  let pendingRole: import('../../types').AudioRole | null = null;
  audioInput.addEventListener('change', async () => {
    const f = audioInput.files?.[0];
    if (!f || !pendingRole) return;
    try {
      await loadAudioIntoRole(pendingRole, f);
    } catch {
      /* decode error — ignore */
    }
    audioInput.value = '';
    pendingRole = null;
  });
  scroll.parentElement?.appendChild(audioInput);

  function openAudioPicker(track: AudioTrack): void {
    pendingRole = track.role;
    audioInput.click();
  }

  /**
   * Run the vocal separation pipeline and load the two stems into their roles:
   * lead vocal → 'lead', instrumental → 'minus'.
   */
  async function runSeparation(): Promise<void> {
    const original = getAudioBytesMap().get('original');
    if (!original) {
      toast('Сначала загрузите оригинал', 'err');
      return;
    }
    // Explain why the action can't run instead of failing silently mid-way.
    const status = getSeparationStatus();
    if (!status.available) {
      toast('Извлечение недоступно: ' + status.reason, 'err');
      return;
    }
    const dialog = openSeparationDialog();
    try {
      const { lead, instrumental } = await separateVocals(original, {
        onDownload: (loaded, total) => dialog.setDownload(total > 0 ? loaded / total : null),
        onStatus: (msg) => dialog.setStatus(msg),
        onProgress: (frac) => dialog.setProgress(frac),
      });
      // Derive sensible filenames from the original's name.
      const origName =
        getAudioTrackByRole(store.getProject(), 'original')?.audioFileName ?? 'original.mp3';
      const base = origName.replace(/\.[^.]+$/, '');
      await loadAudioBytesIntoRole('lead', lead, `${base} (вокал).wav`);
      await loadAudioBytesIntoRole('minus', instrumental, `${base} (минус).wav`);
      dialog.close();
      toast('Вокал и минус извлечены и загружены', 'ok');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dialog.error(msg);
      toast('Не удалось извлечь вокал: ' + msg, 'err');
    }
  }

  function fmtTime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  }

  function draw(): void {
    const project = store.getProject();
    const dpr = window.devicePixelRatio || 1;
    const tracks = project.tracks;
    // Height: ruler + one row per track.
    let cssH = RULER_H + TOP_PAD;
    for (const t of tracks) cssH += rowHeight(t) + TRACK_PAD;
    cssH += 4;
    // The canvas is viewport-wide; the spacer carries the full content width so
    // the scroll container can pan. canvas backing store scales only with the
    // viewport (× dpr), never with zoom — so it can't exceed the device limit.
    const vw = viewportWidth();
    const cw = contentWidth();
    wrap.style.width = `${cw}px`;
    if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${cssH}px`;
    }
    // Draw in CSS pixels (dpr baked into the transform), then shift everything
    // left by scrollLeft so the visible slice of content lands in the viewport.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, cssH);
    ctx.translate(-scroll.scrollLeft, 0);

    // Visible content window — used to cull ruler ticks / active band fills.
    const left = scroll.scrollLeft;
    const right = scroll.scrollLeft + vw;

    // Ruler ticks — iterate by ms (as before) but cull ticks off the visible
    // window. A small left margin keeps labels of ticks just entering view.
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const step = niceStepMs(durationMs(), cw);
    for (let ms = 0; ms <= durationMs(); ms += step) {
      const x = msToX(ms);
      if (x < left - 40 || x > right) continue;
      ctx.fillStyle = '#2a2e42';
      ctx.fillRect(x, 0, 1, RULER_H);
      ctx.fillStyle = '#9498b8';
      ctx.fillText(fmtTime(ms), x + 4, 6);
    }

    // One row per track — delegate drawing to its view.
    const env = makeEnv();
    const activeId = project.activeTrackId;
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      const view = VIEWS[track.type];
      if (!view) continue;
      const rowY = trackTopForIndex(ti, tracks);
      // Active track subtle highlight band (only the visible slice).
      if (track.id === activeId) {
        ctx.fillStyle = 'rgba(255,225,77,0.06)';
        ctx.fillRect(Math.max(0, left), rowY - 2, Math.min(cw, right) - Math.max(0, left), rowHeight(track) + 4);
      }
      view.draw(ctx, track, rowY, env);
    }

    // Playhead (red bar sweeping across the timeline).
    const px = msToX(playheadMs);
    ctx.fillStyle = '#ff5c6c';
    ctx.fillRect(px, 0, 2, cssH);

    // While recording, show the next syllable to be stamped beside the playhead.
    if (recording) {
      const activeIdx = tracks.findIndex((t) => t.id === activeId);
      const activeTrack = activeIdx >= 0 ? tracks[activeIdx] : null;
      if (activeTrack && activeTrack.type === 'text') {
        const flat = flatSyllables(activeTrack.lines);
        const next = flat[recordCursor];
        if (next && next.syl.startMs === null) {
          drawRecordPill(ctx, px, next.syl.text);
        }
      }
    }
  }

  function drawRecordPill(ctx: Ctx, px: number, raw: string): void {
    const label = (raw.trim() || '•').slice(0, 14);
    ctx.font = 'bold 12px system-ui';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const labelX = px + 6;
    const padX = 5;
    const tw = ctx.measureText(label).width;
    const pillY = RULER_H + 4;
    const pillH = 18;
    ctx.fillStyle = 'rgba(255,92,108,0.18)';
    roundRect(ctx, labelX - padX, pillY, tw + padX * 2, pillH, 4);
    ctx.fill();
    ctx.strokeStyle = '#ff5c6c';
    ctx.lineWidth = 1;
    roundRect(ctx, labelX - padX, pillY, tw + padX * 2, pillH, 4);
    ctx.stroke();
    ctx.fillStyle = '#ffd0d6';
    ctx.fillText(label, labelX, pillY + pillH / 2 + 1);
  }

  function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function niceStepMs(durMs: number, widthPx: number): number {
    const targetPx = 80;
    const msPerPx = durMs / widthPx;
    const targetMs = targetPx * msPerPx;
    const candidates = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000];
    for (const c of candidates) if (c >= targetMs) return c;
    return 60000;
  }

  renderGutter();
  requestAnimationFrame(draw);

  return { root };
}
