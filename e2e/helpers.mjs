/**
 * Node-side fixture builders for the Playwright E2E tests.
 *
 * Everything here works with raw bytes only (no app imports) except the KFN
 * parser, which is bundled from src/lib/kfnImport.ts via esbuild — the same
 * trick the unit tests (scripts/test-*.mjs) use — so the downloaded .kfn can
 * be verified with the real importer.
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { zipSync, unzipSync, strFromU8 } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/**
 * Synthesize a mono 16-bit PCM WAV (44-byte canonical header) of the given
 * length — a 440 Hz sine at low amplitude. Sample rate 22050 keeps files
 * small; duration is what the tests assert on, not fidelity.
 */
export function makeWavBytes(seconds, sampleRate = 22050) {
  const numFrames = Math.round(seconds * sampleRate);
  const dataSize = numFrames * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const wstr = (o, s) => {
    for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < numFrames; i++) {
    dv.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000), true);
  }
  return new Uint8Array(buf);
}

/**
 * Build a .karaokeproject ZIP in the format src/lib/projectFile.ts reads:
 * project.json + audio/minus.wav (level 0, like the app's own saves).
 * `wavSeconds` of audio in the minus role; the JSON's durationMs matches.
 */
export function makeProjectZip(wavSeconds = 30) {
  const wav = makeWavBytes(wavSeconds);
  const project = {
    durationMs: Math.round(wavSeconds * 1000),
    fps: 30,
    width: 1920,
    height: 1080,
    background: { bgType: 'color', bgColor: '#0e0f1a', bgColors: ['#000', '#111'], bgImageDataUrl: null },
    activeTrackId: 't1',
    tracks: [
      {
        id: 't1',
        type: 'text',
        name: 'Дорожка 1',
        style: {
          fontFamily: 'Arial',
          fontSize: 64,
          fontWeight: 700,
          lineHeight: 1.4,
          textAlign: 'center',
          colorBase: '#fff',
          colorHighlight: '#ffe14d',
          strokeWidth: 3,
          strokeColorActive: '#000',
          strokeColorInactive: '#010101',
          glowBlur: 0,
          glowColor: '#ff0',
          layout: 'scroller',
        },
        rendererSettings: {},
        lines: [{ syllables: [{ text: 'ла', startMs: 500, sep: '' }, { text: 'ла', startMs: 900, sep: '' }] }],
      },
      { id: 'a1', type: 'audio', name: 'Оригинал', role: 'original', audioFileName: '', volumeAutomation: [], muted: false, solo: false },
      { id: 'a2', type: 'audio', name: 'Вокал', role: 'lead', audioFileName: '', volumeAutomation: [], muted: false, solo: false },
      { id: 'a3', type: 'audio', name: 'Минус', role: 'minus', audioFileName: 'song.wav', volumeAutomation: [], muted: false, solo: false },
      { id: 'a4', type: 'audio', name: 'Бэк', role: 'back', audioFileName: '', volumeAutomation: [], muted: false, solo: false },
    ],
  };
  const files = {
    'project.json': new TextEncoder().encode(JSON.stringify(project)),
    'audio/minus.wav': wav,
  };
  return { bytes: zipSync(files, { level: 0 }), wav };
}

/** Unzip a downloaded .karaokeproject and return { project, audioByRole } (mirrors loadProject). */
export function readProjectZip(bytes) {
  const unzipped = unzipSync(new Uint8Array(bytes));
  const project = JSON.parse(strFromU8(unzipped['project.json']));
  const audioByRole = new Map();
  for (const name of Object.keys(unzipped)) {
    if (name.startsWith('audio/')) audioByRole.set(name.slice('audio/'.length).split('.')[0], unzipped[name]);
  }
  return { project, audioByRole };
}

let kfnImportPromise = null;

/** Bundle one app module (TS) into an importable ESM file, cached per process. */
async function bundleModule(entryFile, outFile, exportLine) {
  writeFileSync(entryFile, exportLine);
  await build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: outFile,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outFile).href + '?' + Date.now());
  rmSync(entryFile, { force: true });
  return mod;
}

/**
 * Get the app's real KFN importer (bundled from TS via esbuild, cached for
 * the process). Returns the module's importFromKfn().
 */
export function getKfnImporter() {
  if (!kfnImportPromise) {
    kfnImportPromise = bundleModule(
      join(__dirname, '_kfnimport-entry.ts'),
      join(__dirname, '_kfnimport-bundle.mjs'),
      `export { importFromKfn } from '${root.replace(/\\/g, '/')}/src/lib/kfnImport';\n`,
    ).then((mod) => mod.importFromKfn);
  }
  return kfnImportPromise;
}

let kfnExporterPromise = null;

function getKfnExporter() {
  if (!kfnExporterPromise) {
    kfnExporterPromise = bundleModule(
      join(__dirname, '_kfnexport-entry.ts'),
      join(__dirname, '_kfnexport-bundle.mjs'),
      `export { exportToKfn } from '${root.replace(/\\/g, '/')}/src/lib/kfnExport';\n`,
    ).then((mod) => mod.exportToKfn);
  }
  return kfnExporterPromise;
}

/**
 * Generate a .kfn container with the app's own exporter (bundled from TS):
 * one text track with a timed syllable + `wavSeconds` of WAV in the minus
 * role. Used when the repo's real sample (kfn/, gitignored) is absent — e.g.
 * in CI.
 */
export async function makeKfnBytes(wavSeconds = 30) {
  const exportToKfn = await getKfnExporter();
  const wav = makeWavBytes(wavSeconds);
  const proj = {
    durationMs: wavSeconds * 1000,
    fps: 30,
    width: 1920,
    height: 1080,
    background: { bgType: 'color', bgColor: '#0e0f1a', bgColors: ['#000', '#111'], bgImageDataUrl: null },
    activeTrackId: 't1',
    tracks: [
      {
        id: 't1',
        type: 'text',
        name: 'Дорожка 1',
        style: {
          fontFamily: 'Arial',
          fontSize: 64,
          fontWeight: 700,
          lineHeight: 1.4,
          textAlign: 'center',
          colorBase: '#fff',
          colorHighlight: '#ffe14d',
          strokeWidth: 3,
          strokeColorActive: '#000',
          strokeColorInactive: '#010101',
          glowBlur: 0,
          glowColor: '#ff0',
          layout: 'scroller',
        },
        rendererSettings: { scroller: { previewSec: 10 } },
        lines: [{ syllables: [{ text: 'ла', startMs: 500, sep: '' }, { text: 'ла', startMs: 900, sep: '' }] }],
      },
      { id: 'a1', type: 'audio', name: 'Оригинал', role: 'original', audioFileName: '', volumeAutomation: [], muted: false, solo: false },
      { id: 'a2', type: 'audio', name: 'Вокал', role: 'lead', audioFileName: '', volumeAutomation: [], muted: false, solo: false },
      { id: 'a3', type: 'audio', name: 'Минус', role: 'minus', audioFileName: 'song.wav', volumeAutomation: [], muted: false, solo: false },
      { id: 'a4', type: 'audio', name: 'Бэк', role: 'back', audioFileName: '', volumeAutomation: [], muted: false, solo: false },
    ],
  };
  const audioByRole = new Map([['minus', wav]]);
  const { blob } = await exportToKfn(proj, audioByRole);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Path to the real .kfn sample shipped in the repo, if present (gitignored). */
export function sampleKfnPath() {
  const p = join(root, 'kfn', 'Klahr & KEV - Dreaming wild.kfn');
  return existsSync(p) ? p : null;
}

/** Read a downloaded file into Uint8Array. */
export function readBytes(filePath) {
  return new Uint8Array(readFileSync(filePath));
}
