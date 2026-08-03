/**
 * Tests for waveform peak computation.
 * Run: node scripts/test-waveform.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outFile = join(__dirname, '_waveform-bundle.mjs');

await build({
  entryPoints: [join(root, 'src/lib/waveform.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: outFile,
  logLevel: 'silent',
});
const { computePeaks } = await import(pathToFileURL(outFile).href + '?t=' + Date.now());

let failures = 0;
const assert = (c, m) => { if (!c) { failures++; console.error('  ✗ FAIL:', m); } else console.log('  ✓', m); };

/** Minimal AudioBuffer mock with getChannelData(i). */
function mockBuffer(samples) {
  return {
    getChannelData: (i) => (i === 0 ? samples : new Float32Array(0)),
    numberOfChannels: 1,
    length: samples.length,
    duration: samples.length / 44100,
    sampleRate: 44100,
  };
}

console.log('Waveform peak tests\n');

// Silence -> all-zero peaks, no NaN.
{
  const buf = mockBuffer(new Float32Array(44100).fill(0));
  const { peaks, max } = computePeaks(buf, 100);
  assert(peaks.length === 100, `returns requested bucket count (got ${peaks.length})`);
  assert(max === 0, 'silence: max amplitude is 0');
  assert(Array.from(peaks).every((p) => p === 0), 'silence: all peaks are 0 (no NaN)');
}

// A single loud sample in the middle -> its bucket peaks at 1.0 (normalized),
// others stay low.
{
  const samples = new Float32Array(1000);
  samples[500] = 0.5; // the only signal
  const buf = mockBuffer(samples);
  const { peaks } = computePeaks(buf, 10); // 100 samples per bucket
  const loudBucket = peaks[5]; // bucket 5 covers samples 500..599
  assert(loudBucket === 1, `loudest bucket normalized to 1.0 (got ${loudBucket})`);
  assert(peaks[0] === 0, 'empty bucket is 0');
}

// Normalization: amplitudes scale so the loudest reaches 1.0.
{
  const samples = new Float32Array(200);
  samples[0] = 0.25;
  samples[100] = 0.1;
  const buf = mockBuffer(samples);
  const { peaks } = computePeaks(buf, 2); // 100 samples per bucket
  assert(peaks[0] === 1, `bucket with 0.25 normalized to 1.0 (got ${peaks[0]})`);
  assert(Math.abs(peaks[1] - 0.4) < 1e-6, `0.1 relative to 0.25 => 0.4 (got ${peaks[1]})`);
}

// All values within [0, 1].
{
  const samples = new Float32Array(2000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.1) * 0.8;
  const buf = mockBuffer(samples);
  const { peaks } = computePeaks(buf, 50);
  assert(peaks.every((p) => p >= 0 && p <= 1.0001), 'all peaks within [0, 1]');
  assert(Math.max(...Array.from(peaks)) === 1, 'max peak reaches 1.0 after normalization');
}

// Caching: same buffer + buckets returns the identical object (no recompute).
{
  const buf = mockBuffer(new Float32Array(100).fill(0.3));
  const a = computePeaks(buf, 10);
  const b = computePeaks(buf, 10);
  assert(a === b, 'cached result is returned by identity');
}

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
const fs = await import('node:fs');
fs.unlinkSync(outFile);
if (failures > 0) process.exit(1);
