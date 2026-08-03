/**
 * Syllabifier interface — one implementation per language.
 *
 * Each module takes a single word (no spaces) and returns it split into
 * syllables. To add a language: create a module, register it in registry.ts.
 */
export interface Syllabifier {
  /** Language code: 'ru', 'en', 'de', ... */
  lang: string;
  /** Human-readable name for UI. */
  label: string;
  /** Split a single word into syllables. Returns ["При", "вет"] for "Привет". */
  syllabify(word: string): string[];
}

/**
 * Detect the most likely language of a text based on character frequency.
 * Returns a language code, or null if the text is too short / ambiguous.
 *
 * Heuristics:
 *  - Significant Cyrillic content → 'ru'.
 *  - German-specific chars (ä, ö, ü, ß) present and no Cyrillic → 'de'.
 *  - Otherwise → 'en' (default for Latin script).
 */
export function detectLanguage(text: string): string | null {
  if (text.trim().length === 0) return null;
  let cyrillic = 0;
  let latin = 0;
  let german = 0;
  for (const ch of text) {
    if (/[а-яёА-ЯЁ]/.test(ch)) cyrillic++;
    else if (/[a-zA-ZäöüÄÖÜß]/.test(ch)) {
      latin++;
      if (/[äöüÄÖÜß]/.test(ch)) german++;
    }
  }
  if (cyrillic > 0 && cyrillic >= latin) return 'ru';
  // If more than 5% of Latin letters are German-specific, guess German.
  if (latin > 0 && german / latin > 0.05) return 'de';
  if (latin > 0) return 'en';
  return null;
}
