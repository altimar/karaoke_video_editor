/**
 * Standalone tests for the lyrics parser (text <-> model) and timing helpers.
 * Run: node scripts/test-parser.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(tmpdir(), 'kve-parser-test');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'parser-bundle.mjs');

await build({
  entryPoints: [join(root, 'src/lib/textParser.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: outFile,
  logLevel: 'silent',
});

const mod = await import(pathToFileURL(outFile).href);
const { parseLyrics, serializeLyrics, flatSyllables, nextUntimedIndex, mergeTimings } = mod;

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  ✗ FAIL:', msg); }
  else console.log('  ✓', msg);
}

console.log('Parser & timing tests\n');

// Parse: slashes AND whitespace are separators. "При/вет мир" => [При][вет][мир]
const parsed = parseLyrics('При/вет мир\nВто/рая');
assert(parsed.length === 2, 'two lines parsed');
assert(parsed[0].syllables.length === 3, 'line 1 splits into 3 syllables (При/вет/мир)');
assert(parsed[0].syllables[0].text === 'При', 'first syllable text "При"');
assert(parsed[0].syllables[1].text === 'вет', 'whitespace splits words: "вет"');
assert(parsed[0].syllables[2].text === 'мир', 'whitespace splits words: "мир"');
assert(parsed[1].syllables.length === 2, 'line 2 has 2 syllables');

// Each syllable remembers the separator that preceded it.
assert(parsed[0].syllables[0].sep === '', 'first syllable of a line has sep ""');
assert(parsed[0].syllables[1].sep === '/', 'second syllable preceded by "/"');
assert(parsed[0].syllables[2].sep === ' ', 'third syllable preceded by space');

// Round-trip: serialize rebuilds the EXACT original text (spaces stay spaces,
// slashes stay slashes) — lyrics remain readable, not mangled into "a/b/c".
const back = serializeLyrics(parsed);
assert(back === 'При/вет мир\nВто/рая', 'serialize round-trips the original text exactly');

// Punctuation is NOT a separator anymore — it stays part of the syllable.
// "Привет, друг! Да." splits only on spaces => [Привет,][друг!][Да.]
const punct = parseLyrics('Привет, друг! Да.');
assert(punct.length === 1, 'punctuation: single line');
assert(punct[0].syllables.map((s) => s.text).join('|') === 'Привет,|друг!|Да.', 'punctuation stays attached to the word');

// Leading punctuation is kept (it's not a separator now): "!слово" is one syllable.
const lead = parseLyrics('!слово еще');
assert(lead[0].syllables.map((s) => s.text).join('|') === '!слово|еще', 'leading punctuation kept as part of the syllable');

// Multiple delimiters collapse (no empty syllables); blank lines skipped.
const p2 = parseLyrics('а/б\n\nв/  г');
assert(p2.length === 2, 'blank line skipped');
assert(p2[1].syllables.map((s) => s.text).join('|') === 'в|г', 'multiple separators collapse, no empty syllables');

// Tab also separates (normalized to a space on serialize).
const tabbed = parseLyrics('раз\tдва');
assert(tabbed[0].syllables.length === 2, 'tab is a separator');

// Round-trip keeps plain space-separated lyrics intact (no slashes injected).
const plain = parseLyrics('раз два три');
assert(serializeLyrics(plain) === 'раз два три', 'plain space-separated lyrics round-trip without slashes');

// flatSyllables ordering across lines. `parsed` = [При,вет,мир] + [Вто,рая] = 5.
const flat = flatSyllables(parsed);
assert(flat.length === 5, 'flat list has 5 syllables total');
assert(flat[0].lineIndex === 0 && flat[0].sylIndex === 0, 'flat[0] is line0 syl0');
assert(flat[4].lineIndex === 1 && flat[4].sylIndex === 1, 'flat[4] is line1 syl1');

// nextUntimedIndex when all null -> 0.
assert(nextUntimedIndex(parsed) === 0, 'all-untimed -> next index 0');

// nextUntimedIndex when first two timed -> 2.
const timed = JSON.parse(JSON.stringify(parsed));
timed[0].syllables[0].startMs = 100;
timed[0].syllables[1].startMs = 200;
assert(nextUntimedIndex(timed) === 2, 'first two timed -> next index 2');

// fully timed -> -1. Time every remaining syllable (line0 has 3, line1 has 2).
timed[0].syllables[2].startMs = 250;
timed[1].syllables[0].startMs = 300;
timed[1].syllables[1].startMs = 400;
assert(nextUntimedIndex(timed) === -1, 'fully timed -> -1');

console.log('\n--- mergeTimings (timing preservation on edit) ---\n');

// Helper: build lines from a flat list of [text, startMs] pairs, one per line.
function makeLines(pairs) {
  return pairs.map((arr) => ({ syllables: arr.map(([text, startMs]) => ({ text, startMs })) }));
}

// --- mergeTimings: PURE POSITIONAL carry (index j → index j) ---

// Scenario 1: split a word into two — timings cascade down, LAST becomes untimed.
// Old: [Привет(1000), мир(2000)]  →  New: [При, вет, мир]
// Positional: При←1000, вет←2000, мир→null (no old[2]).
{
  const oldLines = makeLines([[['Привет', 1000], ['мир', 2000]]]);
  const newLines = makeLines([[['При', null], ['вет', null], ['мир', null]]]);
  mergeTimings(oldLines, newLines);
  const s = newLines[0].syllables;
  assert(s[0].startMs === 1000, `split: piece 1 ← 1000 (got ${s[0].startMs})`);
  assert(s[1].startMs === 2000, `split: piece 2 ← 2000, cascades (got ${s[1].startMs})`);
  assert(s[2].startMs === null, `split: last "мир" is untimed (got ${s[2].startMs})`);
}

// Scenario 2: split into three — last two become untimed.
// Old: [караоке(0), песня(3000)]  →  New: [ка, ра, о, ке, песня]
// Positional: ка←0, ра←3000, о→null, ке→null, песня→null.
{
  const oldLines = makeLines([[['караоке', 0], ['песня', 3000]]]);
  const newLines = makeLines([[['ка', null], ['ра', null], ['о', null], ['ке', null], ['песня', null]]]);
  mergeTimings(oldLines, newLines);
  const s = newLines[0].syllables;
  assert(s[0].startMs === 0, `3-split: piece 1 ← 0`);
  assert(s[1].startMs === 3000, `3-split: piece 2 ← 3000`);
  assert(s[2].startMs === null && s[3].startMs === null && s[4].startMs === null, '3-split: extras untimed');
}

// Scenario 3: no change — timings preserved exactly.
{
  const oldLines = makeLines([[['а', 100], ['б', 200], ['в', 300]]]);
  const newLines = makeLines([[['а', null], ['б', null], ['в', null]]]);
  mergeTimings(oldLines, newLines);
  const s = newLines[0].syllables;
  assert(s[0].startMs === 100 && s[1].startMs === 200 && s[2].startMs === 300, 'no-change: timings preserved');
}

// Scenario 4: delete a syllable — positional: new[1] ("в") gets old[1] ("б").
{
  const oldLines = makeLines([[['а', 100], ['б', 200], ['в', 300]]]);
  const newLines = makeLines([[['а', null], ['в', null]]]);
  mergeTimings(oldLines, newLines);
  const s = newLines[0].syllables;
  assert(s[0].startMs === 100, 'delete: new[0] ← 100');
  assert(s[1].startMs === 200, `delete: new[1] ← 200 (positional, got ${s[1].startMs})`);
}

// Scenario 5: insert a syllable in the middle — same as split, last falls off.
// Old: [а(100), в(300)]  →  New: [а, б, в]
// Positional: а←100, б←300, в→null.
{
  const oldLines = makeLines([[['а', 100], ['в', 300]]]);
  const newLines = makeLines([[['а', null], ['б', null], ['в', null]]]);
  mergeTimings(oldLines, newLines);
  const s = newLines[0].syllables;
  assert(s[0].startMs === 100, 'insert: new[0] ← 100');
  assert(s[1].startMs === 300, `insert: new[1] ← 300 (got ${s[1].startMs})`);
  assert(s[2].startMs === null, 'insert: last untimed');
}

// Scenario 6: edit a letter — timing preserved (same position).
{
  const oldLines = makeLines([[['Привет', 1000], ['мир', 2000]]]);
  const newLines = makeLines([[['Приве', null], ['мир', null]]]); // letter deleted
  mergeTimings(oldLines, newLines);
  const s = newLines[0].syllables;
  assert(s[0].startMs === 1000, `edit: timing kept despite text change (got ${s[0].startMs})`);
  assert(s[1].startMs === 2000, 'edit: next unaffected');
}

// Scenario 7: add a letter — timing preserved.
{
  const oldLines = makeLines([[['ка', 500], ['ра', 600]]]);
  const newLines = makeLines([[['кат', null], ['ра', null]]]);
  mergeTimings(oldLines, newLines);
  assert(newLines[0].syllables[0].startMs === 500, 'edit: added-letter timing kept');
  assert(newLines[0].syllables[1].startMs === 600, 'edit: next unaffected');
}

// Scenario 8: the user's exact case — split shifts everything by one.
// Old: [а(100), б(200), в(300)]  →  New: [а1, а2, б, в] (split "а")
// Positional: а1←100, а2←200, б←300, в→null. The last one is untimed.
{
  const oldLines = makeLines([[['а', 100], ['б', 200], ['в', 300]]]);
  const newLines = makeLines([[['а1', null], ['а2', null], ['б', null], ['в', null]]]);
  mergeTimings(oldLines, newLines);
  const s = newLines[0].syllables;
  assert(s[0].startMs === 100, `user-case: а1 ← 100`);
  assert(s[1].startMs === 200, `user-case: а2 ← 200`);
  assert(s[2].startMs === 300, `user-case: б ← 300`);
  assert(s[3].startMs === null, `user-case: в (last) is untimed`);
}

// Scenario 9: multi-line — FLATTENED carry crosses line boundaries.
// Old flat: [раз(0), два(1000), три(2000)]  (3 syllables across 2 lines)
// New flat: [ра, з, два, три]  (4 syllables — split "раз")
// Carry: ра←0, з←1000, два←2000, три→null (last falls off).
{
  const oldLines = makeLines([
    [['раз', 0], ['два', 1000]],
    [['три', 2000]],
  ]);
  const newLines = makeLines([
    [['ра', null], ['з', null], ['два', null]],
    [['три', null]],
  ]);
  mergeTimings(oldLines, newLines);
  assert(newLines[0].syllables[0].startMs === 0, 'multiline: ра ← 0');
  assert(newLines[0].syllables[1].startMs === 1000, `multiline: з ← 1000 (crosses into "два"'s timing)`);
  assert(newLines[0].syllables[2].startMs === 2000, `multiline: два ← 2000 (crosses into "три"'s timing)`);
  assert(newLines[1].syllables[0].startMs === null, 'multiline: три (last) is untimed');
}

// Scenario 10: the user's exact case — split at end of a line, carry crosses
// into the NEXT line. This was the bug: per-line merge missed the cross-line carry.
{
  const oldLines = makeLines([
    [['isolation', 2500]],
    [['All', 3000], ['this', 3500], ['devastation', 4000]],
  ]);
  const newLines = makeLines([
    [['i', null], ['solation', null]],  // split "isolation"
    [['All', null], ['this', null], ['devastation', null]],
  ]);
  mergeTimings(oldLines, newLines);
  // Flat old: [isolation(2500), All(3000), this(3500), devastation(4000)]
  // Flat new: [i, solation, All, this, devastation]
  // Carry: i←2500, solation←3000, All←3500, this←4000, devastation→null
  assert(newLines[0].syllables[0].startMs === 2500, `cross-line: i ← 2500`);
  assert(newLines[0].syllables[1].startMs === 3000, `cross-line: solation ← 3000 (from "All" on next line)`);
  assert(newLines[1].syllables[0].startMs === 3500, `cross-line: All ← 3500`);
  assert(newLines[1].syllables[1].startMs === 4000, `cross-line: this ← 4000`);
  assert(newLines[1].syllables[2].startMs === null, `cross-line: devastation (last) untimed`);
}

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
if (failures > 0) process.exit(1);
if (failures > 0) process.exit(1);
