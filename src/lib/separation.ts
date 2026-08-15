/**
 * In-browser music source separation (vocal → instrumental) via Mel-Band
 * RoFormer, running fully client-side with ONNX Runtime Web (WebGPU).
 *
 * The Mel-RoFormer ONNX model is a "host-STFT" export: it takes a precomputed
 * complex STFT tensor and returns per-bin complex masks. We compute the STFT,
 * pack it into the model's expected layout, run inference, apply the masks
 * (complex multiply), invert, and derive the instrumental by subtracting the
 * vocals from the original mix.
 *
 * Model: musetric/vocal-separation-roformer-onnx ("Kim Vocal 2" SYHFT weights),
 * ~700 MB split as `.onnx` (~5 MB graph) + `.onnx.data` (~700 MB fp16 weights).
 * Both files are downloaded once and cached in the Cache Storage API.
 *
 * Pipeline (per the musetric host reference):
 *  - Decode + resample to 44.1 kHz stereo.
 *  - Chunk into 485100-sample windows (~11 s) stepping every 352800 (8 s).
 *  - Per chunk: STFT (n_fft=2048, hop=441, periodic Hann, center) → pack to
 *    [1, 2050, 1101, 2] (packed = 2*freq + channel, last dim [re,im]) →
 *    model.run → masks → complex-multiply with STFT → iSTFT → vocal PCM.
 *  - Track-level overlap-add with a Hamming window → final vocals.
 *  - Lead = normalized vocals. Instrumental = normalizePeak(mix) − raw vocals.
 *
 * WebGPU-only: the model is fp16 with fused ops tuned for the WebGPU EP. WASM
 * is not supported for this model. Runs on the main thread (heavy STFT in JS);
 * a Web Worker move is a future optimization.
 */
import { encodeWav } from './wavEncoder';
import { stft, istft } from './stft';

/**
 * One separable model: where it lives, how to load it and the exact tensor
 * layouts of its STFT-mask interface. Both models share the STFT params
 * (n_fft 2048 / hop 441 / 44.1 kHz) but pack tensors differently.
 */
export interface ModelConfig {
  graphUrl: string;
  /** Optional external-data weights (large fp16 models split graph+data). */
  dataUrl?: string;
  /** The external-data path recorded INSIDE the .onnx protobuf. */
  dataPath?: string;
  cacheName: string;
  /**
   * Input packing of the STFT:
   * - 'bins-major'  — [1, 2050, T, 2], index = ((2f+ch)·T + t)·2 + ri  (musetric)
   * - 'frames-major'— [1, T, 4100],    index = (t·4100 + (2f+ch)·2) + ri (bdsqlsz)
   */
  inputLayout: 'bins-major' | 'frames-major';
  /**
   * Output mask packing:
   * - 'flat' — same layout as the bins-major input, no stem axis (musetric)
   * - 'stem' — [1, 1, 2050, T, 2], a leading single-stem axis (bdsqlsz)
   */
  maskLayout: 'flat' | 'stem';
}

/**
 * Phase 1 — vocals+instrumental (musetric re-host of "Kim Vocal 2" SYHFT).
 * Produces a single vocal mask; the host derives lead+instrumental.
 */
const VOCALS_MODEL: ModelConfig = {
  graphUrl:
    'https://huggingface.co/musetric/vocal-separation-roformer-onnx/resolve/main/syhft_core_folded_fp16_webgpu.onnx',
  dataUrl:
    'https://huggingface.co/musetric/vocal-separation-roformer-onnx/resolve/main/syhft_core_folded_fp16_webgpu.onnx.data',
  dataPath: 'syhft_core_folded_fp16_webgpu.onnx.data',
  cacheName: 'demucs-model-v1',
  inputLayout: 'bins-major',
  maskLayout: 'flat',
};

/**
 * Phase 2 — lead/back split of the vocal stem. aufr33/viperx karaoke
 * ("RoFormer Lead/Back" on MVSEP), the bdsqlsz ONNX export RE-WRITTEN by
 * eval/fix-karaoke-onnx.mjs graph surgery (Einsum→MatMul/Mul, wide Split→binary
 * trees): the stock export builds shaders with 11+ storage buffers and hits
 * WebGPU's per-stage limit of 10. Hosted at our HF mirror
 * (Project42/mel-band-roformer-karaoke-webgpu).
 *
 * Emits ONE mask (the lead vocal); the backing stem = vocal input − lead.
 */
const KARAOKE_MODEL: ModelConfig = {
  graphUrl:
    'https://huggingface.co/Project42/mel-band-roformer-karaoke-webgpu/resolve/main/model.onnx',
  cacheName: 'karaoke-model-v1',
  inputLayout: 'frames-major',
  maskLayout: 'stem',
};

// --- Mel-RoFormer parameters (from the musetric model definition) ---
/** FFT size. */
const N_FFT = 2048;
/** Hop length between STFT frames. */
const HOP = 441;
/** Model time dimension (frames per chunk). */
const FRAMES = 1101;
/** Packed frequency dimension: (n_fft/2 + 1) * channels = 1025 * 2. */
const PACKED_BINS = (N_FFT / 2 + 1) * 2; // 2050
/** One-sided frequency bins. */
const N_BINS = N_FFT / 2 + 1; // 1025
/** Samples per chunk: hop * (frames - 1) = 441 * 1100 = 485100 (~11 s). */
const CHUNK_SAMPLES = HOP * (FRAMES - 1);
/** Step between chunks (8 s) — overlap = chunkSamples - step = ~3 s. */
const STEP_SAMPLES = 8 * 44100; // 352800
const SAMPLE_RATE = 44100;

/** CDN build of onnxruntime-web with the WebGPU EP. MUST be the 1.29 dev build —
 *  the Mel-RoFormer graph uses ops/formats unsupported in stable 1.21, which
 *  fails _OrtCreateSession with a bare numeric throw. musetric pins this exact
 *  version; it is the only verified-working build for this model. */
const ORT_CDN_URL =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0-dev.20260724-ed98916356/dist/ort.webgpu.mjs';

/** Progress callbacks for the separation run. All optional. */
export interface SeparationCallbacks {
  /** Model download progress (bytes). Only fires on the first run (no cache). */
  onDownload?: (loaded: number, total: number) => void;
  /** Human-readable phase label for the UI. */
  onStatus?: (message: string) => void;
  /** Inference progress per chunk, fraction 0..1. */
  onProgress?: (fraction: number) => void;
}

/** Why separation can or cannot run right now. `reason` is empty when available. */
export interface SeparationStatus {
  available: boolean;
  reason: string;
}

/**
 * Check whether the browser can run separation. Requires WebGPU (the fp16 model
 * runs on the WebGPU EP) and the Cache Storage API (model caching). Returns a
 * human-readable reason when blocked.
 *
 * This is a cheap synchronous check (navigator.gpu presence). The full
 * shader-f16 / adapter-limits check happens at run time inside ORT itself.
 */
export function getSeparationStatus(): SeparationStatus {
  if (typeof self === 'undefined') {
    return { available: false, reason: 'окружение не поддерживается' };
  }
  if (!('gpu' in navigator)) {
    return {
      available: false,
      reason: 'нет WebGPU. Нужен Chrome/Edge (desktop) с поддержкой WebGPU.',
    };
  }
  if (!('caches' in self)) {
    return { available: false, reason: 'Cache Storage API недоступен (приватный режим?)' };
  }
  return { available: true, reason: '' };
}

/** Convenience boolean wrapper around getSeparationStatus(). */
export function isSeparationAvailable(): boolean {
  return getSeparationStatus().available;
}

/** Separated stems, each WAV PCM 16-bit stereo bytes ready to load into a role. */
export interface SeparationResult {
  /** The LEAD vocal stem (phase 2 output; on models without phase 2 = all vocals). */
  lead: Uint8Array;
  /** The backing-vocals stem (vocal stem − lead). */
  back: Uint8Array;
  /** The instrumental stem (normalized mix − vocal stem, peak-normalized). */
  instrumental: Uint8Array;
}

/**
 * FULL two-phase separation, one button:
 *
 *   phase 1 (VOCALS_MODEL):  original → vocal mask → instrumental = mix − vocals
 *   phase 2 (KARAOKE_MODEL): vocal stem → lead mask → back = vocals − lead
 *
 * The two model sessions are NEVER alive at the same time (each holds
 * ~0.7–0.9 GB of weights) — phase 1's session is released before phase 2's is
 * created. Inference progress covers both phases (0–0.5 / 0.5–1); model
 * downloads report through `onDownload` per phase.
 */
export async function separateFull(
  originalBytes: Uint8Array,
  cb: SeparationCallbacks = {},
): Promise<SeparationResult> {
  // --- Decode + resample to 44.1 kHz stereo (planar). ---
  cb.onStatus?.('Декодирование аудио…');
  const { left, right } = await decodeStereoAt44k(originalBytes);
  const nSamples = left.length;
  const mixL = normalizePeak(left, 0.9);
  const mixR = normalizePeak(right, 0.9);

  // --- Phase 1: vocals + instrumental. ---
  cb.onStatus?.('Этап 1 из 2: вокал и минус…');
  const ort = await loadOrt();
  const session1 = await acquireSession(VOCALS_MODEL, cb.onDownload);
  const { rawL: vocRawL, rawR: vocRawR } = await runMaskModel(
    VOCALS_MODEL, session1, ort, mixL, mixR,
    (frac) => cb.onProgress?.(frac * 0.5),
  );

  // Free phase 1's ~0.7 GB before loading phase 2's model.
  session1.release?.();
  liveSession = null;

  // --- Phase 2: split the vocal stem into lead + backing. ---
  cb.onStatus?.('Этап 2 из 2: лид и бэк…');
  const vocL = normalizePeak(vocRawL, 0.9);
  const vocR = normalizePeak(vocRawR, 0.9);
  const session2 = await acquireSession(KARAOKE_MODEL, cb.onDownload);
  const { rawL: leadRawL, rawR: leadRawR } = await runMaskModel(
    KARAOKE_MODEL, session2, ort, vocL, vocR,
    (frac) => cb.onProgress?.(0.5 + frac * 0.5),
  );

  // --- Derive the complement stems and encode everything. ---
  cb.onStatus?.('Финальная обработка…');
  const backL = new Float32Array(nSamples);
  const backR = new Float32Array(nSamples);
  const instL = new Float32Array(nSamples);
  const instR = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) {
    backL[i] = vocL[i] - leadRawL[i];
    backR[i] = vocR[i] - leadRawR[i];
    instL[i] = mixL[i] - vocRawL[i];
    instR[i] = mixR[i] - vocRawR[i];
  }
  return {
    lead: encodeWav(normalizePeak(leadRawL, 0.9), normalizePeak(leadRawR, 0.9), SAMPLE_RATE),
    back: encodeWav(normalizePeak(backL, 0.9), normalizePeak(backR, 0.9), SAMPLE_RATE),
    instrumental: encodeWav(normalizePeak(instL, 0.9), normalizePeak(instR, 0.9), SAMPLE_RATE),
  };
}

/**
 * Chunked overlap-add run of a single-mask model over stereo PCM. Returns the
 * RAW masked signal (pre-normalization; divide-by-window applied).
 */
async function runMaskModel(
  cfg: ModelConfig,
  session: MelRoformerSession,
  ort: OrtModule,
  inL: Float32Array,
  inR: Float32Array,
  onProgress: (fraction: number) => void,
): Promise<{ rawL: Float32Array; rawR: Float32Array }> {
  const nSamples = inL.length;
  const window = hammingWindow(CHUNK_SAMPLES);
  const targetL = new Float32Array(nSamples);
  const targetR = new Float32Array(nSamples);
  const countL = new Float32Array(nSamples);
  const countR = new Float32Array(nSamples);

  const nChunks = Math.max(1, Math.ceil((nSamples - CHUNK_SAMPLES) / STEP_SAMPLES) + 1);
  let chunkIndex = 0;
  for (let offset = 0; offset < nSamples; offset += STEP_SAMPLES) {
    chunkIndex++;
    const cw = getChunkWindow(offset, nSamples);
    const chunkL = new Float32Array(CHUNK_SAMPLES);
    const chunkR = new Float32Array(CHUNK_SAMPLES);
    for (let i = 0; i < cw.length; i++) {
      chunkL[i] = inL[cw.start + i];
      chunkR[i] = inR[cw.start + i];
    }
    const { vocL, vocR } = await processChunk(cfg, session, ort, chunkL, chunkR);
    overlapAdd(targetL, countL, vocL, cw.start, cw.length, window);
    overlapAdd(targetR, countR, vocR, cw.start, cw.length, window);
    onProgress(chunkIndex / nChunks);
    if (offset + STEP_SAMPLES >= nSamples) break;
  }
  onProgress(1);
  return {
    rawL: finalizeOverlap(targetL, countL),
    rawR: finalizeOverlap(targetR, countR),
  };
}

/** Render any thrown value (Error, string, number, object) into readable text.
 *  ORT/WebGPU sometimes reject with bare numbers (e.g. WebGPU pipeline codes),
 *  so a defensive stringify keeps error messages meaningful. */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  if (typeof e === 'number') return `код ${e} (0x${e.toString(16)})`;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Lazily-imported onnxruntime-web module (WebGPU build). */
type OrtModule = {
  env: {
    webgpu?: { device?: GPUDevice };
    log?: { severityLevel?: number; verbosityLevel?: number };
    wasm?: { numThreads?: number };
  };
  InferenceSession: {
    create(
      model: Uint8Array | ArrayBuffer | string,
      options?: Record<string, unknown>,
    ): Promise<MelRoformerSession>;
  };
  Tensor: { new (type: string, data: Float32Array, dims: readonly number[]): unknown };
};

/** The narrow ORT session surface we use. */
interface MelRoformerSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
  inputNames: readonly string[];
  outputNames: readonly string[];
  release?(): void;
}

/**
 * Single-slot session cache: at most ONE model session stays alive (~0.7–0.9 GB
 * of weights each — two at once would blow the memory budget). Switching models
 * releases the previous session; a re-run recreates it from the byte cache.
 */
let liveSession: { cfg: ModelConfig; session: MelRoformerSession } | null = null;

async function acquireSession(
  cfg: ModelConfig,
  onDownload?: (loaded: number, total: number) => void,
): Promise<MelRoformerSession> {
  if (liveSession && liveSession.cfg === cfg) return liveSession.session;
  if (liveSession) {
    liveSession.session.release?.();
    liveSession = null;
  }
  const { graph, data } = await loadModelFiles(cfg, onDownload);
  const ort = await loadOrt();
  let session: MelRoformerSession;
  try {
    session = await ort.InferenceSession.create(graph, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
      ...(cfg.dataPath && data ? { externalData: [{ path: cfg.dataPath, data }] } : {}),
    });
  } catch (e) {
    throw new Error(
      'Не удалось загрузить модель в WebGPU: ' + describeError(e) +
      '. Возможные причины: нет WebGPU/shader-f16, нехватка видеопамяти (нужно ~1.5 ГБ).',
    );
  }
  liveSession = { cfg, session };
  return session;
}

/**
 * Fetch a model's files with cache-first semantics. Returns the graph and the
 * optional external-data weights as Uint8Arrays. Files are stored as separate
 * Cache entries; only downloaded on first run. Multi-file models report
 * COMBINED byte progress across their files.
 */
async function loadModelFiles(
  cfg: ModelConfig,
  onDownload?: (loaded: number, total: number) => void,
): Promise<{ graph: Uint8Array; data: Uint8Array | null }> {
  const cache = await caches.open(cfg.cacheName);
  const urls = [cfg.graphUrl, ...(cfg.dataUrl ? [cfg.dataUrl] : [])];
  const cached = await Promise.all(urls.map((u) => cache.match(u)));
  // Download whichever files aren't cached, reporting combined progress.
  const missing = urls.filter((_, i) => !cached[i]);
  if (missing.length > 0) {
    let totalDownloaded = 0;
    const totalToDownload = await totalContentLength(missing);
    const downloaded = new Map<string, Uint8Array>();
    for (const url of missing) {
      const buf = await fetchWithProgress(url, (loaded) => {
        onDownload?.(totalDownloaded + loaded, totalToDownload);
      });
      totalDownloaded += buf.byteLength;
      downloaded.set(url, buf);
      // Best-effort cache: a quota rejection (small profile quota, private
      // mode) must not kill the run — proceed with the in-memory bytes.
      try {
        await cache.put(url, new Response(buf.slice(0)));
      } catch {
        /* uncached — the next run will re-download */
      }
    }
    // Prefer the just-downloaded bytes (the cache write may have failed).
    const graph = downloaded.get(cfg.graphUrl) ?? (await cachedBytes(cfg.graphUrl, undefined, cache));
    const data = cfg.dataUrl
      ? downloaded.get(cfg.dataUrl) ?? (await cachedBytes(cfg.dataUrl, undefined, cache))
      : null;
    return { graph, data };
  }
  const graph = await cachedBytes(cfg.graphUrl, undefined, cache);
  const data = cfg.dataUrl ? await cachedBytes(cfg.dataUrl, undefined, cache) : null;
  return { graph, data };
}

/** Read a model file from the cache (or the just-fetched Response), as bytes. */
async function cachedBytes(
  url: string,
  cached: Response | undefined,
  cache: Cache,
): Promise<Uint8Array> {
  const resp = cached ?? (await cache.match(url));
  if (!resp) throw new Error(`Файл модели не найден в кеше: ${url}`);
  const ab = await resp.arrayBuffer();
  return new Uint8Array(ab);
}

/** Stream a URL to a Uint8Array, reporting download progress in bytes. */
async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Не удалось загрузить файл модели (${response.status}).`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded);
    }
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

/** Sum Content-Length headers across the given URLs (0 if unknown). */
async function totalContentLength(urls: string[]): Promise<number> {
  let total = 0;
  for (const url of urls) {
    const head = await fetch(url, { method: 'HEAD' });
    const len = head.headers.get('content-length');
    if (len) total += parseInt(len, 10);
  }
  return total;
}

/**
 * Dynamically import the WebGPU build of onnxruntime-web from CDN. The webgpu
 * bundle is smaller than ort.all.mjs and built specifically for WebGPU models.
 * Exported — shared by other model-backed features (e.g. forcedAlign.ts).
 */
export async function loadOrt(): Promise<OrtModule> {
  const mod = (await import(/* @vite-ignore */ ORT_CDN_URL)) as { default?: OrtModule } & OrtModule;
  return (mod.default ?? mod) as OrtModule;
}

/**
 * Decode arbitrary audio bytes (mp3/wav/ogg…) and resample to 44100 Hz stereo
 * Float32Arrays, as Mel-RoFormer requires. OfflineAudioContext resamples on decode.
 */
async function decodeStereoAt44k(
  bytes: Uint8Array,
): Promise<{ left: Float32Array; right: Float32Array }> {
  if (bytes.byteLength === 0) throw new Error('Пустое аудио.');
  const Ctor: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctor(1, 1, SAMPLE_RATE);
  const buf: ArrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;
  const decoded = await ctx.decodeAudioData(buf);
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
  return { left, right };
}

/**
 * Run one chunk through a model: STFT → pack → inference → mask → iSTFT.
 * Returns the raw (pre-normalization) masked PCM for this chunk — the stem the
 * model's single mask selects (vocals for the phase-1 model, lead for karaoke).
 */
async function processChunk(
  cfg: ModelConfig,
  session: MelRoformerSession,
  ort: OrtModule,
  chunkL: Float32Array,
  chunkR: Float32Array,
): Promise<{ vocL: Float32Array; vocR: Float32Array }> {
  // STFT both channels (center=True, periodic Hann, n_fft=2048, hop=441).
  const specL = stft(chunkL, { nFft: N_FFT, hop: HOP });
  const specR = stft(chunkR, { nFft: N_FFT, hop: HOP });
  // Pad/truncate the frame axis to exactly FRAMES (model expects T=1101).
  // STFT of CHUNK_SAMPLES yields 1 + floor(CHUNK/HOP) = 1 + 1100 = 1101 frames,
  // so no padding is normally needed — but guard defensively.
  const frames = Math.min(specL.nFrames, FRAMES);

  // Pack into the model's input layout (packed bins = 2*freq + channel).
  const input = packStft(cfg.inputLayout, specL, specR, frames);
  const dims = cfg.inputLayout === 'bins-major' ? [1, PACKED_BINS, FRAMES, 2] : [1, FRAMES, PACKED_BINS * 2];
  const inputTensor = new ort.Tensor('float32', input, dims);

  const feeds: Record<string, unknown> = {};
  feeds[session.inputNames[0]] = inputTensor;
  let out: Record<string, { data: Float32Array }>;
  try {
    out = await session.run(feeds);
  } catch (e) {
    throw new Error('Сбой инференса модели: ' + describeError(e));
  }
  const masksOut = out[session.outputNames[0]];
  if (!masksOut) throw new Error('Модель не вернула маски.');
  const masks = masksOut.data;

  // Unpack the mask, apply (complex multiply) to each channel's STFT, iSTFT.
  const maskedL = applyMask(cfg.maskLayout, specL, masks, 0, frames);
  const maskedR = applyMask(cfg.maskLayout, specR, masks, 1, frames);
  const vocL = istft(maskedL, { nFft: N_FFT, hop: HOP }, chunkL.length);
  const vocR = istft(maskedR, { nFft: N_FFT, hop: HOP }, chunkR.length);
  return { vocL, vocR };
}

/**
 * Pack two channel STFTs into the model input.
 * - 'bins-major'  → [1, 2050, T, 2]: index = ((2f+ch)·T + t)·2 + ri
 * - 'frames-major'→ [1, T, 4100]:    index = t·4100 + (2f+ch)·2 + ri
 */
export function packStft(
  layout: ModelConfig['inputLayout'],
  specL: { real: Float32Array; imag: Float32Array; nBins: number; nFrames: number },
  specR: { real: Float32Array; imag: Float32Array; nBins: number; nFrames: number },
  frames: number,
): Float32Array {
  const out = new Float32Array(PACKED_BINS * FRAMES * 2);
  for (let freq = 0; freq < N_BINS; freq++) {
    for (let channel = 0; channel < 2; channel++) {
      const packed = 2 * freq + channel;
      const spec = channel === 0 ? specL : specR;
      for (let frame = 0; frame < frames; frame++) {
        const src = frame * spec.nBins + freq;
        const dst = layout === 'bins-major'
          ? (packed * FRAMES + frame) * 2
          : frame * PACKED_BINS * 2 + packed * 2;
        out[dst] = spec.real[src];
        out[dst + 1] = spec.imag[src];
      }
    }
  }
  return out;
}

/**
 * Apply a channel's mask to its STFT via complex multiplication, returning a new
 * ComplexSTFT (truncated to `frames` if needed). `(a+bi)*(c+di) = (ac−bd)+(ad+bc)i`.
 * - 'flat' — mask laid out like the bins-major input: ((2f+ch)·T + t)·2 + ri
 * - 'stem' — [1, 1, 2050, T, 2]: ((2f+ch)·T + t)·2 + ri (same walk, stem axis = 0)
 */
export function applyMask(
  layout: ModelConfig['maskLayout'],
  spec: { real: Float32Array; imag: Float32Array; nBins: number; nFrames: number },
  masks: Float32Array,
  channel: number,
  frames: number,
): { real: Float32Array; imag: Float32Array; nBins: number; nFrames: number } {
  const real = new Float32Array(spec.nBins * frames);
  const imag = new Float32Array(spec.nBins * frames);
  // Frame stride of the mask array: the 'flat' layout mirrors the padded input
  // (FRAMES entries), the 'stem' layout returns exactly the input frame count.
  const stride = layout === 'flat' ? FRAMES : frames;
  for (let freq = 0; freq < spec.nBins; freq++) {
    const packed = 2 * freq + channel;
    for (let frame = 0; frame < frames; frame++) {
      const src = frame * spec.nBins + freq;
      const a = spec.real[src];
      const b = spec.imag[src];
      const m = (packed * stride + frame) * 2;
      const c = masks[m];
      const d = masks[m + 1];
      const dst = frame * spec.nBins + freq;
      real[dst] = a * c - b * d;
      imag[dst] = a * d + b * c;
    }
  }
  return { real, imag, nBins: spec.nBins, nFrames: frames };
}

/** Peak-normalize a signal so its max absolute amplitude is `peak`. */
function normalizePeak(signal: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (let i = 0; i < signal.length; i++) {
    const a = Math.abs(signal[i]);
    if (a > max) max = a;
  }
  if (max < 1e-11) return signal.subarray(0); // silence — return a copy
  const scale = peak / max;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] * scale;
  return out;
}

/** Periodic Hamming window of length N: 0.54 − 0.46·cos(2π n / N). */
function hammingWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Chunk window plan: a full-length chunk at `start` if it fits; the final chunk
 * shifted back to remain full-length (extra overlap) rather than zero-padding.
 */
function getChunkWindow(
  offset: number,
  nSamples: number,
): { start: number; length: number } {
  if (offset + CHUNK_SAMPLES <= nSamples) {
    return { start: offset, length: CHUNK_SAMPLES };
  }
  if (nSamples <= CHUNK_SAMPLES) {
    return { start: 0, length: nSamples };
  }
  // Last partial chunk: shift back so it's full-length.
  return { start: nSamples - CHUNK_SAMPLES, length: CHUNK_SAMPLES };
}

/** Overlap-add a chunk into a target accumulator with the given window. */
function overlapAdd(
  target: Float32Array,
  counter: Float32Array,
  chunk: Float32Array,
  start: number,
  length: number,
  window: Float32Array,
): void {
  for (let i = 0; i < length; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= target.length) continue;
    target[idx] += chunk[i] * window[i];
    counter[idx] += window[i];
  }
}

/** Finalize an OLA accumulator by dividing out the window-sum normalization. */
function finalizeOverlap(target: Float32Array, counter: Float32Array): Float32Array {
  const out = new Float32Array(target.length);
  for (let i = 0; i < target.length; i++) {
    out[i] = counter[i] > 1e-10 ? target[i] / counter[i] : 0;
  }
  return out;
}
