/**
 * 'scroller' renderer — film-credits style.
 *
 * Properties:
 *  - CONSTANT scroll speed v (px/ms) for the whole song — text never freezes,
 *    never jerks. Speed is chosen so the AVERAGE gap between lines fits ~N lines
 *    on screen.
 *  - Each line is at the VERTICAL CENTER exactly at its anchor time (the start
 *    of its first syllable). Fill starts there; below = unfilled.
 *  - The DISTANCE between adjacent lines is NOT fixed — it's `v * dt`, where dt
 *    is the time gap between their anchors. Dense sections → lines close together;
 *    long instrumental breaks → lines spread far apart, may scroll off entirely
 *    leaving the screen empty until the next line enters from below.
 *
 * Position formula (dead simple):
 *   cy(k, t) = centerY - v * (t - anchor[k].startMs)
 *
 * At t = anchor[k] → cy = centerY (on the reading line). After that the line
 * rises at speed v forever. The speed is the SAME for every line, every frame.
 */
import { TextRenderer, RenderCtx, RenderEnv, RenderSettingValue } from './types';
import { applyFont, drawSyllable, layoutLine, lineOriginX } from './helpers';

export const scrollerRenderer: TextRenderer = {
  id: 'scroller',
  label: 'Бегущая (вылет снизу)',
  settings: [
    { key: 'visibleLines', label: 'Сколько строк видно', kind: 'number', min: 2, max: 16, step: 1, default: 8 },
  ],
  render(ctx: RenderCtx, timeMs: number, env: RenderEnv, settings: Record<string, RenderSettingValue>): void {
    const { lines, style, width, height, timings, activeLineIndex } = env;
    applyFont(ctx, style);

    const N = clampInt(settings.visibleLines, 8, 2, 16);
    const centerY = height / 2;

    // Collect lines with at least one timed syllable, keyed by their anchor time.
    const anchored: { lineIndex: number; startMs: number }[] = [];
    for (let li = 0; li < lines.length; li++) {
      const first = timings.find((t) => t.lineIndex === li);
      if (first) anchored.push({ lineIndex: li, startMs: first.startMs });
    }
    if (anchored.length === 0) return;

    // --- Constant speed ---
    // Choose v so that the AVERAGE distance between lines = height / N.
    // avgDt = average time gap between consecutive anchors.
    // v = (height / N) / avgDt  →  v * avgDt = height / N (average spacing).
    let v: number;
    if (anchored.length >= 2) {
      const firstStart = anchored[0].startMs;
      const lastStart = anchored[anchored.length - 1].startMs;
      const avgDt = (lastStart - firstStart) / (anchored.length - 1);
      v = avgDt > 0 ? height / N / avgDt : 0;
    } else {
      v = 0; // single line, no scroll
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();

    for (const a of anchored) {
      // Position: line is at center at its anchor time, then rises at speed v.
      const cy = centerY - v * (timeMs - a.startMs);
      // Skip lines well outside the screen.
      const margin = style.fontSize * 2;
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

    ctx.restore();
  },
};

function clampInt(v: RenderSettingValue | undefined, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
