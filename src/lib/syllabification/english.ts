/**
 * English syllabification (heuristic).
 *
 * English syllabification is notoriously hard (many exceptions). This uses
 * practical VCV / VCCV rules that work for the majority of common words:
 *
 *  - Words with ≤3 letters and one vowel → single syllable.
 *  - Silent 'e' at the end doesn't form a syllable (make → 1, like → 1).
 *  - VCV (vowel-consonant-vowel): split before the consonant (ra/bbit → rab/bit
 *    is handled by doubling; simple VCV → V/CV: pa/per).
 *  - VCCV: split between the consonants (bas/ket), unless they form a digraph
 *    (th, sh, ch, ph, wh) which stays together.
 *  - Doubled consonants always split (rab/bit, bas/ket).
 */
import { Syllabifier } from './types';

const VOWELS = new Set('aeiouyAEIOUY');
const DIGRAPHS = new Set(['th', 'sh', 'ch', 'ph', 'wh', 'ck', 'ng', 'nk', 'qu']);

function isVowel(ch: string): boolean {
  return VOWELS.has(ch);
}

export const englishSyllabifier: Syllabifier = {
  lang: 'en',
  label: 'English',

  syllabify(word: string): string[] {
    // Strip non-alpha suffix/prefix but remember them.
    const match = word.match(/^([a-zA-Z]+)(.*)$/);
    if (!match) return [word];
    const core = match[1];
    const suffix = match[2] || '';
    const lower = core.toLowerCase();

    // --- Compound prefixes: split off the prefix, then syllabify the rest ---
    // "everybody" → "eve/ry" + syllabify("body") → "eve/ry/bo/dy".
    // This handles ALL combinations automatically, no need to list each one.
    const COMPOUND_PREFIXES: { prefix: string; split: string[] }[] = [
      { prefix: 'every', split: ['eve', 'ry'] },
      { prefix: 'some', split: ['some'] },
      { prefix: 'any', split: ['any'] },
    ];
    for (const cp of COMPOUND_PREFIXES) {
      if (lower.startsWith(cp.prefix) && core.length > cp.prefix.length) {
        const rest = core.substring(cp.prefix.length);
        const restSyllables = this.syllabify(rest);
        // Rebuild with original case.
        const result: string[] = [];
        let pos = 0;
        for (const s of cp.split) {
          result.push(core.substring(pos, pos + s.length));
          pos += s.length;
        }
        for (let i = 0; i < restSyllables.length; i++) {
          if (i === restSyllables.length - 1) {
            result.push(restSyllables[i] + suffix);
          } else {
            result.push(restSyllables[i]);
          }
        }
        return result;
      }
    }

    // --- Exception dictionary: individual words that phonetic rules get wrong ---
    const EXCEPTIONS: Record<string, string> = {
      beautiful: 'beau/ti/ful',
      every: 'eve/ry',
      other: 'oth/er', mother: 'moth/er', brother: 'broth/er',
      water: 'wa/ter', over: 'o/ver', after: 'af/ter',
      never: 'nev/er', under: 'un/der', wonder: 'won/der',
      upon: 'u/pon', awake: 'a/wake', alone: 'a/lone',
      alive: 'a/live', away: 'a/way', afraid: 'a/fraid',
      about: 'a/bout', above: 'a/bove', across: 'a/cross',
      ahead: 'a/head', along: 'a/long', among: 'a/mong',
      around: 'a/round', arrive: 'ar/rive', appear: 'ap/pear',
      another: 'a/noth/er', whatever: 'what/ev/er',
      nothing: 'no/thing', nowhere: 'no/where', nobody: 'no/body',
    };
    if (EXCEPTIONS[lower]) {
      // Split using the exception's pattern, preserving original case + suffix.
      const parts = EXCEPTIONS[lower].split('/');
      const result: string[] = [];
      let pos = 0;
      for (let i = 0; i < parts.length; i++) {
        const len = parts[i].length;
        let piece = core.substring(pos, pos + len);
        pos += len;
        if (i === parts.length - 1) piece += suffix;
        result.push(piece);
      }
      return result;
    }

    // Count vowels (excluding silent 'e').
    let silentE = lower.endsWith('e') && core.length > 2 && !isVowel(lower[lower.length - 2]);
    const effectiveLen = silentE ? core.length - 1 : core.length;
    let vowelCount = 0;
    for (let i = 0; i < effectiveLen; i++) {
      if (isVowel(lower[i])) vowelCount++;
    }

    // "Consonant + le" ending (apple, table, little) forms a syllable even
    // without a vowel — the 'l' acts as a syllabic consonant.
    const endsInCLE = core.length >= 3 && lower.endsWith('le') && !isVowel(lower[core.length - 3]);
    if (endsInCLE) vowelCount++;

    // Special case: if the word ends in consonant+le and has only 1 real vowel
    // in effectiveLen, split before the consonant: "ap/ple", "tab/le".
    // For doubled consonants before "le" (apple, bottle), split BETWEEN them.
    if (endsInCLE) {
      const leConsonantPos = core.length - 3; // position of consonant before 'le'
      let hasVowelBefore = false;
      for (let j = 0; j <= leConsonantPos; j++) {
        if (isVowel(lower[j])) { hasVowelBefore = true; break; }
      }
      if (hasVowelBefore && leConsonantPos > 0) {
        // Check for doubled consonant (e.g. "pp" in apple): split between them.
        if (leConsonantPos >= 1 && lower[leConsonantPos] === lower[leConsonantPos - 1]) {
          return [core.substring(0, leConsonantPos), core.substring(leConsonantPos) + suffix];
        }
        return [core.substring(0, leConsonantPos + 1), core.substring(leConsonantPos + 1) + suffix];
      }
    }

    if (vowelCount <= 1) {
      return [word];
    }

    // Walk through finding vowel groups and splitting points.
    const syllables: string[] = [];
    let start = 0;
    let i = 0;

    while (i < effectiveLen) {
      if (isVowel(lower[i])) {
        // Find the end of this vowel group (consecutive vowels).
        let vEnd = i;
        while (vEnd + 1 < effectiveLen && isVowel(lower[vEnd + 1])) vEnd++;

        // Is this the last vowel group?
        let hasMoreVowels = false;
        for (let j = vEnd + 1; j < effectiveLen; j++) {
          if (isVowel(lower[j])) {
            hasMoreVowels = true;
            break;
          }
        }

        if (!hasMoreVowels) {
          // Last vowel group → take to the end of effectiveLen (+ silent e).
          const end = silentE ? core.length : effectiveLen;
          syllables.push(core.substring(start, end) + suffix);
          start = end;
          break;
        }

        // Find consonant cluster between this vowel group and the next vowel.
        let cStart = vEnd + 1;
        let cEnd = cStart;
        while (cEnd < effectiveLen && !isVowel(lower[cEnd])) cEnd++;
        // cStart..cEnd-1 is the consonant cluster.
        const cluster = lower.substring(cStart, cEnd);

        let splitPos: number;
        if (cluster.length === 0) {
          // Adjacent vowels (diphthong or hiatus) — keep together, no split here.
          i = vEnd + 1;
          continue;
        } else if (cluster.length === 1) {
          // VCV: split before the consonant → vowel stays, consonant goes to next.
          splitPos = cStart;
        } else {
          // VCCV: check for digraph at the start of cluster.
          const first2 = cluster.substring(0, 2);
          if (DIGRAPHS.has(first2)) {
            // Digraph stays together, goes to next syllable.
            splitPos = cStart;
          } else {
            // Split between the consonants: first half stays, second goes to next.
            // For 2 consonants: split in middle. For 3+: first stays, rest to next.
            splitPos = cStart + 1;
          }
        }

        syllables.push(core.substring(start, splitPos));
        start = splitPos;
        i = splitPos;
      } else {
        i++;
      }
    }

    if (start < core.length && syllables.length > 0) {
      // Leftover trailing consonants → append to last syllable.
      syllables[syllables.length - 1] += core.substring(start);
    }

    if (syllables.length === 0) return [word];
    // Attach suffix to last.
    if (suffix && !syllables[syllables.length - 1].endsWith(suffix)) {
      syllables[syllables.length - 1] += suffix;
    }

    return syllables;
  },
};
