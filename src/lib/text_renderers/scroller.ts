/**
 * 'scroller' renderer — film-credits style.
 *
 * The ACTIVE line (the one currently filling) sits at the VERTICAL CENTER.
 * Lines that will begin within `previewSec` seconds enter from the bottom and
 * scroll up at a constant speed chosen so a line starting exactly `previewSec`
 * in the future appears at the bottom edge of the screen.
 *
 *   v = (height / 2) / previewMs
 *
 * At t = anchor[k] (a line's first syllable start), cy(k) = centerY (center).
 * Before its anchor, the line is below center by v·(anchor − t); after, it rises
 * at speed v forever. The speed is the SAME for every line, every frame, so the
 * spacing between lines reflects their time gaps: dense → close, sparse → far.
 *
 * `previewSec` maps to KaraFun's `Trajectory=PlainBottomToTop*<param>*…`, where
 * <param> is a multiplier of a 10-second base (param 1.0 → 10 s preview).
 */
import { TextRenderer, RenderCtx, RenderEnv, RenderSettingValue } from './types';
import { applyFont, drawSyllable, layoutLine, lineOriginX, drawGapBar } from './helpers';

/** KaraFun's Trajectory base: param = BASE / previewSec (so param 1.0 → 10 s). */
const KFN_TRAJECTORY_BASE_SEC = 10;

/**
 * The fixed preview-time values KaraFun Studio's slider snaps to (in seconds).
 * Used both for the UI slider's steps and for quantizing an imported value.
 */
export const SCROLLER_PREVIEW_SEC_VALUES = [
  0.62, 0.74, 0.88, 1.1, 1.2, 1.5, 1.8, 2.1, 2.5, 3, 3.5, 4.2, 5, 5.9, 7.1, 8.4,
  10, 12, 14, 17, 20, 24, 28, 34, 40,
];

/** Snap an arbitrary previewSec to the nearest KaraFun slider value. */
export function snapPreviewSec(sec: number): number {
  let best = SCROLLER_PREVIEW_SEC_VALUES[0];
  let bestDist = Math.abs(sec - best);
  for (const v of SCROLLER_PREVIEW_SEC_VALUES) {
    const d = Math.abs(sec - v);
    if (d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

export const scrollerRenderer: TextRenderer = {
  id: 'scroller',
  label: 'Бегущая (вылет снизу)',
  settings: [
    { key: 'previewSec', label: 'Превью вперёд, сек', kind: 'number', min: 0.62, max: 40, step: 0.01, default: 10 },
    // Long-pause indicator: a bar filling until the next line starts (0 = off).
    { key: 'gapBarSec', label: 'Индикатор паузы от, сек', kind: 'number', min: 0, max: 30, step: 1, default: 4 },
  ],
  render(ctx: RenderCtx, timeMs: number, env: RenderEnv, settings: Record<string, RenderSettingValue>): void {
    const { lines, style, width, height, timings, activeLineIndex } = env;
    applyFont(ctx, style);

    const previewSec = clampNum(settings.previewSec, 10, 1, 60);
    const previewMs = previewSec * 1000;
    // Constant speed: a line whose anchor is `previewMs` in the future sits at
    // the bottom edge; the active line sits at the center.
    const v = height / 2 / previewMs;
    const centerY = height / 2;

    // Collect lines with at least one timed syllable, keyed by their anchor time.
    const anchored: { lineIndex: number; startMs: number }[] = [];
    for (let li = 0; li < lines.length; li++) {
      const first = timings.find((t) => t.lineIndex === li);
      if (first) anchored.push({ lineIndex: li, startMs: first.startMs });
    }
    if (anchored.length === 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();

    const margin = style.fontSize * 2; // off-screen cull margin (shared with the bar)
    for (const a of anchored) {
      // Position: line is at center at its anchor time, then rises at speed v.
      const cy = centerY - v * (timeMs - a.startMs);
      // Skip lines well outside the screen.
      if (cy < -margin || cy > height + margin) continue;

      const laid = layoutLine(ctx, timings, a.lineIndex, timeMs, activeLineIndex, style);
      if (laid.syllables.length === 0) continue;
      const originX = lineOriginX(style, laid.width, width);

      // Fade lines near the top (leaving) and bottom (entering).
      const fade = style.fontSize;
      let alpha = 1;
      if (cy < fade) alpha = Math.max(0, cy / fade);
      else if (cy > height - fade) alpha = Math.max(0, (height - cy) / fade);

      ctx.save();
      ctx.globalAlpha = alpha;
      for (const ls of laid.syllables) {
        drawSyllable(ctx, ls, originX, cy, style);
      }
      ctx.restore();
    }

    // Pause indicator: shown ONLY while NO line is on screen. A line is
    // visible from (anchor − preview − ε) when it enters at the bottom to
    // (anchor + preview + ε) when it leaves the top. The bar appears after
    // the previous line has fully left, fills across the empty window and
    // completes exactly when the next line ENTERS from the bottom (not when
    // it reaches the center).
    const gapBarSec = clampNum(settings.gapBarSec, 4, 0, 60);
    if (gapBarSec > 0) {
      // A line is VISIBLE (alpha > 0) during (anchor − preview, anchor + preview):
      // it enters at the bottom exactly previewMs before its anchor and fades
      // out at the top previewMs after it.
      // No bar while ANY line is on screen (enter→anchor→leave spans
      // previewMs on each side).
      const anyVisible = anchored.some(
        (a) => a.startMs - previewMs < timeMs && timeMs < a.startMs + previewMs,
      );
      // When the previous line left the top (0 before the first line).
      let screenEmptyFrom = 0;
      for (const a of anchored) {
        if (a.startMs + previewMs <= timeMs) {
          screenEmptyFrom = Math.max(screenEmptyFrom, a.startMs + previewMs);
        }
      }
      // When the next line will enter from the bottom.
      let nextEntersAt = Infinity;
      for (const a of anchored) {
        if (a.startMs - previewMs > timeMs) {
          nextEntersAt = Math.min(nextEntersAt, a.startMs - previewMs);
        }
      }
      const emptyWindow = nextEntersAt - screenEmptyFrom;
      if (!anyVisible && isFinite(nextEntersAt) && emptyWindow >= gapBarSec * 1000) {
        drawGapBar(ctx, { style, width, height }, { from: screenEmptyFrom, to: nextEntersAt }, timeMs);
      }
    }
    ctx.restore();
  },
};

function clampNum(v: RenderSettingValue | undefined, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Convert a KaraFun Trajectory param to a previewSec value (snapped to the
 * fixed slider set). param = BASE / sec, so sec = BASE / param.
 */
export function trajectoryToPreviewSec(param: number): number {
  if (param <= 0) return 10;
  return snapPreviewSec(KFN_TRAJECTORY_BASE_SEC / param);
}

/** Convert a previewSec value to a KaraFun Trajectory param: param = BASE / sec. */
export function previewSecToTrajectory(previewSec: number): number {
  if (previewSec <= 0) return 1;
  return KFN_TRAJECTORY_BASE_SEC / previewSec;
}
