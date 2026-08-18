/**
 * Multilingual alignment support: uroman-style romanization, model picking by
 * the lyrics' script, and model-driven tokenization (MMS vocab, no word
 * separator).
 */
import { test } from 'vitest';
import { romanizeWord } from '../src/lib/alignment/romanize';
import { pickAlignModel, resolveAlignModelOverride, ENGLISH_ALIGN_MODEL, MULTILINGUAL_ALIGN_MODEL } from '../src/lib/alignment/models';
import { buildWords, buildTranscript, flattenSyllablesForAlignment } from '../src/lib/alignment/ctc';
import { Line } from '../src/types';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

// --- romanizeWord (uroman rules: default + rus) ---

test('romanizeWord: Russian single-char map', () => {
  assert(romanizeWord('привет') === 'privet', `privet, got "${romanizeWord('привет')}"`);
  assert(romanizeWord('дело') === 'delo', `delo, got "${romanizeWord('дело')}"`);
  assert(romanizeWord('щука') === 'shchuka', `shchuka, got "${romanizeWord('щука')}"`);
  assert(romanizeWord('яхта') === 'yakhta', `yakhta, got "${romanizeWord('яхта')}"`);
  assert(romanizeWord('юла') === 'yula', `yula, got "${romanizeWord('юла')}"`);
  assert(romanizeWord('шёл') === 'shyol', `shyol (ё→yo), got "${romanizeWord('шёл')}"`);
});

test('romanizeWord: word-start е→ye, hard/soft signs dropped', () => {
  assert(romanizeWord('елка') === 'yelka', `yelka, got "${romanizeWord('елка')}"`);
  assert(romanizeWord('ольга') === 'olga', `olga (ь dropped), got "${romanizeWord('ольга')}"`);
});

test('romanizeWord: vowel digraphs and word-final ий', () => {
  assert(romanizeWord('объект') === 'obyekt', `obyekt (ъе→ye), got "${romanizeWord('объект')}"`);
  assert(romanizeWord('мое') === 'moye', `moye (ое→oye), got "${romanizeWord('мое')}"`);
  assert(romanizeWord('синий') === 'siny', `siny (-ий→y), got "${romanizeWord('синий')}"`);
  assert(romanizeWord('синие') === 'siniye', `siniye (ие→iye), got "${romanizeWord('синие')}"`);
});

test('romanizeWord: Latin umlauts/accented letters (uroman defaults)', () => {
  assert(romanizeWord('schön') === 'schoen', `schoen, got "${romanizeWord('schön')}"`);
  assert(romanizeWord('über') === 'ueber', `ueber, got "${romanizeWord('über')}"`);
  assert(romanizeWord('straße') === 'strasse', `strasse (ß→ss), got "${romanizeWord('straße')}"`);
  assert(romanizeWord('café') === 'cafe', `cafe, got "${romanizeWord('café')}"`);
});

test('romanizeWord: ASCII passes through, punctuation dropped, case-insensitive', () => {
  assert(romanizeWord("don't") === "don't", `apostrophe kept, got "${romanizeWord("don't")}"`);
  assert(romanizeWord('ПРИВЕТ') === 'privet', `lowercased first, got "${romanizeWord('ПРИВЕТ')}"`);
  assert(romanizeWord('при-вет') === 'privet', `hyphen dropped, got "${romanizeWord('при-вет')}"`);
});

// --- pickAlignModel ---

test('pickAlignModel: ONE model for every script (MMS)', () => {
  // The English checkpoint lost the English A/B (repeated-chorus drift —
  // eval/results/ soul runs) and was retired from production; MMS covers
  // every script via romanization.
  assert(pickAlignModel('Hello world') === MULTILINGUAL_ALIGN_MODEL, 'pure ASCII → MMS');
  assert(pickAlignModel('Привет, как дела') === MULTILINGUAL_ALIGN_MODEL, 'Cyrillic → MMS');
  assert(pickAlignModel('123 !!! ...') === MULTILINGUAL_ALIGN_MODEL, 'no letters → MMS (no-op run)');
});

test('resolveAlignModelOverride: presets + URL swap for same-vocab checkpoints', () => {
  const en = resolveAlignModelOverride('en');
  assert(en.id === 'en' && en.vocabSize === ENGLISH_ALIGN_MODEL.vocabSize, 'en preset keeps the English config');
  const multi = resolveAlignModelOverride('multi');
  assert(multi === MULTILINGUAL_ALIGN_MODEL, 'multi preset is the production config untouched');
  const swapped = resolveAlignModelOverride('en', 'https://x/y.onnx', 'cache-x');
  assert(swapped.url === 'https://x/y.onnx' && swapped.cacheName === 'cache-x', 'URL/cache swapped');
  assert(swapped.letters === ENGLISH_ALIGN_MODEL.letters, 'vocab preserved on swap');
});

// --- model-driven tokenization ---

function linesOf(words: string[]): Line[] {
  return [{ syllables: words.map((w, i) => ({ text: w, startMs: null, sep: i === 0 ? '' : ' ' })) }];
}

test('buildWords with MMS: romanizes whole words, lowercase vocab ids', () => {
  // "при" + "вет" with '/' separator = ONE word → romanized as a unit.
  const line: Line = {
    syllables: [
      { text: 'при', startMs: null, sep: '' },
      { text: 'вет', startMs: null, sep: '/' },
    ],
  };
  const words = buildWords(flattenSyllablesForAlignment([line]), MULTILINGUAL_ALIGN_MODEL);
  assert(words.length === 1, 'both syllables form one word');
  // "privet" → p21 r12 i5 v24 e6 t10 (MMS vocab.json ids).
  assert(
    JSON.stringify(words[0].tokenIds) === JSON.stringify([21, 12, 5, 24, 6, 10]),
    `privet ids, got ${JSON.stringify(words[0].tokenIds)}`,
  );
});

test('buildTranscript with MMS: no separator token between words', () => {
  const flat = flattenSyllablesForAlignment(linesOf(['привет', 'мир']));
  const words = buildWords(flat, MULTILINGUAL_ALIGN_MODEL);
  const { tokens, tokenWord } = buildTranscript(words, MULTILINGUAL_ALIGN_MODEL.wordSepId);
  assert(tokens.length === 9, `privet(6)+mir(3) = 9 tokens, got ${tokens.length}`);
  assert(!tokens.includes(4), 'no `|` (id 4) separator — MMS has none');
  assert(
    JSON.stringify(tokenWord) === JSON.stringify([0, 0, 0, 0, 0, 0, 1, 1, 1]),
    `word indices without gaps, got ${JSON.stringify(tokenWord)}`,
  );
});
