/**
 * Common types & the renderer interface shared by all text-layout modules.
 *
 * Each "mode" of animating lyrics (full / single / scroller / future ones) is an
 * independent module implementing `TextRenderer`. They plug into the frame
 * pipeline through a single uniform `render(ctx, timeMs, env)` call, so new modes
 * can be added without touching the orchestrator or each other.
 */
import { Layout, Line, Syllable, TextStyle } from '../../types';

/** 2D context of either a regular canvas (preview) or an OffscreenCanvas (export). */
export type RenderCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A syllable with resolved start/end timing, plus its location in the lyrics. */
export interface TimedSyllable {
  syl: Syllable;
  startMs: number;
  endMs: number;
  lineIndex: number;
  sylIndex: number;
}

/**
 * What a renderer needs to draw one frame of ONE text track. The orchestrator
 * (render.ts) pre-computes the shared `timings` and `activeLineIndex` per track
 * so every renderer gets the same picture without re-deriving it. The
 * orchestrator loops over all tracks and calls each track's renderer with this
 * env — tracks are independent and may overlap visually.
 */
export interface RenderEnv {
  /** This track's lyrics. */
  lines: Line[];
  /** This track's text style (font, colors, stroke/glow, layout). */
  style: TextStyle;
  /** Canvas dimensions in px (shared across tracks). */
  width: number;
  height: number;
  /** Song duration in ms — used as the end of the last timed syllable. */
  durationMs: number;
  /** Pre-computed timed syllables for this track (timed only — see buildTimings). */
  timings: TimedSyllable[];
  /** Index of the line currently filling at this frame (−1 if before first). */
  activeLineIndex: number;
}

/** A value held by a renderer setting: number (slider) or boolean (checkbox). */
export type RenderSettingValue = number | boolean;

/** Spec for one renderer setting, used to auto-generate its UI control. */
export interface RenderSettingSpec {
  /** Stable key, e.g. 'visibleLines'. Stored under project.rendererSettings[rendererId][key]. */
  key: string;
  /** UI label. */
  label: string;
  kind: 'number' | 'boolean';
  /** For kind:'number'. */
  min?: number;
  max?: number;
  step?: number;
  default: RenderSettingValue;
}

/**
 * A self-contained lyrics renderer. The orchestrator draws the background, then
 * hands off to exactly one renderer per frame, selected by `project.style.layout`.
 */
export interface TextRenderer {
  /** Mode id this renderer handles (matches a `Layout` value). */
  id: Layout;
  /** Human-readable name shown in the layout selector. */
  label: string;
  /** Per-mode settings exposed in the UI (auto-generated). Empty if none. */
  settings: RenderSettingSpec[];
  /**
   * Draw the lyrics layer for one frame. The background is already painted.
   * `settings` is this renderer's resolved settings merged with defaults.
   */
  render(ctx: RenderCtx, timeMs: number, env: RenderEnv, settings: Record<string, RenderSettingValue>): void;
}
