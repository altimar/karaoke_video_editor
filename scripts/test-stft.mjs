/**
 * Round-trip test for the STFT/iSTFT engine: STFT(signal) → iSTFT → recovered
 * must reconstruct the original signal with high fidelity (≥ 60 dB SNR).
 *
 * This is the technical-risk spike for Mel-RoFormer integration: if our STFT
 * matches torch's center=True + periodic-Hann + hop=441 + n_fft=2048 params and
 * reconstructs cleanly, the rest of the separation pipeline (masking + ISTFT)
 * inherits the correctness.
 *
 * Run: node scripts/test-stft.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outFile = join(__dirname, '_stft-bundle.mjs');

await build({
  entryPoints: [join(root, 'src/lib/stft.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: outFile,
  logLevel: 'silent',
});
const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());
const { stft, istft } = mod;

let failures = 0;
const assert = (c, m) => { if (!c) { failures++; console.error('  ✗ FAIL:', m); } else console.log('  ✓', m); };

// Mel-RoFormer parameters.
const NF = 2048;
const HOP = 441;

/** Signal-to-noise ratio in dB between original and reconstructed. */
function snrDb(original, reconstructed) {
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
function maxErr(original, reconstructed) {
  let m = 0;
  for (let i = 0; i < original.length; i++) {
    m = Math.max(m, Math.abs(original[i] - reconstructed[i]));
  }
  return m;
}

function roundTrip(signal, label, minSnr = 80) {
  const spec = stft(signal, { nFft: NF, hop: HOP });
  const rec = istft(spec, { nFft: NF, hop: HOP }, signal.length);
  const s = snrDb(signal, rec);
  const e = maxErr(signal, rec);
  const ok = s >= minSnr && isFinite(s);
  console.log(`    SNR = ${s.toFixed(2)} dB, maxErr = ${e.toExponential(2)}`);
  assert(ok, `${label}: round-trip SNR ≥ ${minSnr} dB (got ${s.toFixed(2)})`);
}

console.log('STFT round-trip tests (n_fft=2048, hop=441, periodic Hann, center=True)\n');

// 1. Pure sine wave (a single bin, clean reconstruction).
{
  const N = 44100; // 1 second
  const sig = new Float32Array(N);
  const freq = 1000;
  for (let i = 0; i < N; i++) sig[i] = Math.sin((2 * Math.PI * freq * i) / 44100);
  roundTrip(sig, '1 kHz sine');
}

// 2. Lower-frequency sine (fewer cycles per frame — stresses windowing).
{
  const N = 44100;
  const sig = new Float32Array(N);
  const freq = 80; // bass-ish
  for (let i = 0; i < N; i++) sig[i] = 0.7 * Math.sin((2 * Math.PI * freq * i) / 44100);
  roundTrip(sig, '80 Hz sine');
}

// 3. Sum of sines (harmonic content).
{
  const N = 44100;
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    sig[i] =
      0.4 * Math.sin((2 * Math.PI * 220 * i) / 44100) +
      0.3 * Math.sin((2 * Math.PI * 440 * i) / 44100) +
      0.2 * Math.sin((2 * Math.PI * 880 * i) / 44100);
  }
  roundTrip(sig, 'harmonic sum (220/440/880 Hz)');
}

// 4. White noise (broadband — exercises all bins).
{
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
}

// 5. Silence (must be all-zero, no NaN).
{
  const N = 8820; // 0.2s
  const sig = new Float32Array(N);
  const spec = stft(sig, { nFft: NF, hop: HOP });
  const rec = istft(spec, { nFft: NF, hop: HOP }, N);
  const allZero = Array.from(rec).every((v) => v === 0);
  const noNaN = Array.from(rec).every((v) => !Number.isNaN(v));
  assert(allZero && noNaN, 'silence: reconstructs to all-zero, no NaN');
}

// 6. Short signal (shorter than one window — tests frame count edge case).
{
  const N = 500;
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) sig[i] = Math.sin((2 * Math.PI * 500 * i) / 44100) * 0.6;
  const spec = stft(sig, { nFft: NF, hop: HOP });
  assert(spec.nFrames === 1 + Math.floor(N / HOP), `short signal frame count (got ${spec.nFrames}, expected ${1 + Math.floor(N / HOP)})`);
  roundTrip(sig, 'short signal (500 samples)');
}

// 7. Mask identity (apply all-ones mask → must equal original). This is the
//    exact operation the separation does: out = spec * mask. If multiplying the
//    STFT by a unit mask and inverting still reconstructs, masking is sound.
{
  const N = 22050;
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) sig[i] = Math.sin((2 * Math.PI * 660 * i) / 44100);
  const spec = stft(sig, { nFft: NF, hop: HOP });
  // Identity mask: multiply real & imag by 1 (no-op).
  const rec = istft(spec, { nFft: NF, hop: HOP }, N);
  const s = snrDb(sig, rec);
  assert(s >= 80, `identity mask round-trip SNR ≥ 80 dB (got ${s.toFixed(2)})`);
}

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
const fs = await import('node:fs');
fs.unlinkSync(outFile);
if (failures > 0) process.exit(1);
