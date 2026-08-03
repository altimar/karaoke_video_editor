/**
 * Registry of all syllabifiers. To add a language: create a module implementing
 * `Syllabifier`, add it here, and it's picked up automatically.
 */
import { Syllabifier } from './types';
import { russianSyllabifier } from './russian';
import { englishSyllabifier } from './english';
import { germanSyllabifier } from './german';

export const SYLLABIFIERS: Record<string, Syllabifier> = {
  ru: russianSyllabifier,
  en: englishSyllabifier,
  de: germanSyllabifier,
};

export function getSyllabifier(lang: string): Syllabifier | null {
  return SYLLABIFIERS[lang] ?? null;
}
