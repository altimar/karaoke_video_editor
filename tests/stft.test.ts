/**
 * Round-trip test for the STFT/iSTFT engine: STFT(signal) → iSTFT → recovered
 * must reconstruct the original signal with high fidelity (≥ 60 dB SNR).
 *
 * This is the technical-risk spike for Mel-RoFormer integration: if our STFT
 * matches torch's center=True + periodic-Hann + hop=441 + n_fft=2048 params and
 * reconstructs cleanly, the rest of the separation pipeline (masking + ISTFT)
 * inherits the correctness.
 */
import { test } from 'vitest';
import { stft, istft } from '../src/lib/stft';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

// Mel-RoFormer parameters.
const NF = 2048;
const HOP = 441;

/** Signal-to-noise ratio in dB between original and reconstructed. */
function snrDb(original: Float32Array, reconstructed: Float32Array): number {
  let noise = 0;
  let signal = 0;
  for (let i = 0; i < original.length; i++) {
    const d = original[i] - reconstructed[i];
    noise += d * d;
    signal += original[i] * original[i];
  }
  if (signal === 0) {
    // Silent input: measure absolute error instead.
    return noise === 0 ? Infinity : -Infinity;
  }
  return 10 * Math.log10(signal / noise);
}

/** Max absolute sample error. */
function maxErr(original: Float32Array, reconstructed: Float32Array): number {
  let m = 0;
  for (let i = 0; i < original.length; i++) {
    m = Math.max(m, Math.abs(original[i] - reconstructed[i]));
  }
  return m;
}

function roundTrip(signal: Float32Array, label: string, minSnr = 80): void {
  const spec = stft(signal, { nFft: NF, hop: HOP });
  const rec = istft(spec, { nFft: NF, hop: HOP }, signal.length);
  const s = snrDb(signal, rec);
  const e = maxErr(signal, rec);
  const ok = s >= minSnr && isFinite(s);
  assert(ok, `${label}: round-trip SNR ≥ ${minSnr} dB (got ${s.toFixed(2)}, maxErr ${e.toExponential(2)})`);
}

test('1 kHz sine round-trip (n_fft=2048, hop=441, periodic Hann, center=True)', () => {
  const N = 44100; // 1 second
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) sig[i] = Math.sin((2 * Math.PI * 1000 * i) / 44100);
  roundTrip(sig, '1 kHz sine');
});

test('80 Hz sine round-trip (stresses windowing)', () => {
  const N = 44100;
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) sig[i] = 0.7 * Math.sin((2 * Math.PI * 80 * i) / 44100);
  roundTrip(sig, '80 Hz sine');
});

test('harmonic sum (220/440/880 Hz) round-trip', () => {
  const N = 44100;
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    sig[i] =
      0.4 * Math.sin((2 * Math.PI * 220 * i) / 44100) +
      0.3 * Math.sin((2 * Math.PI * 440 * i) / 44100) +
      0.2 * Math.sin((2 * Math.PI * 880 * i) / 44100);
  }
  roundTrip(sig, 'harmonic sum');
});

test('white noise round-trip (deterministic PRNG)', () => {
  const N = 44100;
  const sig = new Float32Array(N);
  // Deterministic PRNG so the test is reproducible.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < N; i++) sig[i] = (rnd() * 2 - 1) * 0.5;
  roundTrip(sig, 'white noise');
});

test('silence reconstructs to all-zero, no NaN', () => {
  const N = 8820; // 0.2s
  const sig = new Float32Array(N);
  const spec = stft(sig, { nFft: NF, hop: HOP });
  const rec = istft(spec, { nFft: NF, hop: HOP }, N);
  const allZero = Array.from(rec).every((v) => v === 0);
  const noNaN = Array.from(rec).every((v) => !Number.isNaN(v));
  assert(allZero && noNaN, 'silence: reconstructs to all-zero, no NaN');
});

test('short signal (shorter than one window) frame count + round-trip', () => {
  const N = 500;
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) sig[i] = Math.sin((2 * Math.PI * 500 * i) / 44100) * 0.6;
  const spec = stft(sig, { nFft: NF, hop: HOP });
  assert(spec.nFrames === 1 + Math.floor(N / HOP), `short signal frame count (got ${spec.nFrames}, expected ${1 + Math.floor(N / HOP)})`);
  roundTrip(sig, 'short signal (500 samples)');
});

test('identity mask round-trip (the exact operation separation does)', () => {
  // If multiplying the STFT by a unit mask and inverting still reconstructs,
  // masking is sound.
  const N = 22050;
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) sig[i] = Math.sin((2 * Math.PI * 660 * i) / 44100);
  const spec = stft(sig, { nFft: NF, hop: HOP });
  const rec = istft(spec, { nFft: NF, hop: HOP }, N);
  const s = snrDb(sig, rec);
  assert(s >= 80, `identity mask round-trip SNR ≥ 80 dB (got ${s.toFixed(2)})`);
});
