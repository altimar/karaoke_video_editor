/**
 * In-page probe for the WebGPU buffer-limit fix (see ModelConfig.attentionBytesPerFrameSq
 * in src/lib/separation.ts): runs the karaoke model on a REAL vocal chunk at
 * several window sizes (frames) and reports which fit the adapter. Bundled by
 * eval/run-karaoke-frames-probe.mjs.
 *
 * Attention memory scales as bands·heads·T²·4 bytes (60·8·T²·4 = 1920·T² for
 * karaoke): T=1101 needs one 2.33 GB buffer, over the 2 GiB maxBufferSize
 * Chrome/D3D12 reports on Windows — CreateBuffer fails. Smaller T should run.
 */
import { stft } from '../src/lib/stft';
import { packStft } from '../src/lib/separation';

const N_FFT = 2048;
const HOP = 441;
const PACKED_BINS = 2050;
/** Karaoke attention footprint: 60 mel bands × 8 heads × 4 B, per frame². */
const BYTES_PER_FRAME_SQ = 60 * 8 * 4;
const HEADROOM = 2;

const ORT_URL =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0-dev.20260724-ed98916356/dist/ort.webgpu.mjs';

export interface FramesRun {
  frames: number;
  attentionBytes: number;
  ok: boolean;
  error?: string;
  ms?: number;
  outShape?: number[];
  maskRms?: number;
  nans?: number;
}

export interface FramesProbeResult {
  adapter: { maxBufferSize: number; info: Record<string, unknown> } | null;
  /** Mirrors the production resolveFrames() pick for this adapter. */
  productionFrames: number;
  runs: FramesRun[];
}

interface GpuAdapterLike {
  limits: { maxBufferSize: number };
  info?: Record<string, unknown>;
  requestAdapterInfo?: () => Promise<Record<string, unknown>>;
}

(window as unknown as { __framesProbe: unknown }).__framesProbe = async (
  modelUrl: string,
  mp3Base64: string,
  startSec: number,
  frameCounts: number[],
): Promise<FramesProbeResult> => {
  // --- Adapter limits: the whole point of the fix. ---
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: unknown): Promise<GpuAdapterLike | null> } }).gpu;
  let adapter: GpuAdapterLike | null = null;
  try {
    adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' }) ?? null;
  } catch {
    adapter = null;
  }
  const info = adapter?.info ?? (adapter?.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
  const maxBuffer = adapter?.limits.maxBufferSize ?? 0;
  const budget = maxBuffer / HEADROOM;
  const productionFrames = adapter
    ? (BYTES_PER_FRAME_SQ * 1101 * 1101 <= maxBuffer
        ? 1101
        : Math.max(400, Math.min(1101, Math.floor(Math.sqrt(budget / BYTES_PER_FRAME_SQ)))))
    : 1101;

  // --- Decode the vocal fixture at 44.1 kHz stereo. ---
  const bin = atob(mp3Base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ctx = new AudioContext({ sampleRate: 44100 });
  const buf = await ctx.decodeAudioData(bytes.buffer);
  const Lfull = buf.getChannelData(0);
  const Rfull = buf.numberOfChannels > 1 ? buf.getChannelData(1) : Lfull;
  const start = Math.floor(startSec * 44100);

  // --- Load the model once, reuse the session across window sizes. ---
  const ort = (await import(/* @vite-ignore */ ORT_URL)) as {
    default?: unknown;
    InferenceSession: { create(m: Uint8Array, o: Record<string, unknown>): Promise<never> };
    Tensor: new (t: string, d: Float32Array, dims: readonly number[]) => unknown;
  };
  const mod = ((ort as { default?: typeof ort }).default ?? ort) as typeof ort;
  const model = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
  const t0 = performance.now();
  const session = await mod.InferenceSession.create(model, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
  });
  console.log(`[frames-probe] session create: ${(performance.now() - t0).toFixed(0)}ms`);

  const runs: FramesRun[] = [];
  for (const frames of frameCounts) {
    const chunkSamples = HOP * (frames - 1);
    const chunkL = new Float32Array(chunkSamples);
    const chunkR = new Float32Array(chunkSamples);
    chunkL.set(Lfull.subarray(start, start + chunkSamples));
    chunkR.set(Rfull.subarray(start, start + chunkSamples));
    const specL = stft(chunkL, { nFft: N_FFT, hop: HOP });
    const specR = stft(chunkR, { nFft: N_FFT, hop: HOP });
    const input = packStft('frames-major', specL, specR, frames);
    const tensor = new mod.Tensor('float32', input, [1, frames, PACKED_BINS * 2]);
    const feeds: Record<string, unknown> = {};
    feeds[session.inputNames[0] as string] = tensor;

    const run: FramesRun = { frames, attentionBytes: BYTES_PER_FRAME_SQ * frames * frames };
    const t1 = performance.now();
    try {
      const out = (await session.run(feeds)) as Record<
        string,
        { data: Float32Array; dims: number[] }
      >;
      run.ms = performance.now() - t1;
      run.outShape = out[(session as { outputNames: readonly string[] }).outputNames[0]].dims;
      const masks = out[(session as { outputNames: readonly string[] }).outputNames[0]].data;
      let sumSq = 0;
      let nans = 0;
      for (let i = 0; i < masks.length; i++) {
        const v = masks[i];
        if (Number.isNaN(v)) nans++;
        sumSq += v * v;
      }
      run.maskRms = Math.sqrt(sumSq / masks.length);
      run.nans = nans;
      run.ok = true;
    } catch (e) {
      run.ok = false;
      run.error = String(e).slice(0, 400);
    }
    console.log(`[frames-probe] T=${frames}: ${run.ok ? `ok in ${run.ms!.toFixed(0)}ms` : 'FAILED'}`);
    runs.push(run);
  }
  return { adapter: adapter ? { maxBufferSize: maxBuffer, info } : null, productionFrames, runs };
};
