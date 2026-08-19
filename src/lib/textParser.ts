/**
 * Lyrics text parsing & serialization.
 *
 * Syllables are split ONLY on: space (and tab), '/', and newline. Everything
 * else — letters, digits, punctuation (. , ! ? ; : — ...) — stays part of the
 * syllable, so the lyrics read naturally and punctuation isn't stripped or
 * mangled.
 *
 *   "Привет, мой друг!"  ->  [Привет,] [мой] [друг!]
 *   "Ка/ра/о/ке"         ->  [Ка] [ра] [о] [ке]   ('/' splits inside a word)
 *
 * Newlines separate lines. Several separators in a row collapse (no empty
 * syllables are produced), and the LAST separator before a syllable wins.
 *
 * Round-trip: each syllable remembers the separator that preceded it (' ', '/'
 * or '' for the first in its line). serializeLyrics rebuilds the text using
 * those separators, so the textarea stays readable: words keep their spaces,
 * and slashes the user typed are preserved exactly.
 */
import { Line, Syllable } from '../types';

/** Characters that separate syllables (a newline ends the line instead). */
const SEPARATORS = new Set(['/', ' ', '\t']);

export function parseLyrics(text: string): Line[] {
  const lines: Line[] = [];
  let current: Syllable[] = [];
  let token = '';
  // `sep` to attach to the NEXT syllable built: the separator that immediately
  // precedes it (' ', '/', or '' at line start). It is captured when a separator
  // is read and consumed when the following syllable is emitted.
  let nextSep = '';

  const flush = (): void => {
    if (token !== '') {
      current.push({ text: token, startMs: null, sep: nextSep });
      token = '';
      nextSep = ''; // consumed by this syllable
    }
  };
  const flushLine = (): void => {
    flush();
    if (current.length > 0) {
      lines.push({ syllables: current });
      current = [];
    }
    nextSep = ''; // first syllable of next line has no preceding separator
  };

  for (const ch of text) {
    if (ch === '\n' || ch === '\r') {
      flushLine();
    } else if (SEPARATORS.has(ch)) {
      // First close the current syllable (it keeps the separator that preceded
      // IT), THEN record this separator for the FOLLOWING syllable. This way the
      // separator attaches to the next syllable, not the one it ends.
      flush();
      nextSep = ch === '\t' ? ' ' : ch;
    } else {
      token += ch;
    }
  }
  flushLine();

  if (lines.length === 0) lines.push({ syllables: [{ text: ' ', startMs: null, sep: '' }] });
  return lines;
}

/** Inverse of parseLyrics: rebuild editable text from the data model. */
export function serializeLyrics(lines: Line[]): string {
  return lines
    .map((line) =>
      line.syllables.map((s) => `${s.sep === '/' ? '/' : ' '}${s.text}`).join('').trimStart(),
    )
    .join('\n');
}

/** Flatten all syllables across lines into one ordered list (used by timing capture & timeline). */
export function flatSyllables(lines: Line[]): { lineIndex: number; sylIndex: number; syl: Syllable }[] {
  const out: { lineIndex: number; sylIndex: number; syl: Syllable }[] = [];
  lines.forEach((line, lineIndex) => {
    line.syllables.forEach((syl, sylIndex) => {
      out.push({ lineIndex, sylIndex, syl });
    });
  });
  return out;
}

/** Index of the next syllable that still needs a start time, or -1 if all are timed. */
export function nextUntimedIndex(lines: Line[]): number {
  return flatSyllables(lines).findIndex((x) => x.syl.startMs === null);
}

/**
 * Merge timings from `oldLines` into `newLines` (freshly parsed) using pure
 * POSITIONAL carry over a FLATTENED list of all syllables across all lines.
 *
 * The carry is global (not per-line): the Nth syllable in the whole song gets
 * the timing of the Nth old syllable. This is critical because splitting a word
 * at the END of a line creates an extra syllable that must "steal" the timing
 * from the FIRST syllable of the NEXT line — a per-line merge would miss that.
 *
 * Behavior:
 *  - Editing a letter: same global position → same timing. ✓
 *  - Splitting a word: the extra syllable shifts everything after it down by one;
 *    the very LAST syllable in the whole song becomes untimed. ✓
 *  - Deleting a syllable: timings stay at their positions; the deleted one's
 *    timing is simply not carried. ✓
 */
export function mergeTimings(oldLines: Line[], newLines: Line[]): void {
  // Flatten all syllables across all lines into a single ordered list.
  const oldFlat = oldLines.flatMap((l) => l.syllables);
  const newFlat = newLines.flatMap((l) => l.syllables);
  for (let i = 0; i < newFlat.length; i++) {
    newFlat[i].startMs = i < oldFlat.length ? oldFlat[i].startMs : null;
  }
}

/**
 * Remove ONE syllable (text + its timing together) at its exact position —
 * the timeline's "select a marker, press Del". Unlike editing the text in the
 * textarea (where mergeTimings re-flows timings POSITIONALLY and everything
 * after the cut shifts by one), this removes the syllable IN PLACE: every
 * other syllable keeps its exact timing. A line left with no syllables is
 * removed entirely. Returns a NEW lines array (inputs untouched); invalid
 * indices return the input unchanged.
 */
/**
 * Del on a timeline selection: remove the selected syllables' TIMINGS (the
 * markers) and shift the following timings back by the removed count — the
 * positional effect of deleting those syllables from the TEXT, but the text
 * itself stays intact. This is the "accidental extra Space during recording"
 * repair: the timings were one ahead of the lyrics from that point; deleting
 * a marker pulls the tail back into alignment. The vacated positions at the
 * end become untimed. Returns a NEW lines array (inputs untouched).
 */
export function removeTimingsAndShift(lines: Line[], fromFlat: number, toFlat: number): Line[] {
  const flat = flatSyllables(lines);
  const count = Math.max(1, toFlat - fromFlat + 1);
  const starts = flat.map((f) => f.syl.startMs);
  starts.splice(Math.max(0, fromFlat), count);
  while (starts.length < flat.length) starts.push(null);
  // Write back through the same flat ordering, into copied lines/syllables.
  const next = lines.map((l) => ({ syllables: l.syllables.map((s) => ({ ...s })) }));
  let idx = 0;
  for (const line of next) {
    for (const syl of line.syllables) {
      syl.startMs = starts[idx++] ?? null;
    }
  }
  return next;
}

// --- Timing-edit helpers (timeline keyboard / block edits) ---
// All operate on the FLAT syllable view (flatSyllables) and honor the timeline
// invariant: a timed syllable stays between its nearest TIMED neighbors.

/** Clamp a candidate startMs for flat[idx] between the nearest timed
 *  neighbors in the same track (and [0, durationMs]). */
export function clampBetweenNeighbors(
  flat: ReturnType<typeof flatSyllables>,
  idx: number,
  ms: number,
  durationMs: number,
): number {
  let min = 0;
  let max = durationMs;
  for (let i = idx - 1; i >= 0; i--) {
    const v = flat[i]?.syl.startMs;
    if (v !== null && v !== undefined) {
      min = v;
      break;
    }
  }
  for (let i = idx + 1; i < flat.length; i++) {
    const v = flat[i]?.syl.startMs;
    if (v !== null && v !== undefined) {
      max = v;
      break;
    }
  }
  return Math.max(min, Math.min(max, ms));
}

/**
 * Allowed [lo, hi] shift (ms) for moving the timed syllables of flat[from..to]
 * as a block: the earliest must not cross its left neighbor, the latest must
 * not cross its right neighbor, and everything stays within [0, durationMs].
 * Untimed syllables inside the range don't move (nothing to move).
 */
export function rangeShiftBounds(
  flat: ReturnType<typeof flatSyllables>,
  from: number,
  to: number,
  durationMs: number,
): { lo: number; hi: number } {
  let minStart = Infinity;
  let maxStart = -Infinity;
  for (let i = from; i <= to; i++) {
    const ms = flat[i]?.syl.startMs;
    if (ms === null || ms === undefined) continue;
    if (ms < minStart) minStart = ms;
    if (ms > maxStart) maxStart = ms;
  }
  if (minStart === Infinity) return { lo: 0, hi: 0 }; // nothing timed — no-op
  let lo = -minStart; // global left wall
  let hi = durationMs - maxStart; // global right wall
  for (let i = from - 1; i >= 0; i--) {
    const v = flat[i]?.syl.startMs;
    if (v !== null && v !== undefined) {
      lo = Math.max(lo, v - minStart);
      break;
    }
  }
  for (let i = to + 1; i < flat.length; i++) {
    const v = flat[i]?.syl.startMs;
    if (v !== null && v !== undefined) {
      hi = Math.min(hi, v - maxStart);
      break;
    }
  }
  return { lo, hi };
}

/**
 * Validator: flat indices of TIMED syllables whose start is not strictly after
 * the previous timed syllable (zero/negative duration — an overlap), or lies
 * beyond the song duration. The LATER syllable of a bad pair is marked. Used
 * by the timeline to paint problem markers red.
 */
export function timingProblems(
  lines: Line[],
  durationMs: number,
): Set<number> {
  const flat = flatSyllables(lines);
  const bad = new Set<number>();
  let prevTimed = -1;
  for (let i = 0; i < flat.length; i++) {
    const ms = flat[i]?.syl.startMs;
    if (ms === null || ms === undefined) continue;
    const prevMs = flat[prevTimed]?.syl.startMs;
    if (prevTimed >= 0 && prevMs !== null && prevMs !== undefined && ms <= prevMs) bad.add(i);
    if (ms > durationMs) bad.add(i);
    prevTimed = i;
  }
  return bad;
}
