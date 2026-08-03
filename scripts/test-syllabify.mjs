/**
 * Tests for syllabification: language detection + per-language splitting.
 * Run: node scripts/test-syllabify.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, unlinkSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const entryFile = join(__dirname, '_syl-entry.ts');
const outFile = join(__dirname, '_syl-bundle.mjs');

writeFileSync(
  entryFile,
  `export { syllabifyText, detectLanguage, getSyllabifier } from '${root.replace(/\\/g, '/')}/src/lib/syllabification/index';\n`,
);
await build({ entryPoints: [entryFile], bundle: true, format: 'esm', platform: 'neutral', outfile: outFile, logLevel: 'silent' });
const { syllabifyText, detectLanguage, getSyllabifier } = await import(pathToFileURL(outFile).href + '?' + Date.now());

let failures = 0;
const assert = (c, m) => { if (!c) { failures++; console.error('  ✗ FAIL:', m); } else console.log('  ✓', m); };

console.log('Syllabification tests\n');

// --- Language detection ---
assert(detectLanguage('Привет мой друг') === 'ru', 'detect: Russian → ru');
assert(detectLanguage('Hello my friend') === 'en', 'detect: English → en');
assert(detectLanguage('Grüße Gott mein Freund') === 'de', 'detect: German (umlauts) → de');
assert(detectLanguage('') === null, 'detect: empty → null');

// --- Russian ---
const ru = getSyllabifier('ru');
const ruTest = (word, expected) => {
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

// --- English ---
const en = getSyllabifier('en');
const enTest = (word, expected) => {
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

// --- German ---
const de = getSyllabifier('de');
const deTest = (word, expected) => {
  const got = de.syllabify(word);
  assert(got.join('/') === expected, `de: ${word} → ${expected} (got ${got.join('/')})`);
};
deTest('lesen', 'le/sen');
deTest('Finger', 'Fin/ger');
deTest('schreiben', 'schrei/ben');
deTest('Wasser', 'Was/ser');
deTest('der', 'der');
deTest('schön', 'schön');

// --- Full text syllabification (slashes in text) ---
const ruResult = syllabifyText('Привет мой друг');
assert(ruResult.lang === 'ru', `syllabifyText: detected ru`);
assert(ruResult.text === 'При/вет мой друг', `syllabifyText: "При/вет мой друг" (got "${ruResult.text}")`);

const enResult = syllabifyText('Hello beautiful world');
assert(enResult.lang === 'en', `syllabifyText: detected en`);
// "Hello" → Hel/lo, "beautiful" → beau/ti/ful, "world" → world
assert(enResult.text.includes('beau/ti/ful'), `syllabifyText: english split (got "${enResult.text}")`);

// Punctuation preserved
const punctResult = syllabifyText('Привет, мир!');
assert(punctResult.text === 'При/вет, мир!', `punctuation preserved: "${punctResult.text}"`);

// Already-syllabified text: existing slashes should be respected (word has internal /)
// Actually syllabifyText works on raw text — if slashes already there, the regex
// won't match cleanly. Test a clean case.
const multiLine = syllabifyText('Первая строка\nВторая строка');
assert(multiLine.text.includes('\n'), 'multiline: newline preserved');

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
unlinkSync(outFile);
unlinkSync(entryFile);
if (failures > 0) process.exit(1);
