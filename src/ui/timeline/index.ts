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
import { computePeaks } from '../../lib/waveform';
import { flatSyllables } from '../../lib/textParser';
import { Project, createTextTrack } from '../../types';
import { RULER_H, TOP_PAD, TRACK_PAD, rowHeight, trackTopForIndex, trackIndexAtY } from './coords';
import { Ctx, TimelineEnv, TrackDrag, TrackView } from './types';
import { textView, pickMarker } from './textView';
import { audioView } from './audioView';

/** Registry of track views by `type`. A new track kind adds one entry here. */
const VIEWS: Record<string, TrackView> = {
  text: textView as TrackView,
  audio: audioView as TrackView,
};

export function createTimeline(): { root: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'timeline';

  const head = document.createElement('div');
  head.className = 'timeline-head';
  head.innerHTML =
    '<span>Таймлайн</span><span class="hint">— клик = перемотка, перетаскивайте маркеры, Shift+колесо = зум</span>';
  root.appendChild(head);

  // Body: fixed gutter (left) + scrollable canvas (right).
  const body = document.createElement('div');
  body.className = 'timeline-body';

  const gutter = document.createElement('div');
  gutter.className = 'timeline-gutter';
  body.appendChild(gutter);

  const scroll = document.createElement('div');
  scroll.className = 'timeline-scroll';
  const canvas = document.createElement('canvas');
  canvas.className = 'timeline-canvas';
  const ctx = canvas.getContext('2d')!;
  scroll.appendChild(canvas);
  body.appendChild(scroll);

  root.appendChild(body);

  let zoom = 1; // multiplied onto the base width
  let playheadMs = 0;
  // Recording state: whether we're capturing timings, and the flat index of the
  // syllable that the next Space will stamp. Used to preview it beside the playhead.
  let recording = false;
  let recordCursor = 0;

  const baseWidth = () => Math.max(800, scroll.clientWidth - 4);
  const contentWidth = () => baseWidth() * zoom;

  function durationMs(p?: Project): number {
    const proj = p ?? store.getProject();
    return Math.max(proj.durationMs, 1);
  }

  const msToX = (ms: number) => (ms / durationMs()) * contentWidth();
  const xToMs = (x: number) => (x / contentWidth()) * durationMs();

  // The active drag (claimed by some track view's hitTest), carried across moves.
  let drag: TrackDrag | null = null;

  // --- Pointer dispatch ---
  // Single pipeline: for each row, ask its view to hitTest; the first claim
  // wins and owns the drag. Otherwise, a background-click handler may act; the
  // fallback is a seek.
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
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
    const x = e.clientX - rect.left;
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
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
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
      const rect = canvas.getBoundingClientRect();
      const anchorX = e.clientX - rect.left;
      const anchorMs = xToMs(anchorX);
      zoom = Math.max(1, Math.min(40, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const newAnchorX = msToX(anchorMs);
      scroll.scrollLeft += newAnchorX - anchorX;
      draw();
    },
    { passive: false },
  );

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

  /** Build the shared env for the current frame (coords + peaks). */
  function makeEnv(): TimelineEnv {
    const cssW = contentWidth();
    const peaks = audioEngine.audioBuffer
      ? computePeaks(audioEngine.audioBuffer, Math.max(1, Math.ceil(cssW))).peaks
      : null;
    return { msToX, xToMs, durationMs, width: cssW, peaks };
  }

  // --- Gutter (left headers) ---
  // Rebuilt only when the set of tracks, their types/names or the active id
  // changes — NOT on every frame. Each header's height matches its canvas row.
  let lastGutterSig = '';
  function renderGutter(): void {
    const project = store.getProject();
    const sig =
      project.tracks.map((t) => `${t.id}:${t.type}:${t.name}`).join('|') + '@' + project.activeTrackId;
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
      name.textContent = (track.type === 'audio' ? '🎵 ' : '🎤 ') + track.name;
      th.appendChild(name);
      th.addEventListener('click', () => {
        if (track.id === store.getProject().activeTrackId) return;
        store.mutate((p) => (p.activeTrackId = track.id));
      });
      gutter.appendChild(th);
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
    const cssW = contentWidth();
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Ruler ticks
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const step = niceStepMs(durationMs(), cssW);
    for (let ms = 0; ms <= durationMs(); ms += step) {
      const x = msToX(ms);
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
      // Active track subtle highlight band.
      if (track.id === activeId) {
        ctx.fillStyle = 'rgba(255,225,77,0.06)';
        ctx.fillRect(0, rowY - 2, cssW, rowHeight(track) + 4);
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
