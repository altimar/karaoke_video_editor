/**
 * Russian syllabification.
 *
 * Core rule: "один гласный — один слог" (one vowel per syllable).
 *
 * Consonant assignment between two vowels:
 *  - A single consonant between vowels goes to the NEXT syllог (ot/kryt).
 *  - A "sonorant + non-sonorant" cluster (rt, lk, etc.) goes entirely to the
 *    next syllable (pol/ka, kov/шnya → ков/шня).
 *  - Multiple sonorants between vowels stay with the PREVIOUS syllable
 *    (storm, may → the sonorants attach to the preceding vowel: май/ка).
 *  - Otherwise (2+ consonants where the boundary is sonorant-nonsonorant is
 *    handled above), split between the two consonants.
 *
 * Reference: Russian phonetic syllabification rules as taught in schools.
 */
import { Syllabifier } from './types';

const VOWELS = new Set('аеёиоуыэюяАЕЁИОУЫЭЮЯ');
const SONORANTS = new Set('йрлмнЙРЛМН');
function isVowel(ch: string): boolean {
  return VOWELS.has(ch);
}
function isSonorant(ch: string): boolean {
  return SONORANTS.has(ch);
}

/**
 * Find the split point for a consonant cluster between two vowels.
 * `cluster` is the run of consonants between prevVowel and nextVowel.
 * Returns the number of consonants that go with the PREVIOUS syllable
 * (0 = all go to next; cluster.length = all stay).
 */
/**
 * Russian syllable boundary: how many consonants from the start of the cluster
 * stay with the PREVIOUS syllable. The rest go to the next syllable.
 *
 * Standard Russian school rule:
 * - Sonorants (йрлмн) + non-sonorant (бвгджзкпстфхцчшщ) between vowels:
 *   the sonorant stays with the previous vowel (полн/ый, воль/ный).
 * - Non-sonorant + sonorant: split between them (мет/ро, ке/рта — wait no).
 *
 * Practical simplified rules that work for most words:
 * - Single consonant → goes to next syllable (о/кно → ок/но... actually от/крыт).
 * - Cluster starting with sonorant(s) followed by non-sonorant:
 *   the sonorant(s) stay with previous, split before the non-sonorant.
 *   (солн/це: "лн" stay, "ц" goes next; полн/ый: "лн" stay, "й" ... wait).
 * - All sonorants or all non-sonorants: split in the middle (1st stays).
 */
function clusterSplit(cluster: string): number {
  if (cluster.length === 0) return 0;
  if (cluster.length === 1) return 0; // single → to next

  // Find the first non-sonorant in the cluster.
  // All sonorants before it stay with the previous syllable.
  // BUT: doubled consonants (нн, сс, etc.) always split in the middle.
  if (cluster.length === 2 && cluster[0] === cluster[1]) {
    return 1; // doubled → split
  }
  let stay = 0;
  for (let i = 0; i < cluster.length; i++) {
    if (isSonorant(cluster[i])) {
      stay++;
    } else {
      break;
    }
  }

  if (stay === 0) {
    // First consonant is non-sonorant. If second is also non-sonorant,
    // split between them (first stays). If second is sonorant, the sonorant
    // and everything after go to next, first stays.
    // For 2: always 1 stays.
    return Math.min(1, cluster.length - 1);
  }

  // stay > 0: sonorant(s) at the start stay with previous syllable.
  return stay;
}

export const russianSyllabifier: Syllabifier = {
  lang: 'ru',
  label: 'Русский',

  syllabify(word: string): string[] {
    // Strip trailing punctuation but remember it.
    const match = word.match(/^([а-яёА-ЯЁ]+)(.*)$/);
    if (!match) return [word]; // not a clean Russian word (has digits etc.)
    const core = match[1];
    const suffix = match[2] || '';

    // Find vowel positions.
    const vowelIndices: number[] = [];
    for (let i = 0; i < core.length; i++) {
      if (isVowel(core[i])) vowelIndices.push(i);
    }

    if (vowelIndices.length <= 1) {
      return [word]; // single syllable
    }

    // Build syllables by walking from left to right.
    const syllables: string[] = [];
    let syllableStart = 0;

    for (let vi = 0; vi < vowelIndices.length; vi++) {
      const vowelPos = vowelIndices[vi];
      let syllableEnd: number;

      if (vi === vowelIndices.length - 1) {
        // Last vowel → take everything to the end of core.
        syllableEnd = core.length;
      } else {
        // There are consonants between this vowel and the next.
        const nextVowelPos = vowelIndices[vi + 1];
        const cluster = core.substring(vowelPos + 1, nextVowelPos);
        const stayCount = clusterSplit(cluster);
        syllableEnd = vowelPos + 1 + stayCount;
      }

      syllables.push(core.substring(syllableStart, syllableEnd));
      syllableStart = syllableEnd;
    }

    // Attach suffix to last syllable.
    if (syllables.length > 0) {
      syllables[syllables.length - 1] += suffix;
    }

    return syllables;
  },
};
