/**
 * Test KFN export + import round-trip, incl. multiple text tracks.
 */
import { test } from 'vitest';
import { exportToKfn } from '../src/lib/kfnExport';
import { importFromKfn } from '../src/lib/kfnImport';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

/** Build a style object with sane defaults merged over the given overrides. */
function style(over: Record<string, unknown> = {}) {
  return {
    fontFamily: 'Arial', fontSize: 64, fontWeight: 700, italic: false, lineHeight: 1.4,
    textAlign: 'center', colorBase: 'rgba(255,255,255,0.35)', colorHighlight: '#ffe14d',
    strokeWidth: 3, strokeColorActive: '#000', strokeColorInactive: '#010101', glowBlur: 24, glowColor: '#ff0',
    layout: 'scroller', ...over,
  };
}

/** A two-track project: scroller (main) + classic with an offset (alternate),
 *  plus the three fixed audio roles (minus/back loaded, original empty). */
function makeProject() {
  return {
    durationMs: 10000, fps: 30, width: 1920, height: 1080,
    background: { bgType: 'color', bgColor: '#000', bgColors: ['#000', '#111'], bgImageDataUrl: null },
    tracks: [
      {
        id: 't1',
        type: 'text', name: 'Основная',
        style: style({
          layout: 'scroller',
          colorHighlight: 'rgba(255,228,77,1)',
          colorBase: 'rgba(255,255,255,0.35)',
          strokeColorActive: 'rgba(10,20,30,0.9)',
          strokeColorInactive: 'rgba(5,5,5,0.7)',
        }),
        rendererSettings: { scroller: { previewSec: 10 } },
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
        id: 't2',
        type: 'text', name: 'Альтернативная',
        style: style({ layout: 'classic' }),
        rendererSettings: { classic: { lineSlots: 4, fadeMs: 1500, offsetX: 10, offsetY: 20 } },
        lines: [
          { syllables: [
            { text: 'Back', startMs: 3000, sep: '' },
            { text: 'ing', startMs: 3500, sep: ' ' },
          ]},
        ],
      },
      { id: 'a1', type: 'audio', name: 'Оригинал', role: 'original', audioFileName: '', volumeAutomation: [] },
      { id: 'a2', type: 'audio', name: 'Минус', role: 'minus', audioFileName: 'test-song.mp3', volumeAutomation: [] },
      { id: 'a3', type: 'audio', name: 'Бэк', role: 'back', audioFileName: 'back.mp3', volumeAutomation: [] },
    ],
    activeTrackId: 't1',
  } as any;
}
const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03, 0x04]);
/** Per-role audio bytes map (minus + back loaded) for export calls. */
const fakeAudioMap = new Map([
  ['minus', fakeAudio],
  ['back', new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00])],
]);

/** Parse a CSS color to {r,g,b,a}. Tolerant across #hex / rgba() forms. */
function parseCss(c: string) {
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
function closeRgb(a: string, b: string) {
  const pa = parseCss(a), pb = parseCss(b);
  return Math.abs(pa.r - pb.r) <= 2 && Math.abs(pa.g - pb.g) <= 2 && Math.abs(pa.b - pb.b) <= 2 && Math.abs(pa.a - pb.a) <= 0.02;
}

/** Parse a KFN blob into { entries, songIni } for white-box assertions. */
async function inspect(blob: Blob) {
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
  const raw: any[] = [];
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

test('export: directory layout + Effect fields for two tracks', async () => {
  const project = makeProject();
  const { blob, warnings } = await exportToKfn(project, fakeAudioMap);

  assert(blob instanceof Blob, 'export returns a Blob');
  assert(Array.isArray(warnings), 'export returns a warnings array');
  assert(warnings.length === 0, `no warnings for 2 tracks (got ${warnings.length})`);

  const { entries, songIni } = await inspect(blob);
  // minus (type 2) + back (type 2) + Song.ini (type 1).
  assert(entries.length === 3, `directory has 3 entries (got ${entries.length})`);
  assert(entries[0].type === 2, 'first entry is audio (type 2)');
  assert(entries[1].type === 2, 'second entry is back audio (type 2)');
  assert(entries[2].type === 1, 'third entry is Song.ini (type 1)');

  // EffectCount reflects the number of tracks.
  assert(songIni.includes('EffectCount=2'), 'EffectCount=2 for two tracks');

  // Track 1 (scroller) → Eff1, ID=1, with a Trajectory field.
  assert(/\[Eff1\]/.test(songIni), '[Eff1] section present');
  assert(/ID=1/.test(songIni), 'Eff1 ID=1');
  assert(/Trajectory=PlainBottomToTop/.test(songIni), 'scroller track writes PlainBottomToTop trajectory');
  // previewSec=10 → Trajectory param 1.0 (10s / 10s base).
  assert(/Trajectory=PlainBottomToTop\*1\.0/.test(songIni), `Trajectory param=1.0 for previewSec=10 (got ${/Trajectory=[^\r\n]+/.exec(songIni)?.[0]})`);
  assert(songIni.includes('Text0=Hel/lo world'), 'Eff1 Text0 correct');
  assert(songIni.includes('Sync0=0,50,100'), 'Eff1 Sync0 in centiseconds');
  assert(/Caption=Основная/.test(songIni), `Eff1 writes Caption=track name (got ${/Caption=.+/.exec(songIni)?.[0]})`);

  // Scroller track (Eff1) writes OffsetZ=30 — KaraFun's standard perspective depth.
  // OffsetZ=0 would make the text huge in KaraFun Studio.
  assert(/OffsetZ=30/.test(songIni.split('[Eff2]')[0]), 'scroller writes OffsetZ=30 (KaraFun default)');

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
});

test('import round-trip: tracks, lyrics, filenames, settings', async () => {
  const project = makeProject();
  const { blob } = await exportToKfn(project, fakeAudioMap);
  const imported = importFromKfn(new Uint8Array(await blob.arrayBuffer()));

  // minus bytes round-trip via [General] Source.
  assert(imported.audioByRole.has('minus'), 'minus audio imported');
  assert(imported.audioByRole.get('minus')!.length === fakeAudio.length, `minus bytes length matches (${imported.audioByRole.get('minus')!.length})`);
  // back bytes round-trip via [MP3Music] Track0.
  assert(imported.audioByRole.has('back'), 'back audio imported');

  const it = imported.project.tracks as any[];
  // 2 text tracks + 4 audio roles (original empty, lead empty, minus, back).
  assert(it.length === 6, `6 tracks imported (2 text + 4 audio) (got ${it.length})`);
  const minusTrack = it.find((t) => t.type === 'audio' && t.role === 'minus');
  assert(minusTrack && minusTrack.audioFileName === 'test-song.mp3', `minus track keeps filename (got "${minusTrack?.audioFileName}")`);
  const backTrack = it.find((t) => t.type === 'audio' && t.role === 'back');
  assert(backTrack && backTrack.audioFileName === 'back.mp3', `back track keeps filename (got "${backTrack?.audioFileName}")`);

  // Track 1: scroller, lyrics round-trip.
  const s0 = it[0].lines.flatMap((l: any) => l.syllables);
  assert(it[0].style.layout === 'scroller', `track 1 layout is scroller (got ${it[0].style.layout})`);
  assert(it[0].name === 'Основная', `track 1 name preserved (got "${it[0].name}")`);
  assert(s0.length === 5, `track 1: 5 syllables (got ${s0.length})`);
  assert(s0[0].text === 'Hel' && s0[0].startMs === 0, 'track 1 syl 0: "Hel" @0ms');
  assert(s0[2].text === 'world' && s0[2].startMs === 1000, 'track 1 syl 2: "world" @1000ms');

  // Track 2: classic, with lineSlots + offset preserved.
  const s1 = it[1].lines.flatMap((l: any) => l.syllables);
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
});

test('all four text colors round-trip (fill active/inactive + frame active/inactive)', async () => {
  const project = makeProject();
  const { blob } = await exportToKfn(project, fakeAudioMap);
  const { songIni } = await inspect(blob);
  const imported = importFromKfn(new Uint8Array(await blob.arrayBuffer()));
  const it = imported.project.tracks as any[];

  const orig = (project.tracks[0] as any).style;
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
});

test('FrameType ↔ strokeWidth mapping (non-default width 2)', async () => {
  const p = JSON.parse(JSON.stringify(makeProject()));
  p.tracks[1].style.strokeWidth = 2;
  const r = await exportToKfn(p, fakeAudioMap);
  const insp = await inspect(r.blob);
  // Track 2 is the SECOND effect ([Eff2]) in a two-track project.
  const eff2 = insp.songIni.split('[Eff2]')[1] ?? '';
  assert(/FrameType=Frame2/.test(eff2), `track 2 FrameType=Frame2 for strokeWidth 2 (got ${/FrameType=.+/.exec(eff2)?.[0]})`);
});

test('FrameType clamps to KaraFun max (Frame5) and warns when exceeded', async () => {
  const p = JSON.parse(JSON.stringify(makeProject()));
  p.tracks[0].style.strokeWidth = 10; // beyond KaraFun's max of 5
  const r = await exportToKfn(p, fakeAudioMap);
  const insp = await inspect(r.blob);
  const eff1 = insp.songIni.split('[Eff2]')[0];
  assert(/FrameType=Frame5/.test(eff1), `strokeWidth 10 clamped to Frame5 (got ${/FrameType=.+/.exec(eff1)?.[0]})`);
  assert(r.warnings.length > 0, `strokeWidth > 5 produces a warning (got ${r.warnings.length})`);
  assert(/толщина обводки 10/.test(r.warnings.join(' ')), 'warning mentions the clamped stroke width');
});

test('>2 tracks produces a warning', async () => {
  const p = makeProject();
  p.tracks.push({
    id: 't3',
    type: 'text', name: 'Третья',
    style: style({ layout: 'scroller' }),
    rendererSettings: { scroller: { previewSec: 10 } },
    lines: [{ syllables: [{ text: 'Extra', startMs: 4000, sep: '' }] }],
  } as any);
  const res = await exportToKfn(p, fakeAudioMap);
  assert(res.warnings.length > 0, `3 tracks produce a warning (got ${res.warnings.length})`);
  assert(/максимум 2/.test(res.warnings.join(' ')), 'warning mentions the 2-track KaraFun limit');
});

test('background image round-trip (ID=51 effect + type=3 container file)', async () => {
  const p = JSON.parse(JSON.stringify(makeProject()));
  // A tiny 1×1 red PNG as a data URL.
  const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  p.background = { bgType: 'image', bgColor: '#000', bgColors: ['#000', '#111'], bgImageDataUrl: `data:image/png;base64,${RED_PNG_B64}` };
  const r = await exportToKfn(p, fakeAudioMap);
  const insp = await inspect(r.blob);
  // Directory: minus (type 2) + back (type 2) + image (type 3) + Song.ini (type 1).
  assert(insp.entries.length === 4, `4 directory entries with background (got ${insp.entries.length})`);
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
  const bg = imported.project.background as any;
  assert(bg.bgType === 'image', `imported background is an image (got ${bg.bgType})`);
  assert(bg.bgImageDataUrl === `data:image/png;base64,${RED_PNG_B64}`, 'imported background data URL matches');
});

test('no background → no image entry, no ID=51 effect', async () => {
  const r = await exportToKfn(makeProject(), fakeAudioMap);
  const insp = await inspect(r.blob);
  // minus (type 2) + back (type 2) + Song.ini (type 1), no image.
  assert(insp.entries.length === 3, `3 entries without background (got ${insp.entries.length})`);
  assert(!insp.entries.some((e: any) => e.type === 3), 'no type=3 entry without a background image');
  assert(!/ID=51/.test(insp.songIni), 'no ID=51 effect without a background image');
});

test('lead (guide vocal) round-trips via [MP3Music] TrackN by type', async () => {
  // KaraFun stores the guide/lead vocal as an [MP3Music] track with type 0
  // (verified on a KaraFun-saved file), the backing vocal as type 2.
  const p = JSON.parse(JSON.stringify(makeProject()));
  p.tracks.push({ id: 'a4', type: 'audio', name: 'Вокал', role: 'lead', audioFileName: 'lead vocal (1).mp3', volumeAutomation: [] });
  const leadBytes = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
  const map = new Map(fakeAudioMap);
  map.set('lead', leadBytes);

  const r = await exportToKfn(p, map);
  const insp = await inspect(r.blob);
  // Directory: minus + lead + back (all type 2) + Song.ini.
  assert(insp.entries.length === 4, `4 entries with lead (got ${insp.entries.length})`);
  assert(insp.entries.some((e: any) => e.name === 'lead vocal (1).mp3' && e.type === 2), 'lead audio embedded as its own type=2 file (name with spaces)');
  // Track0 = lead (type 0), Track1 = back (type 2) — same line shape as KaraFun's own files.
  assert(/NumTracks=2/.test(insp.songIni), `NumTracks=2 (got ${/NumTracks=.+/.exec(insp.songIni)?.[0]})`);
  assert(/Track0=lead vocal \(1\)\.mp3,0,0,,/.test(insp.songIni), `Track0 is the guide vocal type 0 (got ${/Track0=[^\r\n]+/.exec(insp.songIni)?.[0]})`);
  assert(/Track1=back\.mp3,2,0,,/.test(insp.songIni), `Track1 is the back vocal type 2 (got ${/Track1=[^\r\n]+/.exec(insp.songIni)?.[0]})`);

  const imported = importFromKfn(new Uint8Array(await r.blob.arrayBuffer()));
  assert(imported.audioByRole.has('lead'), 'lead audio imported');
  const gotLead = imported.audioByRole.get('lead')!;
  assert(gotLead.length === leadBytes.length && gotLead.every((b: number, i: number) => b === leadBytes[i]), 'lead bytes round-trip intact');
  const it = imported.project.tracks as any[];
  const leadTrack = it.find((t) => t.type === 'audio' && t.role === 'lead');
  assert(leadTrack && leadTrack.audioFileName === 'lead vocal (1).mp3', `lead track keeps filename (got "${leadTrack?.audioFileName}")`);
  // Back is still imported alongside the lead.
  assert(imported.audioByRole.has('back'), 'back audio still imported with lead present');
});

test('video background → ID=62 effect + type=5 entry with the full MP4 bytes', async () => {
  const p = JSON.parse(JSON.stringify(makeProject()));
  p.background.bgType = 'video';
  p.background.bgVideoFileName = 'clip.mp4';
  const mp4 = new Uint8Array(1000).fill(0x66);
  const r = await exportToKfn(p, fakeAudioMap, { bgVideoBytes: mp4 });

  const insp = await inspect(r.blob);
  // minus + back + video (type 5) + Song.ini.
  assert(insp.entries.length === 4, `4 entries with video bg (got ${insp.entries.length})`);
  const vidEntry = insp.entries.find((e: any) => e.type === 5);
  assert(!!vidEntry, 'video stored as a type=5 file');
  assert(/^background\.(mp4|.*)$/.test(vidEntry?.name ?? ''), `video entry name from filename (got "${vidEntry?.name}")`);
  assert(vidEntry?.inLen === mp4.length, `video bytes embedded in full (got ${vidEntry?.inLen}, want ${mp4.length})`);

  // ID=62 effect written BEFORE the text effects, referencing the file.
  const eff1 = insp.songIni.split('[Eff2]')[0];
  assert(/ID=62/.test(eff1), 'background video effect ID=62 written');
  assert(new RegExp(`VideoFile=${vidEntry?.name}`).test(eff1), `VideoFile references the embedded file (got ${/VideoFile=.+/.exec(eff1)?.[0]})`);
  assert(/PlayAtStart=1/.test(eff1), 'ID=62 PlayAtStart=1');
  assert(/LoopVideo=0/.test(eff1), 'ID=62 LoopVideo=0 (no looping — trim/fallback is on our side)');
  assert(/EffectCount=3/.test(insp.songIni), `EffectCount includes the video effect (got ${/EffectCount=.+/.exec(insp.songIni)?.[0]})`);

  // The mp4-KFN caveat is surfaced as a warning.
  assert(r.warnings.some((w: string) => /MP4/.test(w)), 'warning about MP4 not being officially supported by KaraFun');
});

test('video background WITHOUT bytes → no ID=62 effect, no type=5 entry', async () => {
  const p = JSON.parse(JSON.stringify(makeProject()));
  p.background.bgType = 'video';
  p.background.bgVideoFileName = 'clip.mp4';
  // no bgVideoBytes passed
  const r = await exportToKfn(p, fakeAudioMap);
  const insp = await inspect(r.blob);
  assert(insp.entries.length === 3, `3 entries (no video embedded) (got ${insp.entries.length})`);
  assert(!insp.entries.some((e: any) => e.type === 5), 'no type=5 entry without bytes');
  assert(!/ID=62/.test(insp.songIni), 'no ID=62 effect without bytes');
});
