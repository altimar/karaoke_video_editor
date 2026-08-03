/**
 * German syllabification.
 *
 * Rules (simplified, covers most common cases):
 *  - One vowel or diphthong per syllable.
 *  - Diphthongs: ei, eu, äu, au, ie (treated as single vowel units).
 *  - VCV (vowel-consonant-vowel): split before the consonant (le/sen).
 *  - VCCV: split between consonants (Fin/ger).
 *  - Indivisible clusters: sch, ch, ph, ck, tz, pf — stay together and go to
 *    the next syllable (Schule → Schu/le, but schreiben → schrei/ben).
 *  - Single consonant between vowels → goes to next (le/sen, Wa/ge).
 *  - Words ≤3 letters → single syllable.
 */
import { Syllabifier } from './types';

const VOWELS = new Set('aeiouäöüyAEIOUÄÖÜY');
// Clusters that should not be split — they go as a unit to the next syllable.
const INDIVISIBLE = new Set(['sch', 'ch', 'ph', 'ck', 'tz', 'pf']);

function isVowel(ch: string): boolean {
  return VOWELS.has(ch);
}

/**
 * Check if chars at position start..end form a diphthong.
 * Returns the length of the diphthong (2 for ei/au/etc, 3 for none), or 1 if single vowel.
 */
function diphthongLen(lower: string, pos: number): number {
  if (pos + 1 < lower.length) {
    const pair = lower.substring(pos, pos + 2);
    if (['ei', 'eu', 'äu', 'au', 'ie', 'äi'].includes(pair)) return 2;
  }
  return 1;
}

export const germanSyllabifier: Syllabifier = {
  lang: 'de',
  label: 'Deutsch',

  syllabify(word: string): string[] {
    const match = word.match(/^([a-zA-ZäöüÄÖÜß]+)(.*)$/);
    if (!match) return [word];
    const core = match[1];
    const suffix = match[2] || '';
    const lower = core.toLowerCase();

    // Find vowel groups (including diphthongs).
    const vowelGroups: { start: number; end: number }[] = [];
    let i = 0;
    while (i < lower.length) {
      if (isVowel(lower[i])) {
        const dlen = diphthongLen(lower, i);
        // Extend through consecutive vowels.
        let end = i + dlen;
        while (end < lower.length && isVowel(lower[end])) end++;
        vowelGroups.push({ start: i, end });
        i = end;
      } else {
        i++;
      }
    }

    if (vowelGroups.length <= 1) return [word];

    const syllables: string[] = [];
    let start = 0;

    for (let g = 0; g < vowelGroups.length; g++) {
      const vg = vowelGroups[g];

      if (g === vowelGroups.length - 1) {
        // Last vowel group → take to end.
        syllables.push(core.substring(start) + suffix);
        break;
      }

      // Consonant cluster between this vowel group and the next.
      const cStart = vg.end;
      const nextVg = vowelGroups[g + 1];
      const cEnd = nextVg.start;
      const cluster = lower.substring(cStart, cEnd);

      let splitPos: number;
      if (cluster.length === 0) {
        // Adjacent vowel groups — no split needed.
        continue;
      } else if (cluster.length === 1) {
        // VCV: consonant goes to next syllable.
        splitPos = cStart;
      } else {
        // Check for indivisible cluster at the start.
        const first3 = cluster.substring(0, 3);
        const first2 = cluster.substring(0, 2);
        if (INDIVISIBLE.has(first3)) {
          splitPos = cStart; // "sch" etc go to next
        } else if (INDIVISIBLE.has(first2)) {
          splitPos = cStart; // "ch", "ph", "ck", "tz", "pf" go to next
        } else {
          // VCCV: split between consonants — first stays, rest to next.
          splitPos = cStart + 1;
        }
      }

      syllables.push(core.substring(start, splitPos));
      start = splitPos;
    }

    if (syllables.length === 0) return [word];

    return syllables;
  },
};
