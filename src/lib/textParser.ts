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
