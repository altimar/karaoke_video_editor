/**
 * Layout-agnostic helpers shared by all text renderers: timing computation,
 * syllable layout, and glyph drawing. These are the primitives every mode is
 * built on top of (measuring, filling, stroking a syllable) — they contain no
 * layout-specific positioning logic.
 */
import { Line, Syllable, TextStyle } from '../../types';
import { RenderCtx, TimedSyllable } from './types';

/**
 * Fixed fill duration for a line's LAST syllable. Without this the last syllable
 * would stretch all the way to the next line's first syllable (since end = next
 * start), making it fill very slowly across the inter-line gap. A short fixed
 * span keeps its fill natural and consistent.
 */
const LAST_SYLLABLE_FILL_MS = 500;

/**
 * Build timing info for every TIMED syllable: its start and its (implied) end.
 *  - A mid-line syllable ends at the next syllable's start (same line).
 *  - A line's LAST syllable ends `LAST_SYLLABLE_FILL_MS` later, NOT at the next
 *    line's start (it shouldn't slowly fill through the inter-line pause).
 *  - The song's very last syllable follows the same rule — a quick fill, not a
 *    crawl to `durationMs` (the outro is usually instrumental anyway).
 * Untimed syllables are dropped entirely — there is nothing to render until
 * timings are captured.
 */
export function buildTimings(lines: Line[], durationMs: number): TimedSyllable[] {
  // !!! IMPORTANT: only TIMED syllables (startMs !== null) are included here.
  // !!! Untimed syllables are deliberately EXCLUDED — they do NOT render in the
  // !!! preview or the exported video, and they do NOT appear on the timeline.
  // !!! This is intentional: until a syllable has a timing, there is nothing to
  // show. Do NOT change this without explicit user approval.
  void durationMs;
  const flat: { syl: Syllable; lineIndex: number; sylIndex: number }[] = [];
  lines.forEach((line, lineIndex) => {
    line.syllables.forEach((syl, sylIndex) => {
      if (syl.startMs !== null) flat.push({ syl, lineIndex, sylIndex });
    });
  });
  const result: TimedSyllable[] = [];
  for (let i = 0; i < flat.length; i++) {
    const startMs = flat[i].syl.startMs as number;
    let endMs: number;
    if (i + 1 >= flat.length) {
      // Song's last syllable: same quick fill as any line-last syllable.
      endMs = startMs + LAST_SYLLABLE_FILL_MS;
    } else {
      const next = flat[i + 1];
      if (next.lineIndex !== flat[i].lineIndex) {
        // Last syllable of its line: fixed short fill, not the next line's start.
        endMs = startMs + LAST_SYLLABLE_FILL_MS;
      } else {
        // Mid-line: end at the next syllable's start.
        endMs = next.syl.startMs as number;
      }
    }
    result.push({ syl: flat[i].syl, startMs, endMs, lineIndex: flat[i].lineIndex, sylIndex: flat[i].sylIndex });
  }
  return result;
}

/** Fill progress (0..1) of a syllable at the given time. Untimed → always 0. */
export function progress(ts: TimedSyllable, timeMs: number): number {
  if (ts.startMs === null || ts.endMs === null) return 0;
  if (timeMs <= ts.startMs) return 0;
  if (timeMs >= ts.endMs) return 1;
  const span = ts.endMs - ts.startMs;
  return span > 0 ? (timeMs - ts.startMs) / span : 1;
}

/** Find the index of the syllable currently filling at timeMs (−1 if before first). */
export function activeIndex(timings: TimedSyllable[], timeMs: number): number {
  for (let i = 0; i < timings.length; i++) {
    if (timeMs >= timings[i].startMs && timeMs < timings[i].endMs) return i;
  }
  if (timeMs >= timings[timings.length - 1].endMs) return timings.length - 1;
  return -1;
}

/** Configure text font/baseline/alignment on the context. */
export function applyFont(ctx: RenderCtx, style: TextStyle): void {
  ctx.font = `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left'; // we position each syllable manually for precise gaps
}

/** A syllable with its measured position and current fill state, ready to draw. */
export interface LaidSyllable {
  text: string;
  x: number; // relative to line left
  w: number;
  progress: number;
  ts: TimedSyllable;
  isActive: boolean;
}

/**
 * Lay out one line: measure each syllable left-to-right. The gap between
 * syllables depends on what separator preceded them in the source text:
 *  - a space (' ')  → a real space is inserted (measured width of ' '), so words
 *    are visually separated in the video just like in the lyrics;
 *  - a slash ('/')  → NO gap: the pieces join into one continuous word;
 *  - '' (line start) → no gap.
 * So "При/вет мой" lays out as "Привет" + space + "мой". This replaces the old
 * fixed `syllableGap` setting.
 */
export function layoutLine(
  ctx: RenderCtx,
  timings: TimedSyllable[],
  lineIndex: number,
  timeMs: number,
  activeLineIndex: number,
  _style: TextStyle,
): { syllables: LaidSyllable[]; width: number } {
  const lineTimings = timings.filter((t) => t.lineIndex === lineIndex);
  const spaceW = ctx.measureText(' ').width;
  const out: LaidSyllable[] = [];
  let x = 0;
  for (const ts of lineTimings) {
    // Insert a space before this syllable if the source separated it with a space.
    if (ts.syl.sep === ' ') x += spaceW;
    const w = ctx.measureText(ts.syl.text).width;
    const prog = progress(ts, timeMs);
    out.push({
      text: ts.syl.text,
      x,
      w,
      progress: prog,
      ts,
      isActive: ts.lineIndex === activeLineIndex && prog > 0 && prog < 1,
    });
    x += w; // slash-separated and first-in-line: no extra gap
  }
  return { syllables: out, width: Math.max(0, x) };
}

/** Line X origin for the given alignment & container width. */
export function lineOriginX(style: TextStyle, lineWidth: number, canvasWidth: number): number {
  switch (style.textAlign) {
    case 'left':
      return 0;
    case 'right':
      return canvasWidth - lineWidth;
    default:
      return (canvasWidth - lineWidth) / 2;
  }
}

/** Draw one laid-out syllable with fill, stroke and glow. */
export function drawSyllable(
  ctx: RenderCtx,
  ls: LaidSyllable,
  originX: number,
  cy: number,
  style: TextStyle,
): void {
  const prog = ls.progress;

  ctx.save();

  const drawX = originX + ls.x;

  if (style.glowBlur > 0 && (ls.isActive || ls.progress >= 1)) {
    ctx.shadowColor = style.glowColor;
    ctx.shadowBlur = style.glowBlur;
  }

  ctx.fillStyle = style.colorBase;
  ctx.fillText(ls.text, drawX, cy);

  if (prog > 0) {
    ctx.save();
    ctx.beginPath();
    const fillRight = drawX + ls.w * prog;
    ctx.rect(drawX, cy - style.fontSize, fillRight - drawX, style.fontSize * 2);
    ctx.clip();
    ctx.fillStyle = style.colorHighlight;
    ctx.fillText(ls.text, drawX, cy);
    ctx.restore();
  }

  if (style.strokeWidth > 0) {
    ctx.shadowBlur = 0;
    ctx.lineWidth = style.strokeWidth;
    // Outline color follows the fill state, mirroring the text fill: a
    // filled/active syllable uses the active outline, an unfilled one the
    // inactive outline (KFN FrameColor / InactiveFrameColor).
    ctx.strokeStyle = ls.progress >= 1 || ls.isActive ? style.strokeColorActive : style.strokeColorInactive;
    ctx.lineJoin = 'round';
    ctx.strokeText(ls.text, drawX, cy);
  }

  ctx.restore();
}

// --- Pause indicator ("gap bar") ---
// During a long instrumental pause (line ended, next line far away) a wide
// one-line-tall bar fills left-to-right and completes exactly when the next
// line begins — the singer sees when to prepare (KaraFun-style).

/**
 * Draw the pause bar: a full-screen-width track of ~one line height at the
 * vertical center, filling left-to-right with the style's highlight color.
 * Returns true when a bar was drawn (the caller may skip other overlays).
 */
export function drawGapBar(
  ctx: RenderCtx,
  env: { style: TextStyle; width: number; height: number },
  gap: { from: number; to: number },
  timeMs: number,
): boolean {
  const frac = Math.max(0, Math.min(1, (timeMs - gap.from) / Math.max(1, gap.to - gap.from)));
  const cy = env.height / 2;
  const h = Math.max(6, env.style.fontSize * 0.5);
  const marginX = env.width * 0.08;
  const x = marginX;
  const w = env.width - marginX * 2;
  ctx.save();
  // Track: a subtle outlined pill.
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = Math.max(1, env.style.strokeWidth / 2);
  roundedRectPath(ctx, x, cy - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.stroke();
  // Fill: left-to-right in the active highlight color.
  if (frac > 0) {
    ctx.beginPath();
    ctx.rect(x, cy - h / 2, w * frac, h);
    ctx.clip();
    ctx.fillStyle = env.style.colorHighlight;
    roundedRectPath(ctx, x, cy - h / 2, w, h, h / 2);
    ctx.fill();
  }
  ctx.restore();
  return true;
}

/** Rounded-rect path helper (does not stroke/fill by itself). */
function roundedRectPath(ctx: RenderCtx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
