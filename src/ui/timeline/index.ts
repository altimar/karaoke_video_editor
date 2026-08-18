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
import { flatSyllables, removeSyllableAt } from '../../lib/textParser';
import { Project, Track, AudioTrack, AudioRole, TextTrack, AUDIO_ROLE_NAMES, createTextTrack, getAudioTrackByRole } from '../../types';
import {
  loadAudioIntoRole,
  loadAudioBytesIntoRole,
  clearAudioRole,
  getAudioBytesMap,
} from '../../lib/audioLoader';
import { separateFull, getSeparationStatus } from '../../lib/separation';
import { autoAlignTimings, getAlignmentStatus } from '../../lib/forcedAlign';
import { openVocalBindDialog } from '../vocalBindDialog';
import { clearBgVideo, getBgVideoBytes } from '../../lib/backgroundVideo';
import { ensureBgFilmstrip, setFilmstripOnReady } from '../../lib/bgThumbnails';
import { invalidateBgImageCache } from '../../lib/render';
import { openSeparationDialog } from '../separationDialog';
import type { ToastFn } from '../controls';
import { applyBgFile } from '../bgFile';
import {
  RULER_H, TOP_PAD, TRACK_PAD, BG_ROW_H, rowHeight, trackTopForIndex, trackIndexAtY, bgRowTop, isBgRowAtY,
} from './coords';
import { AudioTool, Ctx, SyllableSelection, TimelineEnv, TrackDrag, TrackView } from './types';
import { textView, pickMarker } from './textView';
import { audioView } from './audioView';

/** Registry of track views by `type`. A new track kind adds one entry here. */
const VIEWS: Record<string, TrackView> = {
  text: textView as TrackView,
  audio: audioView as TrackView,
};

/** Hooks for the app shell: the Фон pseudo-row behaves like a selectable
 * "track" whose settings are the shared background card in the style panel. */
export interface TimelineOptions {
  /** The Фон header was clicked — show the background settings panel. */
  onBackgroundSelected?: () => void;
  /** Any real track header was clicked — bring the track panel back. */
  onTrackSelected?: () => void;
}

export function createTimeline(
  toast: ToastFn,
  opts: TimelineOptions = {},
): { root: HTMLElement; runAutoAlign: (trackId: string) => Promise<void> } {
  const root = document.createElement('div');
  root.className = 'timeline';

  const head = document.createElement('div');
  head.className = 'timeline-head';
  const headTitle = document.createElement('span');
  headTitle.textContent = 'Таймлайн';
  head.appendChild(headTitle);
  const headHint = document.createElement('span');
  headHint.className = 'hint';
  headHint.textContent = '— клик = перемотка, маркеры тянутся; клик по слогу + Del — удалить слог';
  head.appendChild(headHint);

  // Audio-row tool switch: volume automation vs phrase editing (drag chunks
  // between audio tracks). Automation is the default (historical behavior).
  const toolControls = document.createElement('div');
  toolControls.className = 'tl-tools';
  const makeToolBtn = (tool: AudioTool, label: string, title: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.className = 'tl-tool-btn';
    btn.title = title;
    btn.dataset.testid = `tl-tool-${tool}`;
    const icon = document.createElement('span');
    icon.className = 'tl-tool-icon';
    icon.textContent = tool === 'automation' ? '📈' : '✂️';
    const text = document.createElement('span');
    text.className = 'tl-tool-label';
    text.textContent = label;
    btn.appendChild(icon);
    btn.appendChild(text);
    btn.addEventListener('click', () => setTool(tool));
    return btn;
  };
  const automationBtn = makeToolBtn(
    'automation',
    'Автоматизация',
    'Инструмент «Автоматизация»: огибающая громкости — клик добавляет точку, перетаскивание двигает, двойной клик удаляет',
  );
  const editBtn = makeToolBtn(
    'edit',
    'Редактирование',
    'Инструмент «Редактирование»: перетаскивайте фрагменты звука между аудиодорожками (фраза из бэка — в вокал и т.п.)',
  );
  toolControls.appendChild(automationBtn);
  toolControls.appendChild(editBtn);
  head.appendChild(toolControls);

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
  // Active audio-row tool (see the header switch) + pointer tracking for the
  // edit tool's hover/drop effects.
  let tool: AudioTool = 'automation';
  let pointer: { x: number; y: number } | null = null;
  let dropTargetTrackId: string | null = null;
  // The syllable marker selected by the last click (highlighted; Del removes).
  let selection: SyllableSelection | null = null;

  /** selection, or null if its syllable no longer exists (self-healing —
   *  text edits invalidate line/syllable indices). */
  function liveSelection(): SyllableSelection | null {
    if (!selection) return null;
    const t = store.getProject().tracks.find((x) => x.id === selection!.trackId);
    if (!t || t.type !== 'text' || !t.lines[selection.lineIndex]?.syllables[selection.sylIndex]) {
      selection = null;
    }
    return selection;
  }

  // Del/Backspace deletes the selected syllable (together with its timing —
  // the OTHER timings are not re-flowed, unlike editing the lyrics text).
  // Esc just deselects. Ignored while typing in an input/textarea.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== 'Escape') return;
    const sel = liveSelection();
    if (!sel) return;
    const el = document.activeElement;
    const editable =
      el instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
    if (editable) return;
    if (e.key === 'Escape') {
      selection = null;
      scheduleDraw();
      return;
    }
    e.preventDefault();
    store.mutate((p) => {
      const t = p.tracks.find((x) => x.id === sel.trackId);
      if (t && t.type === 'text') {
        t.lines = removeSyllableAt(t.lines, sel.lineIndex, sel.sylIndex);
      }
    });
    selection = null;
    scheduleDraw();
  });

  function setTool(t: AudioTool): void {
    if (tool === t) return;
    tool = t;
    automationBtn.classList.toggle('active', tool === 'automation');
    editBtn.classList.toggle('active', tool === 'edit');
    scheduleDraw();
  }
  automationBtn.classList.add('active');

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
    pointer = { x, y };
    // Any click re-targets the selection: it's set again right below when the
    // click claims a syllable marker.
    selection = null;
    const project = store.getProject();
    const model = project.tracks;
    const disp = displayTracks(project);
    const modelIdx = new Map(disp.map((t) => [t.id, model.findIndex((m) => m.id === t.id)]));
    const env = makeEnv();

    // 1. Try each row's view to claim the pointer (object hit). Rows iterate
    // in DISPLAY order; drags carry MODEL indexes (views resolve them).
    for (let di = 0; di < disp.length; di++) {
      const track = disp[di];
      const view = VIEWS[track.type];
      if (!view) continue;
      const rowY = trackTopForIndex(di, disp, project.activeTrackId);
      // Text rows use a dedicated marker scan (needs the live track); other
      // kinds use the generic hitTest.
      const hit =
        track.type === 'text'
          ? pickMarker(modelIdx.get(track.id) ?? -1, track, rowY, x, y, env)
          : view.hitTest(track, rowY, x, y, env);
      if (hit) {
        drag = hit;
        // Clicking a marker selects it (Del-ready); any other claim deselects.
        if (hit.kind === 'syllable') {
          selection = { trackId: track.id, lineIndex: hit.lineIndex, sylIndex: hit.sylIndex };
        }
        canvas.setPointerCapture(e.pointerId);
        // A drop-capable drag starts hovering over its own row.
        if (view.onDrop) dropTargetTrackId = track.id;
        return;
      }
    }

    // 2. Background click within a row (e.g. add a volume point). A view may
    // decline (edit tool) — then fall through to the seek fallback.
    const ti = trackIndexAtY(y, disp, project.activeTrackId);
    if (ti >= 0) {
      const track = disp[ti];
      const view = VIEWS[track.type];
      if (view?.onBackgroundClick) {
        const rowY = trackTopForIndex(ti, disp, project.activeTrackId);
        const handled = view.onBackgroundClick(track, rowY, x, y, env);
        if (handled !== false) return;
      }
    }

    // 2.5 The background pseudo-row (below all tracks) opens the bg picker.
    if (isBgRowAtY(y, disp, project.activeTrackId)) {
      openBgPicker();
      return;
    }

    // 2.6 A click inside a COLLAPSED audio row does nothing (no seek, no edit)
    // — activate the track via its header first.
    if (ti >= 0 && disp[ti].type === 'audio' && disp[ti].id !== project.activeTrackId) return;

    // 3. Fallback: seek.
    audioEngine.seek(xToMs(x));
  });

  // Double-click → delete a claimed object (e.g. a volume point).
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = pointerContentX(e.clientX);
    const y = e.clientY - rect.top;
    const project = store.getProject();
    const model = project.tracks;
    const disp = displayTracks(project);
    const modelIdx = new Map(disp.map((t) => [t.id, model.findIndex((m) => m.id === t.id)]));
    const env = makeEnv();
    for (let di = 0; di < disp.length; di++) {
      const track = disp[di];
      const view = VIEWS[track.type];
      if (!view?.onDoubleTap) continue;
      const rowY = trackTopForIndex(di, disp, project.activeTrackId);
      const hit =
        track.type === 'text'
          ? pickMarker(modelIdx.get(track.id) ?? -1, track, rowY, x, y, env)
          : view.hitTest(track, rowY, x, y, env);
      if (hit) {
        view.onDoubleTap(hit);
        return;
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = pointerContentX(e.clientX);
    const y = e.clientY - rect.top;
    pointer = { x, y };
    if (drag && !isPinching) {
      const project = store.getProject();
      const track = project.tracks[drag.trackIndex];
      const view = VIEWS[track?.type ?? ''];
      if (view && track) {
        // A drop-capable drag (e.g. a chunk) tracks the row under the pointer
        // so views can draw the drop indicator there.
        if (view.onDrop) {
          const disp = displayTracks(project);
          const di = trackIndexAtY(y, disp, project.activeTrackId);
          dropTargetTrackId = di >= 0 ? disp[di].id : null;
        }
        const rowY = displayRowTop(track.id);
        view.onDrag(drag, rowY, x, y, makeEnv());
      }
    }
    // Hover effects (chunk under the cursor) need a repaint too; rAF-throttled.
    scheduleDraw();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (drag) {
      const project = store.getProject();
      const track = project.tracks[drag.trackIndex];
      const view = VIEWS[track?.type ?? ''];
      if (view?.onDrop && track) {
        const rect = canvas.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const disp = displayTracks(project);
        const di = trackIndexAtY(y, disp, project.activeTrackId);
        const target = di >= 0 ? disp[di] : null;
        view.onDrop(drag, target, makeEnv());
      }
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      drag = null;
      dropTargetTrackId = null;
      scheduleDraw();
    }
  });

  // Off-canvas pointer: drop hover effects (a captured drag keeps its events).
  canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    pointer = null;
    scheduleDraw();
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
  // Filmstrip decode is async — redraw the bg row once the thumbs are ready.
  setFilmstripOnReady(() => scheduleDraw());
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

  /**
   * Rows in DISPLAY order: a text track bound to a vocal role renders
   * directly ABOVE that vocal's audio track (the pair reads as one unit).
   * Unbound text tracks keep the top area in their original order.
   */
  function displayTracks(project: Project): Track[] {
    const model = project.tracks;
    const placed = new Set<Track>();
    const out: Track[] = [];
    for (const t of model) {
      if (t.type === 'text' && !t.boundVocalRole) {
        out.push(t);
        placed.add(t);
      }
    }
    for (const t of model) {
      if (t.type !== 'audio') continue;
      for (const txt of model) {
        if (txt.type === 'text' && !placed.has(txt) && txt.boundVocalRole === t.role) {
          out.push(txt);
          placed.add(txt);
        }
      }
      out.push(t);
      placed.add(t);
    }
    for (const t of model) if (!placed.has(t)) out.push(t);
    return out;
  }

  /** Display-space row top of a track by id (drags carry MODEL indexes). */
  function displayRowTop(trackId: string): number {
    const p = store.getProject();
    const disp = displayTracks(p);
    const di = disp.findIndex((t) => t.id === trackId);
    return di >= 0 ? trackTopForIndex(di, disp, p.activeTrackId) : 0;
  }

  /** Build the shared env for the current frame. */
  function makeEnv(): TimelineEnv {
    return {
      msToX,
      xToMs,
      durationMs,
      width: contentWidth(),
      scrollLeft: scroll.scrollLeft,
      viewportWidth: scroll.clientWidth,
      activeTrackId: store.getProject().activeTrackId,
      tool,
      pointer,
      dropTargetTrackId,
      drag,
      selection: liveSelection(),
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
      '@' + project.activeTrackId +
      '@bg:' + project.background.bgType + ':' + (project.background.bgVideoFileName ?? '') + ':' + (project.background.bgImageDataUrl ? '1' : '') +
      '@bind:' + project.tracks.filter((t) => t.type === 'text').map((t) => `${t.id}=${(t as TextTrack).boundVocalRole ?? ''}`).join(',');
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

    for (const track of displayTracks(project)) {
      const th = document.createElement('div');
      // A text track bound to a vocal renders as ONE frame with its vocal
      // card (pair-top / pair-bottom): no border, no rounding and no canvas
      // separator at the junction — the pairing is visible without a badge.
      const pairTop =
        track.type === 'text' && (track as TextTrack).boundVocalRole !== null;
      const pairBottom =
        track.type === 'audio' &&
        project.tracks.some(
          (t) => t.type === 'text' && t.boundVocalRole === (track as AudioTrack).role,
        );
      th.className =
        'timeline-track-head' +
        (track.id === project.activeTrackId ? ' active' : '') +
        (track.type === 'audio' ? ' audio' : '') +
        (pairTop ? ' pair-top' : '') +
        (pairBottom ? ' pair-bottom' : '');
      // Card spans [previous row's separator, own row's separator] — i.e. the
      // row plus the gap ABOVE it — so cards stack contiguously with no air
      // between them and every card border lands on a canvas line. The card's
      // BOTTOM border coincides with the row's separator (bottom = row
      // bottom); the label/buttons center in the WHOLE card (align-items:
      // center, no extra padding).
      th.style.height = rowHeight(track, project.activeTrackId) + TRACK_PAD + 'px';
      th.title = 'Сделать эту дорожку активной';
      // Stable selector anchors for E2E: role for audio tracks, id for text.
      th.dataset.testid = track.type === 'audio' ? `track-head-${track.role}` : 'track-head-text';
      th.dataset.trackId = track.id;

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
        // Let inner buttons (extract / align / mute / solo / delete) handle their own clicks.
        if ((e.target as HTMLElement).closest('.timeline-track-del')) return;
        if ((e.target as HTMLElement).closest('.timeline-track-extract')) return;
        if ((e.target as HTMLElement).closest('.timeline-track-align')) return;
        if ((e.target as HTMLElement).closest('.timeline-track-ms')) return;
        store.mutate((p) => (p.activeTrackId = track.id));
        // Even when the active track doesn't change (same id), the panel must
        // leave background mode — the user explicitly picked a track.
        gutter.querySelector('.timeline-track-head.bg')?.classList.remove('active');
        opts.onTrackSelected?.();
        if (track.type === 'audio' && !track.audioFileName) {
          openAudioPicker(track);
        }
      });

      // Auto-timing button (text tracks): CTC forced alignment of the lyrics
      // against the vocal audio. Uses the separated lead, else the original,
      // else the backing-vocal stem. Resets the track's existing timings.
      if (track.type === 'text') {
        const alignBtn = document.createElement('span');
        alignBtn.className = 'timeline-track-align';
        alignBtn.textContent = '⏱';
        alignBtn.title = 'Авторасстановка таймингов по вокалу';
        alignBtn.dataset.testid = 'btn-auto-align';
        alignBtn.dataset.trackId = track.id;
        alignBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void runAutoAlign(track.id);
        });
        th.appendChild(alignBtn);
      }

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

    // Background pseudo-row header: click loads an image or an mp4; × resets
    // to the color background (color/gradient themselves live in the style panel).
    const bg = project.background;
    const bgHead = document.createElement('div');
    bgHead.className = 'timeline-track-head bg';
    bgHead.style.height = BG_ROW_H + TRACK_PAD + 'px';
    bgHead.title = 'Загрузить фон: картинку или MP4-видео';
    bgHead.dataset.testid = 'track-head-background';
    const bgName = document.createElement('span');
    bgName.className = 'timeline-track-name';
    bgName.textContent = '🖼 Фон';
    bgHead.appendChild(bgName);
    if (bg.bgType === 'image' || bg.bgType === 'video') {
      const bgDel = document.createElement('span');
      bgDel.className = 'timeline-track-del';
      bgDel.textContent = '×';
      bgDel.title = 'Сбросить фон до цвета';
      bgDel.addEventListener('click', (e) => {
        e.stopPropagation();
        if (bg.bgType === 'video') clearBgVideo();
        store.mutate((p) => {
          p.background.bgType = 'color';
          p.background.bgImageDataUrl = null;
          p.background.bgVideoFileName = null;
        });
        invalidateBgImageCache();
      });
      bgHead.appendChild(bgDel);
    }
    // Header click SELECTS the Фон pseudo-row: its "track settings" are the
    // shared background card in the style panel. Quick-load stays on the
    // canvas row (click there opens the file picker directly).
    bgHead.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.timeline-track-del')) return;
      bgHead.classList.add('active');
      opts.onBackgroundSelected?.();
    });
    gutter.appendChild(bgHead);
  }

  /** Hidden file input reused for loading audio into a role. */
  const audioInput = document.createElement('input');
  audioInput.type = 'file';
  audioInput.accept = 'audio/mpeg,audio/mp3,.mp3,audio/wav,.wav,audio/ogg,.ogg';
  audioInput.style.display = 'none';
  audioInput.dataset.testid = 'input-audio-load';
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

  // --- Background pseudo-row: hidden file input (image or mp4 video) ---
  // Quick-load path (canvas-row click). The settings card in the style panel
  // has its own input — both share applyBgFile.
  const bgInput = document.createElement('input');
  bgInput.type = 'file';
  bgInput.accept = 'image/*,video/mp4,.mp4';
  bgInput.style.display = 'none';
  bgInput.dataset.testid = 'input-bg-load';
  bgInput.addEventListener('change', async () => {
    const f = bgInput.files?.[0];
    if (!f) return;
    await applyBgFile(f, toast);
    bgInput.value = '';
  });
  scroll.parentElement?.appendChild(bgInput);

  function openBgPicker(): void {
    bgInput.click();
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
    const dialog = openSeparationDialog('Извлечение вокала, минуса и бэка');
    try {
      const { lead, back, instrumental } = await separateFull(original, {
        onDownload: (loaded, total) => dialog.setDownload(total > 0 ? loaded / total : null),
        onStatus: (msg) => dialog.setStatus(msg),
        onProgress: (frac) => dialog.setProgress(frac),
      });
      // Derive sensible filenames from the original's name.
      const origName =
        getAudioTrackByRole(store.getProject(), 'original')?.audioFileName ?? 'original.mp3';
      const base = origName.replace(/\.[^.]+$/, '');
      await loadAudioBytesIntoRole('lead', lead, `${base} (лид).wav`);
      await loadAudioBytesIntoRole('back', back, `${base} (бэк).wav`);
      await loadAudioBytesIntoRole('minus', instrumental, `${base} (минус).wav`);
      dialog.close();
      toast('Вокал, бэк и минус извлечены и загружены', 'ok');
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

  /**
   * Run CTC forced alignment for a text track's lyrics against the vocal
   * audio (lead stem, else original, else back-vocal stem) and OVERWRITE the
   * track's syllable timings with the result.
   */
  async function runAutoAlign(trackId: string): Promise<void> {
    const proj = store.getProject();
    const track = proj.tracks.find((t) => t.id === trackId);
    if (!track || track.type !== 'text') return;

    const status = getAlignmentStatus();
    if (!status.available) {
      toast('Авторасстановка недоступна: ' + status.reason, 'err');
      return;
    }

    // The lyrics are aligned against the track's BOUND vocal. Unbound → the
    // picker dialog binds one (and enforces one-text-track-per-vocal).
    let role: AudioRole | null = track.boundVocalRole;
    if (!role) {
      const dialog = openVocalBindDialog(store.getProject(), track);
      const chosen = await dialog.promise;
      if (!chosen) return;
      role = chosen;
      store.mutate((p) => {
        const t = p.tracks.find((x) => x.id === trackId);
        if (t && t.type === 'text') t.boundVocalRole = role;
      });
      toast(`Дорожка «${track.name}» привязана к «${AUDIO_ROLE_NAMES[role]}»`, 'ok');
    }

    const buffer = audioEngine.getBuffer(role);
    if (!buffer) {
      toast(`Вокальная дорожка «${AUDIO_ROLE_NAMES[role]}» пуста — загрузите или извлеките вокал`, 'err');
      return;
    }

    const dialog = openSeparationDialog('Авторасстановка таймингов');
    try {
      const starts = await autoAlignTimings(buffer, track.lines, {
        onDownload: (loaded, total) => dialog.setDownload(total > 0 ? loaded / total : null),
        onStatus: (msg) => dialog.setStatus(msg),
        onProgress: (frac) => dialog.setProgress(frac),
      });
      store.mutate((p) => {
        const t = p.tracks.find((x) => x.id === trackId);
        if (!t || t.type !== 'text') return;
        let i = 0;
        for (const line of t.lines) {
          for (const syl of line.syllables) syl.startMs = starts[i++] ?? null;
        }
      });
      dialog.close();
      toast(`Готово: расставлено ${starts.length} слогов`, 'ok');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dialog.error(msg);
      toast('Авторасстановка не удалась: ' + msg, 'err');
    }
  }

  function draw(): void {
    const project = store.getProject();
    const dpr = window.devicePixelRatio || 1;
    const tracks = displayTracks(project);
    // Height: ruler + one row per track + the background pseudo-row. Ends
    // EXACTLY at the bg row bottom — no trailing pad: the canvas must not
    // extend past the last row (visible dead space under «Фон»).
    let cssH = RULER_H + TOP_PAD;
    for (const t of tracks) cssH += rowHeight(t, project.activeTrackId) + TRACK_PAD;
    cssH += BG_ROW_H;
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
      const rowY = trackTopForIndex(ti, tracks, activeId);
      // Active track subtle highlight band (only the visible slice).
      if (track.id === activeId) {
        ctx.fillStyle = 'rgba(255,225,77,0.06)';
        ctx.fillRect(Math.max(0, left), rowY - 2, Math.min(cw, right) - Math.max(0, left), rowHeight(track, activeId) + 4);
      }
      view.draw(ctx, track, rowY, env);
    }

    // Background pseudo-row: filmstrip for a video bg, status text otherwise.
    const bgY = bgRowTop(tracks, activeId);
    const bg = project.background;
    ctx.fillStyle = '#2a2e42';
    const bgSepX = Math.max(0, Math.floor(left));
    const bgSepW = Math.min(cw, right) - bgSepX;
    ctx.fillRect(bgSepX, bgY + BG_ROW_H - 1, Math.max(0, bgSepW), 1);

    let drewFilmstrip = false;
    if (bg.bgType === 'video') {
      const bytes = getBgVideoBytes();
      if (bytes) {
        const strip = ensureBgFilmstrip(bytes);
        if (strip && strip.thumbs.length > 0) {
          drewFilmstrip = true;
          const { thumbs } = strip;
          // Thumbnails keep their NATIVE aspect (height = row, width from the
          // frame's ratio) and are left-anchored at their timestamp. When the
          // zoom level makes them wider than the sampling interval, a fixed
          // INDEX STRIDE is used — NOT a viewport-relative skip — so the drawn
          // subset stays identical while scrolling (a viewport-relative skip
          // made thumbnails visually "jump" as the scroll position decided
          // which of the overlapping frames to drop).
          const GAP = 4; // min px between neighboring thumbnails
          const pxPerSec = contentWidth() / durationMs() * 1000;
          const spacing = strip.intervalSec * pxPerSec; // px between samples
          let maxW = 1;
          for (const th of thumbs) maxW = Math.max(maxW, Math.round((th.canvas.width / th.canvas.height) * BG_ROW_H));
          const stride = Math.max(1, Math.ceil((maxW + GAP) / spacing));
          for (let i = 0; i < thumbs.length; i += stride) {
            const c = thumbs[i].canvas;
            const tw = Math.max(1, Math.round((c.width / c.height) * BG_ROW_H));
            const x = msToX(thumbs[i].tSec * 1000);
            if (x + tw < left || x > right) continue; // cull off-screen only
            ctx.drawImage(c, x, bgY, tw, BG_ROW_H);
          }
          // Where the video ends earlier than the song, show the fallback
          // color zone (the bg color visible in preview/export after the end).
          const endX = msToX(Math.min(strip.durationSec * 1000, durationMs()));
          if (endX < right) {
            ctx.fillStyle = bg.bgColor;
            ctx.fillRect(Math.max(endX, left), bgY, right - Math.max(endX, left), BG_ROW_H);
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.fillRect(endX, bgY, 1, BG_ROW_H);
            ctx.fillStyle = '#5a5f7e';
            ctx.font = '10px system-ui';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            if (right - Math.max(endX, left) > 70) ctx.fillText('цвет фона', Math.max(endX, left) + 6, bgY + BG_ROW_H / 2);
          }
        }
      }
    }
    if (!drewFilmstrip) {
      ctx.fillStyle = '#5a5f7e';
      ctx.font = '11px system-ui';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const bgLabel =
        bg.bgType === 'video'
          ? `фон: видео (${bg.bgVideoFileName ?? 'bg.mp4'})${getBgVideoBytes() ? ' — кадры готовятся…' : ''}`
          : bg.bgType === 'image'
            ? 'фон: картинка'
            : bg.bgType === 'gradient'
              ? 'фон: градиент'
              : 'фон: цвет';
      ctx.fillText(
        bg.bgType === 'video' || bg.bgType === 'image' ? bgLabel + ' — клик сменить' : 'фон — клик: картинка или MP4',
        env.width / 2,
        bgY + BG_ROW_H / 2,
      );
      ctx.textAlign = 'left';
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

  return { root, runAutoAlign };
}
