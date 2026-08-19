/**
 * Timeline orchestrator.
 *
 * Owns only what is SHARED across every track kind: the canvas/DOM lifecycle,
 * the time ruler, the playhead, zoom, the unified pointer-event dispatch and
 * the tool switch. Track-type-specific drawing/interaction is delegated to a
 * `TrackView` (textView / audioView) looked up by `track.type`; track headers
 * live in gutter.ts; app-level flows (file pickers, separation, alignment)
 * live in actions.ts. Adding a new track kind = add a view module + register
 * it here.
 *
 * Layout: a fixed LEFT GUTTER of track headers + a horizontally-scrollable
 * canvas on the right. Time is measured from the canvas left edge (x=0).
 */
import { store } from '../../state/store';
import { audioEngine } from '../../lib/audioEngine';
import { timingCapture } from '../../lib/timing';
import {
  flatSyllables, removeTimingsAndShift, clampBetweenNeighbors, rangeShiftBounds,
} from '../../lib/textParser';
import { Project, Track } from '../../types';
import { setFilmstripOnReady } from '../../lib/bgThumbnails';
import { setScrubTime } from '../../lib/scrub';
import { focusSyllable } from '../../lib/syllableFocus';
import type { ToastFn } from '../controls';
import { trackTopForIndex, trackIndexAtY, isBgRowAtY } from './coords';
import { AudioTool, SyllableSelection, TimelineEnv, TrackDrag, TrackView, selectionBounds } from './types';
import { textView, pickMarker } from './textView';
import { audioView } from './audioView';
import { createGutterRenderer } from './gutter';
import { createTimelineActions } from './actions';
import { createPainter } from './painter';

/** Registry of track views by `type`. A new track kind adds one entry here. */
const VIEWS: Record<string, TrackView> = {
  text: textView as TrackView,
  audio: audioView as TrackView,
};

/** Hooks for the app shell: the Фон pseudo-row behaves like a selectable
 *  "track" whose settings are the shared background card in the style panel. */
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
  headHint.textContent = '— клик = перемотка, маркеры тянутся; клик по слогу + Del — снять тайминг';
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
  // 100% == the whole song fits the viewport exactly, so "fit" is the label
  // itself (clickable) plus an explicit ⤢ button.
  const zoomControls = document.createElement('div');
  zoomControls.className = 'tl-zoom-controls';
  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'tl-zoom-btn';
  zoomOutBtn.textContent = '➖';
  zoomOutBtn.title = 'Уменьшить';
  const zoomLabel = document.createElement('button');
  zoomLabel.className = 'tl-zoom-label';
  zoomLabel.textContent = '100%';
  zoomLabel.title = 'Показать всю песню (100%)';
  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'tl-zoom-btn';
  zoomInBtn.textContent = '➕';
  zoomInBtn.title = 'Увеличить';
  const zoomFitBtn = document.createElement('button');
  zoomFitBtn.className = 'tl-zoom-btn';
  zoomFitBtn.textContent = '⤢';
  zoomFitBtn.title = 'Показать всю песню';
  zoomFitBtn.dataset.testid = 'tl-zoom-fit';
  zoomControls.appendChild(zoomOutBtn);
  zoomControls.appendChild(zoomLabel);
  zoomControls.appendChild(zoomInBtn);
  zoomControls.appendChild(zoomFitBtn);
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
  wrap.appendChild(canvas);
  scroll.appendChild(wrap);
  body.appendChild(scroll);

  root.appendChild(body);

  // App-level flows (pickers, ✨ separation, ⏱ alignment) + their hidden
  // file inputs, mounted hidden into the timeline root.
  const actions = createTimelineActions(toast);
  root.appendChild(actions.root);
  const renderGutter = createGutterRenderer(gutter, opts, actions);

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

  /** selection, or null if its syllables no longer exist (self-healing —
   *  text edits invalidate flat indices). */
  function liveSelection(): SyllableSelection | null {
    if (!selection) return null;
    const t = store.getProject().tracks.find((x) => x.id === selection!.trackId);
    if (!t || t.type !== 'text') {
      selection = null;
      return null;
    }
    const [a, b] = selectionBounds(selection);
    if (a < 0 || b >= flatSyllables(t.lines).length) {
      selection = null;
      return null;
    }
    return selection;
  }

  /** Keep a time visible in the timeline viewport (Tab navigation, nudges). */
  function ensureSyllableVisible(ms: number): void {
    const x = msToX(ms);
    const vw = scroll.clientWidth;
    if (x < scroll.scrollLeft + 60) scroll.scrollLeft = Math.max(0, x - 80);
    else if (x > scroll.scrollLeft + vw - 60) scroll.scrollLeft = x - vw + 80;
    painter.scheduleDraw();
  }

  // --- Keyboard editing of the selected syllable(s) ---
  // Arrows nudge (±50 ms, Shift = ±10 ms) — the whole range when one is
  // selected, honoring the between-neighbors invariant. Tab/Shift+Tab walk
  // the timed syllables. Del/Backspace removes the selected marker(s) and
  // shifts the following timings back (the TEXT is never touched); Esc just
  // deselects. Ignored while typing in an input/textarea.
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    const relevant =
      k === 'Delete' || k === 'Backspace' || k === 'Escape' ||
      k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Tab';
    if (!relevant) return;
    const sel = liveSelection();
    if (!sel) return;
    const el = document.activeElement;
    const editable =
      el instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
    if (editable) return;
    if (k === 'Escape') {
      selection = null;
      painter.scheduleDraw();
      return;
    }

    const track = store.getProject().tracks.find((x) => x.id === sel.trackId);
    if (!track || track.type !== 'text') return;
    const flat = flatSyllables(track.lines);
    const [b0, b1] = selectionBounds(sel);

    if (k === 'Tab') {
      e.preventDefault();
      // Walk to the next/previous TIMED syllable (markers are all timed).
      const dir = e.shiftKey ? -1 : 1;
      let next = sel.focusFlat + dir;
      while (next >= 0 && next < flat.length && flat[next].syl.startMs === null) next += dir;
      if (next >= 0 && next < flat.length) {
        selection = { trackId: sel.trackId, anchorFlat: next, focusFlat: next };
        const f = flat[next];
        const ms = f.syl.startMs ?? 0;
        ensureSyllableVisible(ms);
        setScrubTime(ms);
        focusSyllable({ trackId: sel.trackId, lineIndex: f.lineIndex, sylIndex: f.sylIndex });
      }
      return;
    }

    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 50) * (k === 'ArrowLeft' ? -1 : 1);
      if (b0 === b1) {
        const cur = flat[b0].syl.startMs ?? 0;
        const ms = clampBetweenNeighbors(flat, b0, cur + step, durationMs());
        store.mutate((p) => {
          const t = p.tracks.find((x) => x.id === sel.trackId);
          if (t && t.type === 'text') {
            const syl = flatSyllables(t.lines)[b0]?.syl;
            if (syl) syl.startMs = Math.round(ms);
          }
        });
        setScrubTime(ms);
      } else {
        const bounds = rangeShiftBounds(flat, b0, b1, durationMs());
        const delta = Math.round(Math.max(bounds.lo, Math.min(bounds.hi, step)));
        if (delta !== 0) {
          store.mutate((p) => {
            const t = p.tracks.find((x) => x.id === sel.trackId);
            if (!t || t.type !== 'text') return;
            const f = flatSyllables(t.lines);
            for (let i = b0; i <= b1; i++) {
              const syl = f[i]?.syl;
              if (syl && syl.startMs !== null) syl.startMs += delta;
            }
          });
          ensureSyllableVisible((flat[b0]?.syl.startMs ?? 0) + delta);
          setScrubTime((flat[b0]?.syl.startMs ?? 0) + delta);
        }
      }
      return;
    }

    // Delete / Backspace: remove the selected marker(s) and shift the tail's
    // timings back — the TEXT is untouched (this repairs an accidental extra
    // Space during recording; see removeTimingsAndShift). The selection stays
    // on the same syllable so repeated Del keeps pulling the tail back.
    e.preventDefault();
    store.mutate((p) => {
      const t = p.tracks.find((x) => x.id === sel.trackId);
      if (t && t.type === 'text') t.lines = removeTimingsAndShift(t.lines, b0, b1);
    });
    painter.scheduleDraw();
  });

  function setTool(t: AudioTool): void {
    if (tool === t) return;
    tool = t;
    automationBtn.classList.toggle('active', tool === 'automation');
    editBtn.classList.toggle('active', tool === 'edit');
    painter.scheduleDraw();
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
    painter.draw();
  }

  /** Zoom centered on the middle of the currently visible timeline span. */
  function zoomCentered(factor: number): void {
    const centerMs = xToMs(scroll.scrollLeft + scroll.clientWidth / 2);
    zoomAt(centerMs, factor);
  }
  zoomInBtn.addEventListener('click', () => zoomCentered(1.15));
  zoomOutBtn.addEventListener('click', () => zoomCentered(1 / 1.15));
  const fitZoom = (): void => zoomCentered(1 / zoom);
  zoomLabel.addEventListener('click', fitZoom);
  zoomFitBtn.addEventListener('click', fitZoom);

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
    // click claims a syllable marker (Shift+click extends the PREVIOUS one).
    const prevSelection: SyllableSelection | null = selection;
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
        // Clicking a marker selects it (arrows/Del ready); Shift+click extends
        // the selection to a RANGE (anchor kept); any other claim deselects.
        if (hit.kind === 'syllable' && track.type === 'text') {
          const flatIdx = flatSyllables(track.lines).findIndex(
            (f) => f.lineIndex === hit.lineIndex && f.sylIndex === hit.sylIndex,
          );
          if (flatIdx >= 0) {
            // Tell the lyrics editor to park its caret at this syllable.
            const f = flatSyllables(track.lines)[flatIdx];
            if (f) focusSyllable({ trackId: track.id, lineIndex: f.lineIndex, sylIndex: f.sylIndex });
            const inPrevRange =
              prevSelection !== null &&
              prevSelection.trackId === track.id &&
              flatIdx >= Math.min(prevSelection.anchorFlat, prevSelection.focusFlat) &&
              flatIdx <= Math.max(prevSelection.anchorFlat, prevSelection.focusFlat);
            if (e.shiftKey && prevSelection && prevSelection.trackId === track.id) {
              selection = { trackId: track.id, anchorFlat: prevSelection.anchorFlat, focusFlat: flatIdx };
            } else if (inPrevRange) {
              // Grabbing INSIDE a range keeps it (block drag); clicking outside
              // replaces the selection.
              selection = prevSelection;
            } else {
              selection = { trackId: track.id, anchorFlat: flatIdx, focusFlat: flatIdx };
            }
          }
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
      actions.openBgPicker();
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
    painter.scheduleDraw();
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
      painter.scheduleDraw();
    }
  });

  // Off-canvas pointer: drop hover effects (a captured drag keeps its events).
  canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    pointer = null;
    painter.scheduleDraw();
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

  // All canvas painting (ruler, rows, Фон filmstrip, playhead) lives in the
  // painter; the orchestrator hands it read access to its live state.
  const painter = createPainter({
    canvas,
    wrap,
    scroll,
    views: VIEWS,
    displayTracks: () => displayTracks(store.getProject()),
    makeEnv,
    durationMs,
    contentWidth,
    viewportWidth,
    msToX,
    xToMs,
    playheadMs: () => playheadMs,
    recording: () => ({ active: recording, cursor: recordCursor }),
  });

  // Repaint triggers. NOTE: attached AFTER the painter exists —
  // timingCapture.onState invokes its callback IMMEDIATELY on subscribe.
  audioEngine.onTime((t) => {
    playheadMs = t;
    painter.draw();
  });
  // Filmstrip decode is async — redraw the bg row once the thumbs are ready.
  setFilmstripOnReady(() => painter.scheduleDraw());
  store.subscribe(() => {
    renderGutter(displayTracks(store.getProject()));
    painter.draw();
  });
  timingCapture.onState((isRecording, cursor) => {
    recording = isRecording;
    recordCursor = cursor;
    painter.draw();
  });
  // Native scrolling no longer moves the painted pixels (viewport-wide canvas,
  // content offset via translate) — redraw on every scroll (rAF-throttled
  // inside the painter), and on viewport resize (panel toggling, orientation).
  scroll.addEventListener('scroll', () => painter.scheduleDraw(), { passive: true });
  const ro = new ResizeObserver(() => painter.scheduleDraw());
  ro.observe(scroll);

  renderGutter(displayTracks(store.getProject()));
  painter.draw();

  return { root, runAutoAlign: actions.runAutoAlign };
}
