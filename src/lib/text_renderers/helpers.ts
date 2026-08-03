/**
 * Layout-agnostic helpers shared by all text renderers: timing computation,
 * syllable layout, and glyph drawing. These are the primitives every mode is
 * built on top of (measuring, filling, stroking a syllable) — they contain no
 * layout-specific positioning logic.
 */
import { Project, Style, Syllable } from '../../types';
import { RenderCtx, TimedSyllable } from './types';

/**
 * Build timing info for every TIMED syllable: its start and its (implied) end.
 * End = next syllable's start (across line boundaries). Untimed syllables are
 * dropped entirely — there is nothing to render until timings are captured.
 */
export function buildTimings(project: Project): TimedSyllable[] {
  // !!! IMPORTANT: only TIMED syllables (startMs !== null) are included here.
  // !!! Untimed syllables are deliberately EXCLUDED — they do NOT render in the
  // !!! preview or the exported video, and they do NOT appear on the timeline.
  // !!! This is intentional: until a syllable has a timing, there is nothing to
  // !!! show. Do NOT change this without explicit user approval.
  const flat: { syl: Syllable; lineIndex: number; sylIndex: number }[] = [];
  project.lines.forEach((line, lineIndex) => {
    line.syllables.forEach((syl, sylIndex) => {
      if (syl.startMs !== null) flat.push({ syl, lineIndex, sylIndex });
    });
  });
  const result: TimedSyllable[] = [];
  for (let i = 0; i < flat.length; i++) {
    const startMs = flat[i].syl.startMs as number;
    const endMs = i + 1 < flat.length ? (flat[i + 1].syl.startMs as number) : Math.max(project.durationMs, startMs + 1);
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
export function applyFont(ctx: RenderCtx, style: Style): void {
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
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
  _style: Style,
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
export function lineOriginX(style: Style, lineWidth: number, canvasWidth: number): number {
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
  style: Style,
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
    ctx.strokeStyle = style.strokeColor;
    ctx.lineJoin = 'round';
    ctx.strokeText(ls.text, drawX, cy);
  }

  ctx.restore();
}
