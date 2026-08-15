// Does the "Backing Vocals" stem actually contain the sung lyrics?
// Decode it in the browser, compute RMS energy in 20ms frames, then compare
// mean energy AT the reference word onsets vs RANDOM offsets. A real vocal
// stem lights up at the words; backing-only/garbage does not.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reference = JSON.parse(readFileSync(join(__dirname, 'fixtures/kiri/reference.json'), 'utf8'));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:5173/');
await page.locator('[data-testid="track-head-back"]').click();
await page.locator('[data-testid="input-audio-load"]').setInputFiles({
  name: 'v.mp3', mimeType: 'audio/mpeg', buffer: readFileSync(join(__dirname, 'fixtures/kiri/vocal.mp3')),
});
await page.waitForFunction(() => window.__audioEngine && window.__audioEngine.getBuffer('back'), undefined, { timeout: 60000 });

const result = await page.evaluate((ref) => {
  const buf = window.__audioEngine.getBuffer('back');
  const ch = buf.getChannelData(0);
  const sr = buf.sampleRate;
  // RMS in 20ms frames.
  const frame = Math.round(sr * 0.02);
  const nFrames = Math.floor(ch.length / frame);
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) s += ch[i] * ch[i];
    rms[f] = Math.sqrt(s / frame);
  }
  const frameAt = (ms) => Math.max(0, Math.min(nFrames - 1, Math.floor((ms / 1000) / 0.02)));
  // Word onsets from the reference (first syllable of each word).
  const onsets = [];
  for (let i = 0; i < ref.length; i++) {
    if (ref[i].sep === ' ' || i === 0) onsets.push(ref[i].startMs);
  }
  // Mean RMS in [onset, onset+300ms] vs random windows of same length.
  const win = 15; // 15 frames = 300ms
  let onSum = 0, onN = 0;
  for (const ms of onsets) {
    const f0 = frameAt(ms);
    for (let k = 0; k < win; k++) { onSum += rms[Math.min(nFrames - 1, f0 + k)]; onN++; }
  }
  let rndSum = 0, rndN = 0;
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < onsets.length; i++) {
    const f0 = Math.floor(rnd() * (nFrames - win));
    for (let k = 0; k < win; k++) { rndSum += rms[f0 + k]; rndN++; }
  }
  // Overall loudness profile: RMS per 10s bucket (is it sparse like backing-only?).
  const bucket = 10 * 50;
  const profile = [];
  for (let b = 0; b * bucket < nFrames; b++) {
    let m = 0, c = 0;
    for (let f = b * bucket; f < Math.min(nFrames, (b + 1) * bucket); f++) { m += rms[f]; c++; }
    profile.push((m / c).toFixed(3));
  }
  return {
    durationSec: buf.duration.toFixed(0),
    words: onsets.length,
    rmsAtWordOnsets: (onSum / onN).toFixed(4),
    rmsAtRandom: (rndSum / rndN).toFixed(4),
    ratio: ((onSum / onN) / (rndSum / rndN)).toFixed(2),
    rmsPer10s: profile.join(' '),
  };
}, reference);
console.log(JSON.stringify(result, null, 2));
await browser.close();
