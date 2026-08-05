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
 * Everything a track view needs to draw / hit-test one frame, independent of
 * the concrete track kind. Provided by the orchestrator per draw / pointer
 * event. The coordinate functions already account for the current zoom.
 */
export interface TimelineEnv {
  msToX: (ms: number) => number;
  xToMs: (x: number) => number;
  /** Song duration in ms (clamped to ≥1). */
  durationMs: () => number;
  /** Canvas content width in px (at the current zoom). */
  width: number;
}

/** A drag a track view claimed via hitTest — carried across pointermove. */
export type TrackDrag =
  | { kind: 'syllable'; trackIndex: number; lineIndex: number; sylIndex: number; moved: boolean }
  | { kind: 'volume'; trackIndex: number; timeMs: number; moved: boolean };

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
  /** Handle a click in the row that didn't hit any object (e.g. add a point). */
  onBackgroundClick?(track: T, rowY: number, x: number, y: number, env: TimelineEnv): void;
  /** Handle a double-click on a claimed object (e.g. delete a point). */
  onDoubleTap?(drag: TrackDrag): void;
}
