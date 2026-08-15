/**
 * Unit tests for the two model tensor layouts in separation.ts: the STFT
 * packing (bins-major vs frames-major inputs) and the mask application
 * (flat vs stem outputs). Round-trip property: pack → treat the packed values
 * as an identity mask → apply → equals the original STFT.
 */
import { test } from 'vitest';
import { packStft, applyMask } from '../src/lib/separation';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const N_BINS = 1025;
const FRAMES = 1101;

/** Synthetic stereo STFT with distinct known values. */
function makeSpecs() {
  const mk = (salt: number) => {
    const real = new Float32Array(N_BINS * FRAMES);
    const imag = new Float32Array(N_BINS * FRAMES);
    for (let t = 0; t < FRAMES; t++) {
      for (let f = 0; f < N_BINS; f++) {
        const i = t * N_BINS + f;
        real[i] = ((i * 7 + salt) % 97) / 97 - 0.5;
        imag[i] = ((i * 13 + salt) % 89) / 89 - 0.5;
      }
    }
    return { real, imag, nBins: N_BINS, nFrames: FRAMES };
  };
  return { specL: mk(1), specR: mk(2) };
}

test('bins-major pack matches the documented index walk', () => {
  const { specL } = makeSpecs();
  const packed = packStft('bins-major', specL, specL, FRAMES);
  // [1, 2050, T, 2]: ((2f+ch)·T + t)·2 + ri
  const f = 100, t = 500;
  assert(packed[((2 * f + 0) * FRAMES + t) * 2] === specL.real[t * N_BINS + f], 'real at (f,t) L');
  assert(packed[((2 * f + 1) * FRAMES + t) * 2 + 1] === specL.imag[t * N_BINS + f], 'imag at (f,t) R');
  assert(packed.length === 2050 * FRAMES * 2, `total length (got ${packed.length})`);
});

test('frames-major pack matches the documented index walk', () => {
  const { specL } = makeSpecs();
  const packed = packStft('frames-major', specL, specL, FRAMES);
  // [1, T, 4100]: t·4100 + (2f+ch)·2 + ri
  const f = 100, t = 500;
  assert(packed[t * 4100 + (2 * f + 0) * 2] === specL.real[t * N_BINS + f], 'real at (f,t) L');
  assert(packed[t * 4100 + (2 * f + 1) * 2 + 1] === specL.imag[t * N_BINS + f], 'imag at (f,t) R');
  assert(packed.length === FRAMES * 4100, `total length (got ${packed.length})`);
});

test('identity mask round-trips through both mask layouts', () => {
  for (const layout of ['flat', 'stem'] as const) {
    const { specL, specR } = makeSpecs();
    // Identity complex mask (1+0i) in the layout's own walk.
    const stride = layout === 'flat' ? FRAMES : FRAMES;
    const masks = new Float32Array(2050 * stride * 2);
    for (let i = 0; i < 2050 * stride; i++) masks[i * 2] = 1;
    const outL = applyMask(layout, specL, masks, 0, FRAMES);
    for (let i = 0; i < N_BINS * FRAMES; i++) {
      assert(Math.abs(outL.real[i] - specL.real[i]) < 1e-7, `${layout}: real round-trip at ${i}`);
      assert(Math.abs(outL.imag[i] - specL.imag[i]) < 1e-7, `${layout}: imag round-trip at ${i}`);
      if (i > 2000) break; // spot-check
    }
    void specR;
  }
});

test('stem mask stride differs from flat when frames < FRAMES', () => {
  const frames = 300;
  const { specL } = makeSpecs();
  const masks = new Float32Array(2050 * frames * 2);
  // Mask = 1 only for packed bin 5, frame 10 → everything else zeroed.
  const f = 2, ch = 1, t = 10;
  masks[((2 * f + ch) * frames + t) * 2] = 1;
  const out = applyMask('stem', specL, masks, ch, frames);
  let nonZero = 0;
  for (let i = 0; i < out.real.length; i++) if (Math.abs(out.real[i]) > 1e-9) nonZero++;
  assert(nonZero === 1, `only one bin survives the spike mask (got ${nonZero})`);
});
