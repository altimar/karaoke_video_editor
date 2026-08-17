/**
 * Browser probe runner: loads the app page, injects the bundled probe entry,
 * feeds a real Kiri chunk to the clean fp32 / fp16 karaoke exports and:
 *  - reports WebGPU session.create + session.run timings for both,
 *  - reports the elementwise fp16-vs-fp32 mask diff,
 *  - dumps the estimated "Vocals" stem + the remainder for offline A/B
 *    against the reference dumps (kiri-{lead,back,minus}-ours.wav).
 *
 * Models are served by the dev server via public/local-models (→ kfn/).
 * Usage: node eval/run-karaoke-probe.mjs [--start 60]
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

execSync(
  'npx esbuild eval/karaoke-probe-entry.ts --bundle --format=iife --outfile=eval/_karaoke-probe-bundle.mjs',
  { stdio: 'inherit' },
);
const bundle = readFileSync('eval/_karaoke-probe-bundle.mjs', 'utf8');

const args = process.argv.slice(2);
const startSec = args.includes('--start') ? Number(args[args.indexOf('--start') + 1]) : 60;

const MODELS = [
  'http://localhost:5173/local-models/karaoke-clean-fp32-webgpu.onnx',
  'http://localhost:5173/local-models/karaoke-clean-fp16-webgpu.onnx',
];

const ORIGINAL = process.argv.includes('--audio') ? process.argv[process.argv.indexOf('--audio') + 1] : 'kfn/Monoral_-_Kiri_48050552.mp3';

function writeWav(path, L, R) {
  const n = Math.min(L.length, R.length);
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), i * 4);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), i * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVEfmt ', 8);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22);
  hdr.writeUInt32LE(44100, 24);
  hdr.writeUInt32LE(44100 * 4, 28);
  hdr.writeUInt16LE(4, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([hdr, data]));
}

const browser = await chromium.launch({
  headless: process.env.HEADLESS === '1',
  args: ['--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: bundle });

  const mp3 = readFileSync(ORIGINAL);
  console.log(`Probing @ ${startSec}s on ${ORIGINAL} (${(mp3.length / 1e6).toFixed(1)} MB)…`);
  const res = await page.evaluate(
    ([urls, b64, start]) => (window).__probe(urls, b64, start),
    [MODELS, mp3.toString('base64'), startSec],
  );

  writeWav(`kfn/probe-${startSec}-mix-chunk.wav`, res.chunks.L, res.chunks.R);
  for (const s of res.stems) {
    const tag = s.url.includes('fp16') ? 'fp16' : 'fp32';
    if (!s.ok) {
      console.log(`${tag}: FAILED — ${s.error}`);
      continue;
    }
    console.log(`${tag}: out=${JSON.stringify(s.outShape)} run=${s.ms.toFixed(0)}ms (median of 3)`);
    writeWav(`kfn/probe-${startSec}-${tag}-vocalest.wav`, s.stemL, s.stemR);
    const n = Math.min(s.stemL.length, res.chunks.L.length);
    const restL = new Float32Array(n);
    const restR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      restL[i] = res.chunks.L[i] - s.stemL[i];
      restR[i] = res.chunks.R[i] - s.stemR[i];
    }
    writeWav(`kfn/probe-${startSec}-${tag}-rest.wav`, restL, restR);
  }
  console.log('mask diff fp16 vs fp32:', res.diff16);
} finally {
  await browser.close();
}
