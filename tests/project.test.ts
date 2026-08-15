/**
 * Test .karaokeproject save/load round-trip (ZIP container via fflate).
 */
import { test } from 'vitest';
import { saveProject, loadProject } from '../src/lib/projectFile';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

// A project with audio + image background + two tracks.
const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const project = {
  durationMs: 10000,
  fps: 30,
  width: 1920,
  height: 1080,
  background: { bgType: 'image', bgColor: '#000', bgColors: ['#000', '#111'], bgImageDataUrl: `data:image/png;base64,${RED_PNG_B64}` },
  tracks: [
    {
      id: 't1',
      type: 'text', name: 'Lead',
      style: { fontFamily: 'Arial', fontSize: 64, fontWeight: 700, lineHeight: 1.4, textAlign: 'center', colorBase: '#fff', colorHighlight: '#ffe14d', strokeWidth: 3, strokeColorActive: '#000', strokeColorInactive: '#010101', glowBlur: 0, glowColor: '#ff0', layout: 'scroller' },
      rendererSettings: { scroller: { visibleLines: 8 } },
      lines: [{ syllables: [{ text: 'Hi', startMs: 0, sep: '' }] }],
    },
    {
      id: 't2',
      type: 'text', name: 'Backing',
      style: { fontFamily: 'Arial', fontSize: 48, fontWeight: 700, lineHeight: 1.4, textAlign: 'center', colorBase: '#fff', colorHighlight: '#ff0000', strokeWidth: 2, strokeColorActive: '#000', strokeColorInactive: '#000', glowBlur: 0, glowColor: '#ff0', layout: 'classic' },
      rendererSettings: { classic: { lineSlots: 4, fadeMs: 1500, offsetX: 10, offsetY: 20 } },
      lines: [{ syllables: [{ text: 'Yo', startMs: 1000, sep: '' }] }],
    },
    { id: 'a1', type: 'audio', name: 'Оригинал', role: 'original', audioFileName: '', volumeAutomation: [] },
    { id: 'a2', type: 'audio', name: 'Вокал', role: 'lead', audioFileName: '', volumeAutomation: [] },
    { id: 'a3', type: 'audio', name: 'Минус', role: 'minus', audioFileName: 'song.mp3', volumeAutomation: [] },
    { id: 'a4', type: 'audio', name: 'Бэк', role: 'back', audioFileName: '', volumeAutomation: [] },
  ],
  activeTrackId: 't1',
};
const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03, 0x04]);
const fakeAudioMap = new Map([['minus', fakeAudio]]);

test('save returns a ZIP Blob with the expected filename', async () => {
  const { blob, filename } = saveProject(project, fakeAudioMap);
  assert(blob instanceof Blob, 'save returns a Blob');
  assert(filename === 'song.karaokeproject', `filename is song.karaokeproject (got ${filename})`);
  const buf = new Uint8Array(await blob.arrayBuffer());
  // The saved ZIP starts with the PK signature.
  assert(buf[0] === 0x50 && buf[1] === 0x4b, 'blob is a ZIP (PK signature)');
});

test('load round-trip preserves audio bytes, image, tracks and settings', async () => {
  const { blob } = saveProject(project, fakeAudioMap);
  const result = loadProject(new Uint8Array(await blob.arrayBuffer()));
  const p = result.project;

  assert(result.audioByRole.has('minus'), 'minus audio bytes extracted');
  assert(result.audioByRole.get('minus')!.length === fakeAudio.length, `minus bytes length matches (${result.audioByRole.get('minus')!.length})`);
  assert(!result.audioByRole.has('back'), 'back audio not present (was empty)');
  // Audio bytes content preserved.
  const minusBytes = result.audioByRole.get('minus')!;
  assert(minusBytes[0] === 0xff && minusBytes[1] === 0xfb, 'audio bytes content preserved');

  // Background image restored as a data URL (not a marker).
  assert(p.background.bgType === 'image', `bg type preserved (got ${p.background.bgType})`);
  assert(p.background.bgImageDataUrl === `data:image/png;base64,${RED_PNG_B64}`, 'bg image data URL restored from entry');

  // Tracks + settings preserved (2 text + 4 audio roles).
  assert(p.tracks.length === 6, `6 tracks preserved (got ${p.tracks.length})`);
  const backing = p.tracks.find((t: any) => t.name === 'Backing') as any;
  assert(!!backing, 'text track name preserved');
  const c = backing.rendererSettings.classic;
  assert(c && c.offsetX === 10 && c.offsetY === 20, `classic offset preserved (got ${JSON.stringify(c)})`);
});

test('no audio: still saves/loads, audioByRole is empty', async () => {
  const noAudio = JSON.parse(JSON.stringify(project));
  noAudio.tracks.find((t: any) => t.role === 'minus').audioFileName = '';
  const { blob: b2 } = saveProject(noAudio, new Map());
  const r2 = loadProject(new Uint8Array(await b2.arrayBuffer()));
  assert(r2.audioByRole.size === 0, 'no audio entries when nothing loaded');
  assert(r2.project.tracks.length === 6, 'tracks survive without audio');
});

test('no background image: bgImageDataUrl is null, no bg entry', async () => {
  const noBg = JSON.parse(JSON.stringify(project));
  noBg.background = { bgType: 'color', bgColor: '#0e0f1a', bgColors: ['#000', '#111'], bgImageDataUrl: null, bgVideoFileName: null };
  const { blob: b3 } = saveProject(noBg, fakeAudioMap);
  const r3 = loadProject(new Uint8Array(await b3.arrayBuffer()));
  assert(r3.project.background.bgImageDataUrl === null, 'no image → bgImageDataUrl null');
  assert(r3.project.background.bgType === 'color', 'bg type color preserved');
});

test('video background: bytes stored as background-video.<ext>, filename preserved', async () => {
  const withVideo = JSON.parse(JSON.stringify(project));
  withVideo.background = { ...withVideo.background, bgType: 'video', bgImageDataUrl: null, bgVideoFileName: 'концерт.mp4' };
  const mp4 = new Uint8Array(500).fill(0x61);
  const { blob } = saveProject(withVideo, new Map(), mp4);
  const r = loadProject(new Uint8Array(await blob.arrayBuffer()));

  // Bytes come back out-of-model (they belong to backgroundVideo.ts).
  assert(!!r.bgVideoBytes, 'bg video bytes extracted');
  assert(r.bgVideoBytes!.length === mp4.length, `bg video bytes in full (got ${r.bgVideoBytes?.length})`);
  assert(r.bgVideoBytes![0] === 0x61, 'bg video content preserved');
  // The user-facing filename survives (it's shown in the UI).
  assert(r.project.background.bgVideoFileName === 'концерт.mp4', `filename preserved (got "${r.project.background.bgVideoFileName}")`);
  assert(r.project.background.bgType === 'video', 'bg type video preserved');
});

test('video background: no bytes → reference dropped on save/load', async () => {
  const stale = JSON.parse(JSON.stringify(project));
  stale.background = { ...stale.background, bgType: 'video', bgImageDataUrl: null, bgVideoFileName: 'gone.mp4' };
  const { blob } = saveProject(stale, new Map(), null);
  const r = loadProject(new Uint8Array(await blob.arrayBuffer()));
  assert(r.bgVideoBytes === null, 'no bg video bytes');
  assert(r.project.background.bgVideoFileName === null, 'stale bgVideoFileName cleared');
});
