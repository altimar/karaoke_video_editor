/**
 * Test KFN export + import round-trip, incl. multiple text tracks.
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

/** Build a style object with sane defaults merged over the given overrides. */
function style(over = {}) {
  return {
    fontFamily: 'Arial', fontSize: 64, fontWeight: 700, lineHeight: 1.4,
    textAlign: 'center', colorBase: 'rgba(255,255,255,0.35)', colorHighlight: '#ffe14d',
    strokeWidth: 3, strokeColorActive: '#000', strokeColorInactive: '#010101', glowBlur: 24, glowColor: '#ff0',
    layout: 'scroller', ...over,
  };
}

/** A two-track project: scroller (main) + classic with an offset (alternate). */
function makeProject() {
  return {
    audioFileName: 'test-song.mp3', durationMs: 10000, fps: 30, width: 1920, height: 1080,
    showWaveform: true,
    background: { bgType: 'color', bgColor: '#000', bgColors: ['#000', '#111'], bgImageDataUrl: null },
    tracks: [
      {
        id: 't1', name: 'Основная',
        style: style({
          layout: 'scroller',
          colorHighlight: 'rgba(255,228,77,1)',
          colorBase: 'rgba(255,255,255,0.35)',
          strokeColorActive: 'rgba(10,20,30,0.9)',
          strokeColorInactive: 'rgba(5,5,5,0.7)',
        }),
        rendererSettings: { scroller: { visibleLines: 8 } },
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
      },
      {
        id: 't2', name: 'Альтернативная',
        style: style({ layout: 'classic' }),
        rendererSettings: { classic: { lineSlots: 4, fadeMs: 1500, offsetX: 10, offsetY: 20 } },
        lines: [
          { syllables: [
            { text: 'Back', startMs: 3000, sep: '' },
            { text: 'ing', startMs: 3500, sep: ' ' },
          ]},
        ],
      },
    ],
    activeTrackId: 't1',
  };
}
const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03, 0x04]);

/** Parse a CSS color to {r,g,b,a}. Tolerant across #hex / rgba() forms. */
function parseCss(c) {
  c = (c ?? '').trim();
  const rgba = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,]+([\d.]+))?\s*\)/i.exec(c);
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] !== undefined ? +rgba[4] : 1 };
  if (c.startsWith('#')) {
    let h = c.slice(1);
    let a = 1;
    if (h.length === 8) { a = parseInt(h.slice(6, 8), 16) / 255; h = h.slice(0, 6); }
    else if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}
/** Compare two CSS colors allowing for small rounding in the alpha channel. */
function closeRgb(a, b) {
  const pa = parseCss(a), pb = parseCss(b);
  return Math.abs(pa.r - pb.r) <= 2 && Math.abs(pa.g - pb.g) <= 2 && Math.abs(pa.b - pb.b) <= 2 && Math.abs(pa.a - pb.a) <= 0.02;
}

/** Parse a KFN blob into { entries, songIni } for white-box assertions. */
async function inspect(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  let pos = 4; // skip KFNB magic
  // Header: iterate ID3-style blocks until ENDH.
  while (pos + 9 <= buf.length) {
    const name = dec.decode(buf.slice(pos, pos + 4)); pos += 4;
    const dt = buf[pos]; pos += 1;
    const val = dv.getUint32(pos, true); pos += 4;
    if (dt === 2) pos += val; // skip string payload
    if (name === 'ENDH') break;
  }
  const fc = dv.getUint32(pos, true); pos += 4;
  const raw = [];
  for (let i = 0; i < fc; i++) {
    const nl = dv.getUint32(pos, true); pos += 4;
    const nm = dec.decode(buf.slice(pos, pos + nl)); pos += nl;
    const tp = dv.getUint32(pos, true), ol = dv.getUint32(pos + 4, true), of = dv.getUint32(pos + 8, true), il = dv.getUint32(pos + 12, true), fl = dv.getUint32(pos + 16, true);
    pos += 20;
    raw.push({ name: nm, type: tp, outLen: ol, offset: of, inLen: il, flags: fl, absOff: 0 });
  }
  const dirEnd = pos;
  for (const e of raw) e.absOff = dirEnd + e.offset;
  const ini = raw.find((e) => e.type === 1);
  const songIni = ini ? dec.decode(buf.slice(ini.absOff, ini.absOff + ini.inLen)) : '';
  return { entries: raw, songIni };
}

console.log('KFN export + import tests\n');

// === Export (two tracks) ===
const project = makeProject();
const { blob, warnings } = await exportToKfn(project, fakeAudio);

assert(blob instanceof Blob, 'export returns a Blob');
assert(Array.isArray(warnings), 'export returns a warnings array');
assert(warnings.length === 0, `no warnings for 2 tracks (got ${warnings.length})`);

const { entries, songIni } = await inspect(blob);
assert(entries.length === 2, `directory has 2 entries (got ${entries.length})`);
assert(entries[0].type === 2, 'first entry is audio (type 2)');
assert(entries[1].type === 1, 'second entry is Song.ini (type 1)');

// EffectCount reflects the number of tracks.
assert(songIni.includes('EffectCount=2'), 'EffectCount=2 for two tracks');

// Track 1 (scroller) → Eff1, ID=1, with a Trajectory field.
assert(/\[Eff1\]/.test(songIni), '[Eff1] section present');
assert(/ID=1/.test(songIni), 'Eff1 ID=1');
assert(/Trajectory=PlainBottomToTop/.test(songIni), 'scroller track writes PlainBottomToTop trajectory');
assert(songIni.includes('Text0=Hel/lo world'), 'Eff1 Text0 correct');
assert(songIni.includes('Sync0=0,50,100'), 'Eff1 Sync0 in centiseconds');
assert(/Caption=Основная/.test(songIni), `Eff1 writes Caption=track name (got ${/Caption=.+/.exec(songIni)?.[0]})`);

// Track 2 (classic) → Eff2, ID=2, with LineCount + offsets, NO Trajectory, NO OffsetZ.
const eff2 = songIni.split('[Eff2]')[1] ?? '';
assert(eff2 !== '', '[Eff2] section present');
assert(/ID=2/.test(eff2), 'Eff2 ID=2');
assert(/Caption=Альтернативная/.test(eff2), `Eff2 writes Caption=track name (got ${/Caption=.+/.exec(eff2)?.[0]})`);
assert(/LineCount=4/.test(eff2), 'classic writes LineCount=4');
assert(/OffsetX=10/.test(eff2), 'classic writes OffsetX=10');
assert(/OffsetY=20/.test(eff2), 'classic writes OffsetY=20');
assert(!/Trajectory=/.test(eff2), 'classic track has no Trajectory');
assert(!/OffsetZ=/.test(eff2), 'classic track has no OffsetZ');
assert(eff2.includes('Text0=Back ing'), 'Eff2 Text0 correct');
assert(/Sync0=300,350/.test(eff2), 'Eff2 Sync0 in centiseconds (local to effect)');

// Scroller track (Eff1) writes OffsetZ=30 — KaraFun's standard perspective depth.
// OffsetZ=0 would make the text huge in KaraFun Studio.
const eff1Body = songIni.split('[Eff1]')[1] ?? '';
assert(/OffsetZ=30/.test(eff1Body), 'scroller writes OffsetZ=30 (KaraFun default)');

// === Import round-trip ===
const imported = importFromKfn(new Uint8Array(await blob.arrayBuffer()));
assert(imported.project.audioFileName === 'test-song.mp3', `audio filename preserved: "${imported.project.audioFileName}"`);
assert(imported.audioBytes.length === fakeAudio.length, `audio bytes length matches (${imported.audioBytes.length})`);

const it = imported.project.tracks;
assert(it.length === 2, `2 tracks imported (got ${it.length})`);

// Track 1: scroller, lyrics round-trip.
const s0 = it[0].lines.flatMap(l => l.syllables);
assert(it[0].style.layout === 'scroller', `track 1 layout is scroller (got ${it[0].style.layout})`);
assert(it[0].name === 'Основная', `track 1 name preserved (got "${it[0].name}")`);
assert(s0.length === 5, `track 1: 5 syllables (got ${s0.length})`);
assert(s0[0].text === 'Hel' && s0[0].startMs === 0, 'track 1 syl 0: "Hel" @0ms');
assert(s0[2].text === 'world' && s0[2].startMs === 1000, 'track 1 syl 2: "world" @1000ms');

// Track 2: classic, with lineSlots + offset preserved.
const s1 = it[1].lines.flatMap(l => l.syllables);
assert(it[1].name === 'Альтернативная', `track 2 name preserved (got "${it[1].name}")`);
assert(it[1].style.layout === 'classic', `track 2 layout is classic (got ${it[1].style.layout})`);
assert(s1.length === 2, `track 2: 2 syllables (got ${s1.length})`);
assert(s1[0].text === 'Back' && s1[0].startMs === 3000, 'track 2 syl 0: "Back" @3000ms');
assert(s1[1].text === 'ing' && s1[1].startMs === 3500, 'track 2 syl 1: "ing" @3500ms');
const c = it[1].rendererSettings.classic;
assert(c && c.lineSlots === 4, `track 2 classic lineSlots=4 (got ${c?.lineSlots})`);
assert(c && c.offsetX === 10, `track 2 classic offsetX=10 (got ${c?.offsetX})`);
assert(c && c.offsetY === 20, `track 2 classic offsetY=20 (got ${c?.offsetY})`);

// Our extra effects with no KFN equivalent (glow) start DISABLED on import, so
// the track doesn't inherit unrelated project defaults.
assert(it[0].style.glowBlur === 0, `imported track glow is OFF (got ${it[0].style.glowBlur})`);

// === Round-trip of all four text colors (fill active/inactive + frame active/inactive) ===
// Track 1 has distinct colors with alpha; verify they survive export → import.
{
  const orig = project.tracks[0].style;
  // Exported #RRGGBBAA fields for track 1 (alpha is the LAST byte, not first).
  const eff1 = songIni.split('[Eff2]')[0]; // everything up to the second effect
  assert(eff1.includes('ActiveColor=#FFE44DFF'), `ActiveColor round-trips fill active (got ${/ActiveColor=.+/.exec(eff1)?.[0]})`);
  assert(eff1.includes('InactiveColor=#FFFFFF59'), `InactiveColor round-trips fill inactive w/ alpha (got ${/InactiveColor=.+/.exec(eff1)?.[0]})`);
  assert(eff1.includes('FrameColor=#0A141EE6'), `FrameColor round-trips stroke active w/ alpha (got ${/FrameColor=.+/.exec(eff1)?.[0]})`);
  assert(eff1.includes('InactiveFrameColor=#050505B3'), `InactiveFrameColor round-trips stroke inactive w/ alpha (got ${/InactiveFrameColor=.+/.exec(eff1)?.[0]})`);
  // FrameType encodes stroke width (Frame1=1, Frame2=2, …).
  assert(eff1.includes('FrameType=Frame3'), `FrameType encodes strokeWidth (got ${/FrameType=.+/.exec(eff1)?.[0]})`);
  // Imported back: the four CSS colors are restored (within rounding).
  const s0 = it[0].style;
  assert(closeRgb(s0.colorHighlight, orig.colorHighlight), 'fill active color restored on import');
  assert(closeRgb(s0.colorBase, orig.colorBase), 'fill inactive color restored on import');
  assert(closeRgb(s0.strokeColorActive, orig.strokeColorActive), 'stroke active color restored on import');
  assert(closeRgb(s0.strokeColorInactive, orig.strokeColorInactive), 'stroke inactive color restored on import');
  assert(s0.strokeWidth === 3, `strokeWidth restored from FrameType (got ${s0.strokeWidth})`);
}

// === FrameType ↔ strokeWidth mapping (track 2 uses a non-default width) ===
// Track 2 default style has strokeWidth 3; override to 2 and verify round-trip.
await (async () => {
  const p = JSON.parse(JSON.stringify(project));
  p.tracks[1].style.strokeWidth = 2;
  const r = await exportToKfn(p, fakeAudio);
  const insp = await inspect(r.blob);
  // Track 2 is the SECOND effect ([Eff2]) in a two-track project.
  const eff2 = insp.songIni.split('[Eff2]')[1] ?? '';
  assert(/FrameType=Frame2/.test(eff2), `track 2 FrameType=Frame2 for strokeWidth 2 (got ${/FrameType=.+/.exec(eff2)?.[0]})`);
})();

// === FrameType clamps to KaraFun's max (Frame5) and warns when exceeded ===
await (async () => {
  const p = JSON.parse(JSON.stringify(project));
  p.tracks[0].style.strokeWidth = 10; // beyond KaraFun's max of 5
  const r = await exportToKfn(p, fakeAudio);
  const insp = await inspect(r.blob);
  const eff1 = insp.songIni.split('[Eff2]')[0];
  assert(/FrameType=Frame5/.test(eff1), `strokeWidth 10 clamped to Frame5 (got ${/FrameType=.+/.exec(eff1)?.[0]})`);
  assert(r.warnings.length > 0, `strokeWidth > 5 produces a warning (got ${r.warnings.length})`);
  assert(/толщина обводки 10/.test(r.warnings.join(' ')), 'warning mentions the clamped stroke width');
})();

// === >2 tracks produces a warning ===
await (async () => {
  const p = makeProject();
  p.tracks.push({
    id: 't3', name: 'Третья',
    style: style({ layout: 'scroller' }),
    rendererSettings: { scroller: { visibleLines: 8 } },
    lines: [{ syllables: [{ text: 'Extra', startMs: 4000, sep: '' }] }],
  });
  const res = await exportToKfn(p, fakeAudio);
  assert(res.warnings.length > 0, `3 tracks produce a warning (got ${res.warnings.length})`);
  assert(/максимум 2/.test(res.warnings.join(' ')), 'warning mentions the 2-track KaraFun limit');
})();

// === Background image round-trip (ID=51 effect + type=3 container file) ===
await (async () => {
  const p = JSON.parse(JSON.stringify(project));
  // A tiny 1×1 red PNG as a data URL.
  const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  p.background = { bgType: 'image', bgColor: '#000', bgColors: ['#000', '#111'], bgImageDataUrl: `data:image/png;base64,${RED_PNG_B64}` };
  const r = await exportToKfn(p, fakeAudio);
  const insp = await inspect(r.blob);
  // Directory: audio + image (type 3) + Song.ini.
  assert(insp.entries.length === 3, `3 directory entries with background (got ${insp.entries.length})`);
  const imgEntry = insp.entries.find((e) => e.type === 3);
  assert(!!imgEntry, 'background image stored as a type=3 file');
  assert(/background\.png/.test(imgEntry?.name ?? ''), `image filename is background.png (got "${imgEntry?.name}")`);
  // Song.ini has an ID=51 effect BEFORE the text effects, referencing the image.
  const eff1 = insp.songIni.split('[Eff2]')[0];
  assert(/ID=51/.test(eff1), 'background effect ID=51 written');
  assert(/LibImage=background\.png/.test(eff1), `LibImage references the image file (got ${/LibImage=.+/.exec(eff1)?.[0]})`);
  assert(/EffectCount=3/.test(insp.songIni), `EffectCount includes background (got ${/EffectCount=.+/.exec(insp.songIni)?.[0]})`);
  // Imported back: the background is restored as an image with the same bytes.
  const imported = importFromKfn(new Uint8Array(await r.blob.arrayBuffer()));
  const bg = imported.project.background;
  assert(bg.bgType === 'image', `imported background is an image (got ${bg.bgType})`);
  assert(bg.bgImageDataUrl === `data:image/png;base64,${RED_PNG_B64}`, `imported background data URL matches`);
})();

// === No background → no image entry, no ID=51 effect (default project) ===
await (async () => {
  const r = await exportToKfn(project, fakeAudio);
  const insp = await inspect(r.blob);
  assert(insp.entries.length === 2, `2 entries without background (got ${insp.entries.length})`);
  assert(!insp.entries.some((e) => e.type === 3), 'no type=3 entry without a background image');
  assert(!/ID=51/.test(insp.songIni), 'no ID=51 effect without a background image');
})();

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
unlinkSync(outFile);
unlinkSync(entryFile);
if (failures > 0) process.exit(1);
