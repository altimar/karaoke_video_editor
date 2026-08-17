/**
 * In-page probe entry (bundled by eval/run-karaoke-probe.mjs via esbuild).
 * Exposes window.__probe(modelUrls, mp3Bytes, startSec, durSec) which:
 *  - decodes the audio at 44.1 kHz stereo,
 *  - runs EVERY provided model on the same real chunk (STFT via our production
 *    code, frames-major packing, mask -> iSTFT stem),
 *  - times session.run (median of N, after warmup),
 *  - diffs the fp16 masks against the fp32 masks elementwise.
 * Returns PCM stems for offline comparison against reference dumps.
 */
import { stft, istft } from '../src/lib/stft';
import { packStft, applyMask } from '../src/lib/separation';

const N_FFT = 2048;
const HOP = 441;
const FRAMES = 1101;
const PACKED_BINS = 2050;
const CHUNK_SAMPLES = HOP * (FRAMES - 1);

const ORT_URL =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0-dev.20260724-ed98916356/dist/ort.webgpu.mjs';

export interface ProbeStem {
  url: string;
  ok: boolean;
  error?: string;
  ms?: number;
  outShape?: number[];
  stemL?: Float32Array;
  stemR?: Float32Array;
  masks?: Float32Array;
}

(window as unknown as { __probe: unknown }).__probe = async (
  modelUrls: string[],
  mp3Base64: string,
  startSec: number,
  runs = 3,
): Promise<{ chunks: { L: Float32Array; R: Float32Array }; stems: ProbeStem[]; diff16: string }> => {
  // decode (base64 -> bytes, avoiding Playwright's slow Buffer serialization)
  const bin = atob(mp3Base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ctx = new AudioContext({ sampleRate: 44100 });
  const buf = await ctx.decodeAudioData(bytes.buffer);
  const Lfull = buf.getChannelData(0);
  const Rfull = buf.getChannelData(1);
  const start = Math.floor(startSec * 44100);
  const n = Math.min(CHUNK_SAMPLES, Lfull.length - start);
  const chunkL = new Float32Array(CHUNK_SAMPLES);
  const chunkR = new Float32Array(CHUNK_SAMPLES);
  chunkL.set(Lfull.subarray(start, start + n));
  chunkR.set(Rfull.subarray(start, start + n));

  // stft + pack (frames-major, like the karaoke model)
  const specL = stft(chunkL, { nFft: N_FFT, hop: HOP });
  const specR = stft(chunkR, { nFft: N_FFT, hop: HOP });
  const frames = Math.min(specL.nFrames, FRAMES);
  const input = packStft('frames-major', specL, specR, frames);

  const ort = await import(/* @vite-ignore */ ORT_URL);

  const stems: ProbeStem[] = [];
  for (const url of modelUrls) {
    try {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const t0 = performance.now();
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      const createMs = performance.now() - t0;

      const tensor = new ort.Tensor('float32', input, [1, FRAMES, PACKED_BINS * 2]);
      const feeds: Record<string, unknown> = {};
      feeds[session.inputNames[0]] = tensor;

      await session.run(feeds); // warmup (shader compilation)
      const times: number[] = [];
      let out: { data: Float32Array; dims: number[] };
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        out = await session.run(feeds);
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      const masks = out![session.outputNames[0]].data;
      const maskedL = applyMask('stem', specL, masks, 0, frames);
      const maskedR = applyMask('stem', specR, masks, 1, frames);
      const stemL = istft(maskedL, { nFft: N_FFT, hop: HOP }, chunkL.length);
      const stemR = istft(maskedR, { nFft: N_FFT, hop: HOP }, chunkR.length);
      stems.push({
        url,
        ok: true,
        ms: times[Math.floor(times.length / 2)],
        outShape: out!.dims,
        stemL,
        stemR,
        masks,
      });
      console.log(`[probe] ${url}: create=${createMs.toFixed(0)}ms run=${times[Math.floor(times.length / 2)].toFixed(0)}ms`);
      session.release?.();
    } catch (e) {
      stems.push({ url, ok: false, error: String(e) });
      console.error(`[probe] ${url} FAILED:`, e);
    }
  }

  // elementwise fp16-vs-fp32 mask diff (if both ran)
  let diff16 = 'n/a';
  const a = stems.find((s) => s.ok && s.url.includes('fp32'));
  const b = stems.find((s) => s.ok && s.url.includes('fp16'));
  if (a?.masks && b?.masks) {
    let max = 0;
    let sum = 0;
    let ref = 0;
    for (let i = 0; i < a.masks.length; i++) {
      const d = Math.abs(a.masks[i] - b.masks[i]);
      if (d > max) max = d;
      sum += d * d;
      ref += a.masks[i] * a.masks[i];
    }
    diff16 = `maxAbsDiff=${max.toFixed(6)} relRMS=${(Math.sqrt(sum / a.masks.length) / Math.sqrt(ref / a.masks.length) * 100).toFixed(4)}%`;
  }
  // Keep the payload small: masks stay in-page (the diff is computed above).
  for (const s of stems) delete s.masks;
  return { chunks: { L: chunkL, R: chunkR }, stems, diff16 };
};
