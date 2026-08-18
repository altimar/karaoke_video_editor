/**
 * Shared timeline contracts: the environment passed into every track view, the
 * drag result returned from hit-testing, and the `TrackView` strategy interface
 * that each track kind implements. The orchestrator (index.ts) holds no
 * track-type-specific logic — it dispatches to the view for the track's `type`.
 */
import { Track } from '../../types';

/** 2D context of either a regular canvas (preview) or an OffscreenCanvas (export). */
export type Ctx = CanvasRenderingContext2D;

/**
 * Interactive tool for audio rows, chosen in the timeline header:
 * - 'automation' — volume envelope: click adds a point, drag moves it,
 *   double-click deletes it (the historical behavior);
 * - 'edit' — phrase editing: envelopes are hidden; chunks of sound between
 *   relative silences can be dragged onto other audio tracks.
 */
export type AudioTool = 'automation' | 'edit';

/**
 * A syllable marker selected on the timeline (click). The selected marker is
 * highlighted and can be deleted with Del/Backspace (removed together with
 * its timing, no positional re-flow of the others).
 */
export interface SyllableSelection {
  trackId: string;
  lineIndex: number;
  sylIndex: number;
}

/**
 * Everything a track view needs to draw / hit-test one frame, independent of
 * the concrete track kind. Provided by the orchestrator per draw / pointer
 * event. The coordinate functions already account for the current zoom.
 */
export interface TimelineEnv {
  msToX: (ms: number) => number;
  xToMs: (x: number) => number;
  /** Song duration in ms (clamped to ≥1). */
  durationMs: () => number;
  /** Canvas content width in px (at the current zoom). The full virtual width
   *  the canvas represents; `msToX` maps into [0, width]. */
  width: number;
  /** Left edge of the currently visible window, in content px (= scrollLeft).
   *  Views draw in content space (0..width); this lets them cull anything
   *  outside [scrollLeft, scrollLeft + viewportWidth]. */
  scrollLeft: number;
  /** Width of the visible window in px. Together with scrollLeft defines the
   *  on-screen slice of content. */
  viewportWidth: number;
  /** The active track id — audio rows collapse to one line when inactive. */
  activeTrackId: string;
  /** The interactive tool for audio rows (timeline header switch). */
  tool: AudioTool;
  /** Last pointer position in content space (null when off-canvas) — for
   *  hover effects (e.g. the chunk under the cursor in edit mode). */
  pointer: { x: number; y: number } | null;
  /** While a drag that supports dropping is active: id of the track row under
   *  the pointer (the potential drop target), else null. */
  dropTargetTrackId: string | null;
  /** The currently claimed drag, if any (views draw source highlights). */
  drag: TrackDrag | null;
  /** The selected syllable marker (click), or null. Views highlight it. */
  selection: SyllableSelection | null;
}

/** A drag a track view claimed via hitTest — carried across pointermove. */
export type TrackDrag =
  | {
      kind: 'syllable';
      trackIndex: number;
      lineIndex: number;
      sylIndex: number;
      /** Where INSIDE the marker the grab happened (xToMs(x) − startMs at
       *  pointerdown): the drag keeps this offset so the marker doesn't jump
       *  its line to the cursor when grabbed by the label letters. */
      grabMs: number;
      moved: boolean;
    }
  | { kind: 'volume'; trackIndex: number; timeMs: number; moved: boolean }
  | {
      /** A detected sound chunk of an audio track, dragged to another role. */
      kind: 'chunk';
      trackIndex: number;
      /** Index into the source buffer's chunk list (at claim time). */
      chunkIndex: number;
      startMs: number;
      endMs: number;
      moved: boolean;
    };

/**
 * Strategy for one track kind. Each concrete view (textView, audioView, …)
 * implements this; the orchestrator looks it up by `track.type`. Adding a new
 * track kind means adding a module + registering it — the orchestrator stays
 * untouched.
 */
export interface TrackView<T extends Track = Track> {
  /** Fixed row height for this track kind. */
  rowHeight: number;
  /** Draw the track's content into its row. */
  draw(ctx: Ctx, track: T, rowY: number, env: TimelineEnv): void;
  /** Return a drag if the (x, y) hits a draggable object in this row, else null. */
  hitTest(track: T, rowY: number, x: number, y: number, env: TimelineEnv): TrackDrag | null;
  /** Apply a drag move (mutates the store) on pointermove. `rowY` is the row's
   *  current top (the caller owns the layout, never the view). */
  onDrag(drag: TrackDrag, rowY: number, x: number, y: number, env: TimelineEnv): void;
  /** Handle a click in the row that didn't hit any object (e.g. add a point).
   *  Return false to DECLINE the click — the orchestrator then falls through
   *  to its fallback (seek). */
  onBackgroundClick?(track: T, rowY: number, x: number, y: number, env: TimelineEnv): boolean | void;
  /** Handle a double-click on a claimed object (e.g. delete a point). */
  onDoubleTap?(drag: TrackDrag): void;
  /** Called on pointerup while a drag is claimed by this view, with the track
   *  row under the pointer as the drop target (null = off-rows). Only views
   *  whose drags are drop-like (e.g. a chunk onto another audio track) use it. */
  onDrop?(drag: TrackDrag, targetTrack: Track | null, env: TimelineEnv): void;
}
