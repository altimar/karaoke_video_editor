/**
 * Tests for syllabification: language detection + per-language splitting.
 */
import { test } from 'vitest';
import { syllabifyText, detectLanguage, getSyllabifier } from '../src/lib/syllabification/index';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

test('language detection', () => {
  assert(detectLanguage('Привет мой друг') === 'ru', 'detect: Russian → ru');
  assert(detectLanguage('Hello my friend') === 'en', 'detect: English → en');
  assert(detectLanguage('Grüße Gott mein Freund') === 'de', 'detect: German (umlauts) → de');
  assert(detectLanguage('') === null, 'detect: empty → null');
});

test('russian syllabifier', () => {
  const ru = getSyllabifier('ru');
  const ruTest = (word: string, expected: string) => {
    const got = ru.syllabify(word);
    assert(got.join('/') === expected, `ru: ${word} → ${expected} (got ${got.join('/')})`);
  };
  ruTest('Привет', 'При/вет');
  ruTest('караоке', 'ка/ра/о/ке');
  ruTest('солнце', 'солн/це');
  ruTest('мама', 'ма/ма');
  ruTest('окно', 'ок/но');
  ruTest('стол', 'стол'); // single syllable
  ruTest('длинный', 'длин/ный');
  ruTest('красота', 'кра/со/та');
});

test('english syllabifier (rules + compound prefixes + exceptions)', () => {
  const en = getSyllabifier('en');
  const enTest = (word: string, expected: string) => {
    const got = en.syllabify(word);
    assert(got.join('/') === expected, `en: ${word} → ${expected} (got ${got.join('/')})`);
  };
  enTest('rabbit', 'rab/bit');
  enTest('basket', 'bas/ket');
  enTest('paper', 'pa/per');
  enTest('apple', 'ap/ple');
  enTest('make', 'make'); // silent e → single syllable
  enTest('cat', 'cat'); // short word
  enTest('beautiful', 'beau/ti/ful');
  enTest('world', 'world');
  // Compound words — prefix split + rules for the rest
  enTest('someone', 'some/one');
  enTest('something', 'some/thing');
  enTest('somewhere', 'some/where');
  enTest('everyone', 'eve/ry/one');
  enTest('everything', 'eve/ry/thing');
  enTest('everybody', 'eve/ry/bo/dy');
  enTest('anything', 'any/thing');
  enTest('anybody', 'any/bo/dy');
  enTest('nothing', 'no/thing');
  enTest('nobody', 'no/body');
  // Common exception words
  enTest('other', 'oth/er');
  enTest('mother', 'moth/er');
  enTest('water', 'wa/ter');
  enTest('about', 'a/bout');
  enTest('another', 'a/noth/er');
  enTest('every', 'eve/ry');
});

test('german syllabifier', () => {
  const de = getSyllabifier('de');
  const deTest = (word: string, expected: string) => {
    const got = de.syllabify(word);
    assert(got.join('/') === expected, `de: ${word} → ${expected} (got ${got.join('/')})`);
  };
  deTest('lesen', 'le/sen');
  deTest('Finger', 'Fin/ger');
  deTest('schreiben', 'schrei/ben');
  deTest('Wasser', 'Was/ser');
  deTest('der', 'der');
  deTest('schön', 'schön');
});

test('syllabifyText: full text with detection, punctuation and multiline', () => {
  const ruResult = syllabifyText('Привет мой друг');
  assert(ruResult.lang === 'ru', 'syllabifyText: detected ru');
  assert(ruResult.text === 'При/вет мой друг', `syllabifyText: "При/вет мой друг" (got "${ruResult.text}")`);

  const enResult = syllabifyText('Hello beautiful world');
  assert(enResult.lang === 'en', 'syllabifyText: detected en');
  // "Hello" → Hel/lo, "beautiful" → beau/ti/ful, "world" → world
  assert(enResult.text.includes('beau/ti/ful'), `syllabifyText: english split (got "${enResult.text}")`);

  // Punctuation preserved
  const punctResult = syllabifyText('Привет, мир!');
  assert(punctResult.text === 'При/вет, мир!', `punctuation preserved: "${punctResult.text}"`);

  const multiLine = syllabifyText('Первая строка\nВторая строка');
  assert(multiLine.text.includes('\n'), 'multiline: newline preserved');
});
