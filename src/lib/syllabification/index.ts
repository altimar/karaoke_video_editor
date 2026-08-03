/**
 * Main entry point: detect language and syllabify an entire text block.
 *
 * Splits text into words (preserving spaces, punctuation, newlines), runs each
 * word through the language-specific syllabifier, and rejoins with `/` between
 * syllables of the same word. Words that can't be syllabified are left as-is.
 */
import { detectLanguage, Syllabifier } from './types';
import { getSyllabifier } from './registry';

export { detectLanguage } from './types';
export { getSyllabifier } from './registry';

export interface SyllabifyResult {
  /** The text with `/` inserted between syllables within each word. */
  text: string;
  /** Detected language code, or null if none detected. */
  lang: string | null;
  /** Human-readable language label for UI. */
  langLabel: string;
}

/**
 * Syllabify an entire text block. Detects language automatically.
 * Returns the text with slashes between syllables within words.
 */
export function syllabifyText(text: string): SyllabifyResult {
  const lang = detectLanguage(text);
  if (!lang) {
    return { text, lang: null, langLabel: 'язык не определён' };
  }
  const syllabifier = getSyllabifier(lang);
  if (!syllabifier) {
    return { text, lang: null, langLabel: 'язык не поддерживается' };
  }

  const result = syllabifyWords(text, syllabifier);
  return { text: result, lang, langLabel: syllabifier.label };
}

/**
 * Split text into words and non-words, syllabify each word, rejoin.
 * Preserves all whitespace, punctuation, and structure exactly.
 */
function syllabifyWords(text: string, syllabifier: Syllabifier): string {
  // Process line by line to preserve newlines.
  return text
    .split(/(\n)/)
    .map((line) => (line === '\n' ? line : syllabifyLine(line, syllabifier)))
    .join('');
}

/** Syllabify a single line (no newlines). */
function syllabifyLine(line: string, syllabifier: Syllabifier): string {
  // Split into tokens: words (letters) and separators (everything else).
  // A "word" is a maximal run of letters (including apostrophes/hyphens within).
  return line
    .split(/(\s+)/)
    .map((token) => (token.trim() === '' ? token : syllabifyWordToken(token, syllabifier)))
    .join('');
}

/**
 * Syllabify a single non-whitespace token like "Привет," or "world!".
 * Strips leading/trailing non-letters, syllabifies the core, reattaches.
 */
function syllabifyWordToken(token: string, syllabifier: Syllabifier): string {
  // Match: optional leading non-letters + core letters (+ internal '/-) + trailing non-letters.
  const match = token.match(/^([^a-zA-Zа-яёА-ЯЁäöüÄÖÜß]*)([a-zA-Zа-яёА-ЯЁäöüÄÖÜß][a-zA-Zа-яёА-ЯЁäöüÄÖÜß'\-]*)([^a-zA-Zа-яёА-ЯЁäöüÄÖÜß]*)$/);
  if (!match) return token; // no recognizable word

  const prefix = match[1];
  const core = match[2];
  const suffix = match[3];

  const parts = syllabifier.syllabify(core);
  if (parts.length <= 1) return token; // single syllable, no change

  return prefix + parts.join('/') + suffix;
}
