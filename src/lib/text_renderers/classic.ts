/**
 * 'classic' renderer — fixed-slot karaoke.
 *
 * Properties:
 *  - Text is STATIONARY. N fixed "slots" (places for lines) are centered
 *    vertically; the slot of a line is `lineIndex mod N`, so the 5th line is
 *    drawn where the 1st was — output is cyclical (see the spec).
 *  - Each line fades IN over `fadeMs` before it begins, stays full while being
 *    sung, then fades OUT over `fadeMs` after it ends. The active line is the
 *    brightest; upcoming and past lines are dimmer, focusing the eye on the
 *    current line. Past (already-sung) lines stay muted until they vanish.
 *  - Syllable fill (highlight wipe), stroke and glow use the shared
 *    `drawSyllable`, identical to the scroller — only positioning differs.
 *
 * A line's bounds come from its TIMED syllables only: start = earliest startMs,
 * end = latest endMs. Lines with no timed syllables are skipped (invariant:
 * untimed syllables never render).
 */
import { TextRenderer, RenderCtx, RenderEnv, RenderSettingValue, TimedSyllable } from './types';
import { applyFont, drawSyllable, layoutLine, lineOriginX } from './helpers';

export const classicRenderer: TextRenderer = {
  id: 'classic',
  label: 'Классическое караоке',
  settings: [
    { key: 'lineSlots', label: 'Сколько строк видно', kind: 'number', min: 2, max: 16, step: 1, default: 4 },
    { key: 'fadeMs', label: 'Появление/исчезновение, мс', kind: 'number', min: 0, max: 6000, step: 100, default: 1500 },
    { key: 'offsetX', label: 'Смещение по X, px', kind: 'number', min: -2000, max: 2000, step: 1, default: 0 },
    { key: 'offsetY', label: 'Смещение по Y, px', kind: 'number', min: -2000, max: 2000, step: 1, default: 0 },
  ],
  render(ctx: RenderCtx, timeMs: number, env: RenderEnv, settings: Record<string, RenderSettingValue>): void {
    const { lines, style, width, height, timings, activeLineIndex } = env;
    applyFont(ctx, style);

    const N = clampInt(settings.lineSlots, 4, 2, 16);
    const fadeMs = clampNum(settings.fadeMs, 1500, 0, 6000);
    const offX = clampNum(settings.offsetX, 0, -2000, 2000);
    const offY = clampNum(settings.offsetY, 0, -2000, 2000);

    // Lines with at least one timed syllable, plus their [start, end] bounds.
    const bounds = computeLineBounds(timings, lines.length);
    if (bounds.length === 0) return;

    // Vertical layout: N evenly-spaced slots, the block centered on screen.
    const lineSpacing = style.fontSize * style.lineHeight;
    const blockH = N * lineSpacing;
    const topY = (height - blockH) / 2 + lineSpacing / 2; // center of slot 0

    // Apply the whole-block offset via translate so lineOriginX / each slot
    // move together. Saves/restores wrap the entire block below.
    ctx.save();
    ctx.translate(offX, offY);

    for (const b of bounds) {
      const alpha = lineAlpha(b.start, b.end, timeMs, fadeMs);
      if (alpha <= 0) continue;

      // Cyclical slot: the 5th line lands on the same place as the 1st.
      const slot = b.lineIndex % N;
      const cy = topY + slot * lineSpacing;

      const laid = layoutLine(ctx, timings, b.lineIndex, timeMs, activeLineIndex, style);
      if (laid.syllables.length === 0) continue;
      const originX = lineOriginX(style, laid.width, width);

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

/** Lines that have at least one timed syllable, each with its [start, end] window. */
function computeLineBounds(timings: TimedSyllable[], lineCount: number): { lineIndex: number; start: number; end: number }[] {
  // Per-line min start / max end across its timed syllables.
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  for (const t of timings) {
    const s = starts.get(t.lineIndex);
    if (s === undefined || t.startMs < s) starts.set(t.lineIndex, t.startMs);
    const e = ends.get(t.lineIndex);
    if (e === undefined || t.endMs > e) ends.set(t.lineIndex, t.endMs);
  }
  const out: { lineIndex: number; start: number; end: number }[] = [];
  for (let li = 0; li < lineCount; li++) {
    const start = starts.get(li);
    const end = ends.get(li);
    if (start !== undefined && end !== undefined) out.push({ lineIndex: li, start, end });
  }
  return out;
}

/**
 * Visibility alpha for a line given its [start, end] window and current time.
 *  - before `start - fadeMs`: 0 (not yet appearing)
 *  - `start - fadeMs .. start`: 0 → 1 (fade in)
 *  - `start .. end`:            1 (fully visible, being sung)
 *  - `end .. end + fadeMs`:     1 → 0 (fade out)
 *  - after `end + fadeMs`:      0 (gone)
 */
function lineAlpha(start: number, end: number, timeMs: number, fadeMs: number): number {
  if (fadeMs <= 0) {
    // No fade: visible exactly during the window.
    return timeMs >= start && timeMs <= end ? 1 : 0;
  }
  if (timeMs < start - fadeMs) return 0;
  if (timeMs < start) return (timeMs - (start - fadeMs)) / fadeMs;
  if (timeMs <= end) return 1;
  if (timeMs <= end + fadeMs) return 1 - (timeMs - end) / fadeMs;
  return 0;
}

function clampInt(v: RenderSettingValue | undefined, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampNum(v: RenderSettingValue | undefined, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : fallback;
  return Math.max(min, Math.min(max, n));
}
