/**
 * Tests for waveform peak computation.
 */
import { test } from 'vitest';
import { computePeaks } from '../src/lib/waveform';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

/** Minimal AudioBuffer mock with getChannelData(i). */
function mockBuffer(samples: Float32Array) {
  return {
    getChannelData: (i: number) => (i === 0 ? samples : new Float32Array(0)),
    numberOfChannels: 1,
    length: samples.length,
    duration: samples.length / 44100,
    sampleRate: 44100,
  };
}

test('silence → all-zero peaks, no NaN', () => {
  const buf = mockBuffer(new Float32Array(44100).fill(0));
  const { peaks, max } = computePeaks(buf, 100);
  assert(peaks.length === 100, `returns requested bucket count (got ${peaks.length})`);
  assert(max === 0, 'silence: max amplitude is 0');
  assert(Array.from(peaks).every((p) => p === 0), 'silence: all peaks are 0 (no NaN)');
});

test('a single loud sample peaks its bucket at 1.0 (normalized)', () => {
  const samples = new Float32Array(1000);
  samples[500] = 0.5; // the only signal
  const buf = mockBuffer(samples);
  const { peaks } = computePeaks(buf, 10); // 100 samples per bucket
  const loudBucket = peaks[5]; // bucket 5 covers samples 500..599
  assert(loudBucket === 1, `loudest bucket normalized to 1.0 (got ${loudBucket})`);
  assert(peaks[0] === 0, 'empty bucket is 0');
});

test('normalization: the loudest reaches 1.0', () => {
  const samples = new Float32Array(200);
  samples[0] = 0.25;
  samples[100] = 0.1;
  const buf = mockBuffer(samples);
  const { peaks } = computePeaks(buf, 2); // 100 samples per bucket
  assert(peaks[0] === 1, `bucket with 0.25 normalized to 1.0 (got ${peaks[0]})`);
  assert(Math.abs(peaks[1] - 0.4) < 1e-6, `0.1 relative to 0.25 => 0.4 (got ${peaks[1]})`);
});

test('all peaks within [0, 1] and max reaches 1.0', () => {
  const samples = new Float32Array(2000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.1) * 0.8;
  const buf = mockBuffer(samples);
  const { peaks } = computePeaks(buf, 50);
  assert(peaks.every((p) => p >= 0 && p <= 1.0001), 'all peaks within [0, 1]');
  assert(Math.max(...Array.from(peaks)) === 1, 'max peak reaches 1.0 after normalization');
});

test('caching: same buffer + buckets returns the identical object', () => {
  const buf = mockBuffer(new Float32Array(100).fill(0.3));
  const a = computePeaks(buf, 10);
  const b = computePeaks(buf, 10);
  assert(a === b, 'cached result is returned by identity');
});
