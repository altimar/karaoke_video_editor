/**
 * STFT / iSTFT engine for Mel-RoFormer host-side processing.
 *
 * Mel-RoFormer ONNX models (musetric/silverdaw) are "host-STFT" exports: the
 * graph takes a precomputed complex STFT tensor and returns per-bin complex
 * masks. The caller must compute the STFT itself, apply the masks, and invert.
 *
 * Parameters mirror `torch.stft(..., center=True)` as used upstream:
 *  - n_fft = 2048, hop = 441, win_length = n_fft (not specified → defaults to n_fft)
 *  - periodic Hann window (matches torch `hann_window(n_fft, periodic=True)`)
 *  - center=True: the signal is reflect-padded so frame t is centered at t*hop
 *  - output is complex (real + imag), one-sided (n_fft/2 + 1 = 1025 bins)
 *
 * The complex packing matches the model's expected tensor layout:
 *   [batch, freq * channels, frames, 2]  — last dim is [real, imag].
 */

/** A complex spectrogram: real and imaginary Float32Arrays, frame-major. */
export interface ComplexSTFT {
  /** Real part, length = nBins * nFrames. */
  real: Float32Array;
  /** Imaginary part, length = nBins * nFrames. */
  imag: Float32Array;
  /** Number of frequency bins (n_fft/2 + 1). */
  nBins: number;
  /** Number of time frames. */
  nFrames: number;
}

export interface STFTOptions {
  /** FFT size (window length). Mel-RoFormer uses 2048. */
  nFft: number;
  /** Hop length between frames. Mel-RoFormer uses 441. */
  hop: number;
}

/**
 * Iterative radix-2 Cooley-Tukey FFT, in place. `real`/`imag` are length-N
 * power-of-two arrays. Inverse via `inverse=true` (applies the 1/N scaling).
 *
 * Precomputed bit-reversal + twiddle factors are recomputed each call for
 * simplicity; for the separation hot loop this is negligible vs. the model run.
 */
export function fft(
  real: Float32Array,
  imag: Float32Array,
  inverse = false,
): void {
  const n = real.length;
  if (n <= 1) return;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  // Cooley-Tukey: combine butterflies of size 2, 4, 8, ... N.
  const sign = inverse ? 1 : -1; // forward = exp(-iωt), inverse = exp(+iωt)
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (sign * 2 * Math.PI) / len;
    const wReal = Math.cos(ang);
    const wImag = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < half; k++) {
        const aReal = real[i + k];
        const aImag = imag[i + k];
        const bReal = real[i + k + half];
        const bImag = imag[i + k + half];
        // t = w^k * b
        const tReal = curReal * bReal - curImag * bImag;
        const tImag = curReal * bImag + curImag * bReal;
        real[i + k] = aReal + tReal;
        imag[i + k] = aImag + tImag;
        real[i + k + half] = aReal - tReal;
        imag[i + k + half] = aImag - tImag;
        // advance w^k by one step (complex multiply)
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

/**
 * Periodic Hann window of length N (matches `torch.hann_window(N, periodic=True)`:
 * w[n] = 0.5 - 0.5*cos(2π n / N), n = 0..N-1). The periodic form differs from the
 * symmetric form (which uses N-1 in the denominator) — torch uses periodic for STFT.
 */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }
  return w;
}

/**
 * Compute the one-sided complex STFT of a mono signal.
 *
 * Mirrors `torch.stft(signal, n_fft, hop, hann_window, center=True)`:
 *  - The signal is reflect-padded by nFft/2 on each side so frame t covers
 *    [t*hop - nFft/2, t*hop + nFft/2]. This means nFrames = 1 + floor(N / hop).
 *  - Each frame is windowed and FFT'd; we keep the first nBins = nFft/2 + 1 bins.
 */
export function stft(signal: Float32Array, opts: STFTOptions): ComplexSTFT {
  const { nFft, hop } = opts;
  const nBins = nFft / 2 + 1;
  const window = hannWindow(nFft);
  const pad = nFft / 2;
  // reflect-pad: [a b c d e] -> [c b a b c d e d c] (mirror without repeating edge).
  // torch uses 'reflect' for center=True STFT padding.
  const paddedLen = signal.length + 2 * pad;
  const padded = new Float32Array(paddedLen);
  for (let i = 0; i < signal.length; i++) padded[pad + i] = signal[i];
  reflectPad(padded, pad);

  const nFrames = 1 + Math.floor(signal.length / hop);
  const real = new Float32Array(nBins * nFrames);
  const imag = new Float32Array(nBins * nFrames);

  const fr = new Float32Array(nFft);
  const fi = new Float32Array(nFft);
  for (let t = 0; t < nFrames; t++) {
    const start = t * hop;
    fr.fill(0);
    fi.fill(0);
    for (let i = 0; i < nFft; i++) fr[i] = padded[start + i] * window[i];
    fft(fr, fi, false);
    // Keep the first nBins (one-sided: bins 0..nFft/2).
    const off = t * nBins;
    for (let b = 0; b < nBins; b++) {
      real[off + b] = fr[b];
      imag[off + b] = fi[b];
    }
  }
  return { real, imag, nBins, nFrames };
}

/**
 * Inverse STFT via overlap-add with window-squared normalization.
 *
 * Mirrors `torch.istft(..., center=True)`: sums windowed frames at their hop
 * positions and divides by the accumulated window² (the COLA normalization for
 * reconstruction). Returns a signal of length `expectedLen`.
 *
 * `expectedLen` should be the original signal length (before the STFT padding).
 */
export function istft(
  spec: ComplexSTFT,
  opts: STFTOptions,
  expectedLen: number,
): Float32Array {
  const { nFft, hop } = opts;
  const { nBins, nFrames, real, imag } = spec;
  const window = hannWindow(nFft);
  const pad = nFft / 2;
  const paddedLen = expectedLen + 2 * pad;
  const out = new Float32Array(paddedLen);
  const norm = new Float32Array(paddedLen);

  const fr = new Float32Array(nFft);
  const fi = new Float32Array(nFft);
  for (let t = 0; t < nFrames; t++) {
    const off = t * nBins;
    // Reconstruct the full spectrum: bins 0..nBins-1 + the conjugate mirror.
    fr.fill(0);
    fi.fill(0);
    for (let b = 0; b < nBins; b++) {
      fr[b] = real[off + b];
      fi[b] = imag[off + b];
    }
    // Mirror bins nBins..nFft-1 are the complex conjugates of nFft-b.
    for (let b = nBins; b < nFft; b++) {
      fr[b] = real[off + (nFft - b)];
      fi[b] = -imag[off + (nFft - b)];
    }
    // Inverse FFT gives the windowed frame back.
    fft(fr, fi, true);
    // Overlap-add the windowed samples and the window² for normalization.
    const start = t * hop;
    for (let i = 0; i < nFft; i++) {
      const sample = fr[i] * window[i];
      out[start + i] += sample;
      norm[start + i] += window[i] * window[i];
    }
  }
  // Divide by the window² sum (COLA normalization), then strip the center pad.
  const signal = new Float32Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    const n = norm[pad + i];
    signal[i] = n > 1e-11 ? out[pad + i] / n : 0;
  }
  return signal;
}

/**
 * Fill the reflect-padding regions of an already-centered array.
 * `pad` is the half-window length; the middle [pad, len-pad) holds the signal.
 * reflect: left = reversed(signal[1..pad]), right = reversed(signal[len-2pad..len-pad-1]).
 */
function reflectPad(padded: Float32Array, pad: number): void {
  const len = padded.length;
  // Left region [0, pad): mirror of signal[1..pad] in reverse.
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = padded[pad + 1 + i];
  }
  // Right region [len-pad, len): mirror of signal[len-2pad..len-pad-1] in reverse.
  const sigEnd = len - pad; // index just past the signal = start of right pad
  for (let i = 0; i < pad; i++) {
    padded[sigEnd + i] = padded[sigEnd - 2 - i];
  }
}
