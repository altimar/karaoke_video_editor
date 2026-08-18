/**
 * uroman-compatible romanization for the multilingual (MMS) aligner.
 *
 * The MMS forced aligner consumes LATIN text only: any script is converted to
 * Latin first (uroman, Hermjakob ACL'18) — that's what makes one checkpoint
 * work across 1130 languages. This is a word-scoped port of the uroman rules
 * that matter for the app's languages (Russian + Latin diacritics), taken
 * from the reference table (isi-nlp/uroman, romanization-table.txt, default +
 * `::lcode rus` rules):
 *
 *  - single-char Cyrillic map (х→kh, ж→zh, щ→shch, ъ/ь dropped, …);
 *  - word-start exception: е→ye (елка → yelka, дело → delo);
 *  - vowel+vowel digraphs (ие→iye, ое→oye, ъе→ye, …);
 *  - «ий» at word end → y (гений → geniy… no: geniy ends with й not ий;
 *    «летний»-style adjectives: синий → siny);
 *  - Latin-1 supplement: umlauts ae/oe/ue, ß→ss, accents stripped.
 *
 * CTC alignment is fuzzy, so near-miss romanizations still align — but staying
 * close to uroman's output keeps the character stream what the model saw in
 * training. ASCII letters/digits/apostrophes pass through; everything else
 * unmapped is dropped (the tokenizer's vocab lookup drops it anyway).
 */

/** Single Cyrillic characters → Latin (default + rus rules). */
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Non-Russian Cyrillic basics (Ukrainian etc.) — better than dropping.
  є: 'ye', і: 'i', ї: 'yi', ґ: 'g', ў: 'u',
};

/** Latin-script diacritics → Latin (uroman defaults; German umlauts → ae/oe/ue). */
const LATIN_SUPPLEMENT: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss',
  á: 'a', à: 'a', â: 'a', ă: 'a', å: 'a',
  é: 'e', è: 'e', ê: 'e', ě: 'e',
  í: 'i', ì: 'i', î: 'i',
  ó: 'o', ò: 'o', ô: 'o', ő: 'o', ø: 'o',
  ú: 'u', ù: 'u', û: 'u', ů: 'u',
  ý: 'y', ñ: 'n', ç: 's', ð: 'd', þ: 'th',
  æ: 'ae', œ: 'oe',
};

/** Multi-char sources, applied before the single-char pass (longest first). */
const DIGRAPHS: Array<[string, string]> = [
  ['ае', 'aye'], ['её', 'eyo'], ['ее', 'eye'], ['иё', 'iyo'], ['ие', 'iye'],
  ['оё', 'oyo'], ['ое', 'oye'], ['уё', 'uyo'], ['уе', 'uye'],
  ['ьё', 'yo'], ['ье', 'ye'], ['ъё', 'yo'], ['ъе', 'ye'],
];

/** Word-start exceptions (`::use-only-at-start-of-word`, rus). */
const START: Record<string, string> = { е: 'ye' };

const PASS_THROUGH = /[a-z0-9']/;

/**
 * Romanize ONE word (lowercased). Word-scoped rules (start exception, end-of-
 * word «ий») need the word boundary — the tokenizer calls this per word.
 */
export function romanizeWord(word: string): string {
  const s = word.toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    let matched = false;
    for (const [src, dst] of DIGRAPHS) {
      if (!s.startsWith(src, i)) continue;
      out += dst;
      i += src.length;
      matched = true;
      break;
    }
    if (matched) continue;
    const ch = s[i];
    if (ch === 'и' && s.startsWith('ий', i) && i + 2 === s.length) {
      out += 'y'; // «-ий» at word end → y (rus rule)
      i += 2;
      continue;
    }
    if (i === 0 && START[ch] !== undefined) {
      out += START[ch];
      i++;
      continue;
    }
    const map = CYRILLIC[ch] ?? LATIN_SUPPLEMENT[ch];
    if (map !== undefined) out += map;
    else if (PASS_THROUGH.test(ch)) out += ch;
    i++;
  }
  return out;
}
