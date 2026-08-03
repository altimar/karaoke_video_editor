/**
 * Test KFN export + import round-trip.
 * Run: node scripts/test-kfn.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outFile = join(__dirname, '_kfn-bundle.mjs');

// Bundle both export and import modules.
const entryFile = join(__dirname, '_kfn-entry.ts');
import { writeFileSync } from 'node:fs';
writeFileSync(entryFile,
  `export { exportToKfn } from '${root.replace(/\\/g,'/')}/src/lib/kfnExport';\n` +
  `export { importFromKfn } from '${root.replace(/\\/g,'/')}/src/lib/kfnImport';\n`);

await build({ entryPoints: [entryFile], bundle: true, format: 'esm', platform: 'neutral', outfile: outFile, logLevel: 'silent' });
const { exportToKfn, importFromKfn } = await import(pathToFileURL(outFile).href + '?' + Date.now());

let failures = 0;
const assert = (c, m) => { if (!c) { failures++; console.error('  ✗ FAIL:', m); } else console.log('  ✓', m); };

const project = {
  audioFileName: 'test-song.mp3', durationMs: 10000, fps: 30, width: 1920, height: 1080,
  showWaveform: true, rendererSettings: {},
  style: { fontFamily: 'Arial', fontSize: 64, fontWeight: 700, lineHeight: 1.4,
    textAlign: 'center', colorBase: '#fff', colorHighlight: '#ffe14d',
    strokeWidth: 3, strokeColor: '#000', glowBlur: 24, glowColor: '#ff0',
    bgType: 'color', bgColor: '#000', bgColors: ['#000','#111'], bgImageDataUrl: null, layout: 'scroller' },
  lines: [
    { syllables: [
      { text: 'Hel', startMs: 0, sep: '' },
      { text: 'lo', startMs: 500, sep: '/' },
      { text: 'world', startMs: 1000, sep: ' ' },
    ]},
    { syllables: [
      { text: 'Test', startMs: 2000, sep: '' },
      { text: 'line', startMs: 2500, sep: ' ' },
    ]},
  ],
};
const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03, 0x04]);

console.log('KFN export + import tests\n');

// === Export ===
const blob = exportToKfn(project, fakeAudio);
const buf = new Uint8Array(await blob.arrayBuffer());

assert(buf[0] === 0x4b && buf[1] === 0x46 && buf[2] === 0x4e && buf[3] === 0x42, 'starts with KFNB magic');

// Parse to verify structure.
const dv = new DataView(buf.buffer);
let pos = 4;
while (pos < buf.length) {
  const name = String.fromCharCode(...buf.slice(pos, pos+4)); pos += 4;
  const dt = buf[pos]; pos++;
  const val = dv.getUint32(pos, true); pos += 4;
  if (dt === 2) pos += val;
  if (name === 'ENDH') break;
}
const fc = dv.getUint32(pos, true); pos += 4;
const rawEntries = [];
for (let i = 0; i < fc; i++) {
  const nl = dv.getUint32(pos, true); pos += 4;
  const nm = new TextDecoder().decode(buf.slice(pos, pos+nl)); pos += nl;
  const tp = dv.getUint32(pos,true), ol = dv.getUint32(pos+4,true), of = dv.getUint32(pos+8,true), il = dv.getUint32(pos+12,true), fl = dv.getUint32(pos+16,true);
  pos += 20;
  rawEntries.push({ name: nm, type: tp, outLen: ol, offset: of, inLen: il, flags: fl });
}
const dirEnd = pos;
// Compute abs offsets
for (const e of rawEntries) e.absOff = dirEnd + e.offset;

assert(rawEntries.length === 2, `directory has 2 entries (got ${rawEntries.length})`);
assert(rawEntries[0].type === 2, 'first entry is audio (type 2)');
assert(rawEntries[1].type === 1, 'second entry is Song.ini (type 1)');

// Audio bytes preserved
const audioData = buf.slice(rawEntries[0].absOff, rawEntries[0].absOff + rawEntries[0].inLen);
assert(audioData[0] === 0xff && audioData[1] === 0xfb, 'audio data bytes preserved');

// Song.ini content
const songData = new TextDecoder().decode(buf.slice(rawEntries[1].absOff, rawEntries[1].absOff + rawEntries[1].inLen));
assert(songData.includes('Text0=Hel/lo world'), `Text0 correct`);
assert(songData.includes('Sync0=0,50,100'), `Sync0 in centiseconds`);
assert(songData.includes('TextCount=2'), `TextCount=2`);

// === Import round-trip ===
const imported = importFromKfn(buf);
assert(imported.project.audioFileName === 'test-song.mp3', `audio filename preserved: "${imported.project.audioFileName}"`);
assert(imported.audioBytes.length === fakeAudio.length, `audio bytes length matches (${imported.audioBytes.length})`);

// Check lyrics round-trip
const syls = imported.project.lines.flatMap(l => l.syllables);
assert(syls.length === 5, `5 syllables imported (got ${syls.length})`);
assert(syls[0].text === 'Hel' && syls[0].startMs === 0, `syllable 0: "Hel" at 0ms`);
assert(syls[1].text === 'lo' && syls[1].startMs === 500, `syllable 1: "lo" at 500ms`);
assert(syls[2].text === 'world' && syls[2].startMs === 1000, `syllable 2: "world" at 1000ms`);
assert(syls[3].text === 'Test' && syls[3].startMs === 2000, `syllable 3: "Test" at 2000ms`);
assert(syls[4].text === 'line' && syls[4].startMs === 2500, `syllable 4: "line" at 2500ms`);

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
unlinkSync(outFile);
unlinkSync(entryFile);
if (failures > 0) process.exit(1);
