/**
 * Syllable auto-timing via CTC forced alignment (wav2vec2).
 *
 * The user's flow: vocals loaded (the separated lead stem, or the original),
 * lyrics text loaded and syllabified → press ✨ → every syllable gets a start
 * time derived from where the model "hears" each word in the vocals.
 *
 * The pure alignment math lives in lib/alignment/ctc.ts (Viterbi over CTC
 * log-probabilities, torchaudio-style); this module owns the model side:
 * download/cache (HF hub + Cache Storage, like Mel-RoFormer in separation.ts),
 * preprocessing (16 kHz mono, zero-mean/unit-var), CHUNKED inference (the
 * attention memory cannot hold a whole song at once), log-softmax stitching
 * and the final syllable distribution.
 *
 * Two checkpoints (registry in alignment/models.ts), picked automatically by
 * the lyrics' script (alignment/models.ts: pickAlignModel):
 *  - English (wav2vec2-large-960h-lv60-self, fp16 ~630 MB) for pure-ASCII
 *    Latin lyrics;
 *  - multilingual MMS-300M aligner (1130 languages, fp16 ~600 MB) for
 *    anything else — Cyrillic, umlauts — via uroman romanization
 *    (alignment/romanize.ts). Weight license: CC-BY-NC-4.0.
 */
import { Line } from '../types';
import { loadOrt } from './separation';
import {
  flattenSyllablesForAlignment,
  buildWords,
  buildTranscript,
  ctcForcedAlign,
  stitchChunks,
  distributeSyllableTimes,
} from './alignment/ctc';
import { AlignModelConfig, ENGLISH_ALIGN_MODEL, pickAlignModel } from './alignment/models';

/**
 * Model override (used by the eval harness to compare checkpoints). Applies to
 * the English slot only — the eval checkpoints share its vocab.
 */
let modelOverride: { url: string; cacheName: string } | null = null;

/** Swap the alignment model (eval/benchmarking only). */
export function setAlignmentModelOverride(url: string, cacheName: string): void {
  modelOverride = { url, cacheName };
}

/** wav2vec2-base works at 16 kHz; its conv stack emits one frame per 320
 * samples (50 fps), with ~400 samples of receptive field. */
const SR = 16000;
const FRAME_MS = 20;
const FRAME_OFFSET_MS = 12.5; // center of the 400-sample receptive window
/** Inference chunking: attention memory can't hold a whole song. 30 s proved
 * empirically better than 16 s (shorter chunks LOSE context and worsen the
 * repeated-chorus confusion — benchmark in eval/results/). */
const CHUNK_SEC = 30;
const OVERLAP_SEC = 2;

export interface AlignCallbacks {
  onDownload?: (loaded: number, total: number) => void;
  onStatus?: (msg: string) => void;
  onProgress?: (fraction: number) => void;
}

/** Feature-detect: needs WebGPU (ort webgpu build) + Cache Storage. */
export function getAlignmentStatus(): { available: boolean; reason: string } {
  if (typeof navigator !== 'undefined' && !('gpu' in navigator)) {
    return { available: false, reason: 'WebGPU недоступен (нужен Chrome/Edge)' };
  }
  if (typeof caches === 'undefined') {
    return { available: false, reason: 'Cache Storage недоступен' };
  }
  return { available: true, reason: '' };
}

/**
 * Compute a start time (ms) for every syllable of `lines` from the vocal audio
 * in `buffer`. Returns times in the FLAT syllable order (line by line).
 * Existing timings are the caller's concern — this function is pure compute.
 */
export async function autoAlignTimings(
  buffer: AudioBuffer,
  lines: Line[],
  cb: AlignCallbacks = {},
): Promise<number[]> {
  const flat = flattenSyllablesForAlignment(lines);
  if (flat.length === 0) throw new Error('В дорожке нет слогов.');
  // The model follows the lyrics' script: Cyrillic/umlauts → multilingual MMS.
  const model = pickAlignModel(flat.map((s) => s.text).join(' '));
  const words = buildWords(flat, model);
  const { tokens, tokenWord } = buildTranscript(words, model.wordSepId);
  if (tokens.length === 0) throw new Error('В тексте нет букв для выравнивания.');

  cb.onStatus?.('Подготовка аудио…');
  const pcm = await to16kMono(buffer);

  cb.onStatus?.(`Загрузка модели распознавания (${model.label})…`);
  const modelBytes = await loadModel(model, cb.onDownload);

  const ort = await loadOrt();
  cb.onStatus?.('Запуск модели…');
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  // --- Chunked inference with overlap ---
  const V = model.vocabSize;
  const chunkLen = CHUNK_SEC * SR;
  const overlapLen = OVERLAP_SEC * SR;
  const step = chunkLen - overlapLen;
  const chunks: Array<{ logits: Float32Array; frames: number; keep: number }> = [];
  const totalChunks = Math.max(1, Math.ceil(pcm.length / step));
  let done = 0;

  for (let start = 0; ; start += step) {
    const end = Math.min(pcm.length, start + chunkLen);
    const view = pcm.subarray(start, end);
    if (view.length < 400) {
      if (start === 0) throw new Error('Аудио слишком короткое.');
      break;
    }
    const feed: Record<string, unknown> = {};
    feed[inputName] = new ort.Tensor('float32', normalize(view), [1, view.length]);
    const out = await session.run(feed);
    const logits = (out[outputName].data as Float32Array).slice(); // copy
    // frames in this chunk; keep all but the trailing overlap (last chunk keeps all)
    const frames = logits.length / V;
    const overlapFrames = Math.round((overlapLen / SR) / (1 / 50)); // 50 fps
    const isLast = end >= pcm.length;
    chunks.push({ logits, frames, keep: isLast ? frames : Math.max(1, frames - overlapFrames) });
    done++;
    cb.onProgress?.(Math.min(0.99, done / totalChunks));
    if (isLast) break;
  }

  cb.onStatus?.('Выравнивание текста…');
  const merged = stitchChunks(chunks, V);
  const T = merged.length / V;
  logSoftmaxInPlace(merged, T, V);
  const { frames } = ctcForcedAlign(merged, T, V, Array.from(tokens), model.blankId);

  const durationMs = Math.round(buffer.duration * 1000);
  const starts = distributeSyllableTimes(words, tokenWord, frames, flat, FRAME_MS, durationMs, 'proportional', model);
  // Shift by the receptive-field center so times point at the sound, not the
  // left edge of the model's window.
  return starts.map((ms) => Math.max(0, Math.round(ms + FRAME_OFFSET_MS)));
}

/**
 * Resample any AudioBuffer to 16 kHz mono Float32Array via OfflineAudioContext.
 */
async function to16kMono(buffer: AudioBuffer): Promise<Float32Array> {
  if (buffer.sampleRate === SR && buffer.numberOfChannels === 1) {
    return normalize(buffer.getChannelData(0).slice());
  }
  const frames = Math.max(1, Math.ceil((buffer.duration || 0) * SR));
  const ctx = new OfflineAudioContext(1, frames, SR);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Zero-mean / unit-variance normalization (wav2vec2 feature extractor). */
function normalize(x: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length || 1;
  let varSum = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / (x.length || 1)) || 1;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = (x[i] - mean) / std;
  return out;
}

/** Row-wise log-softmax over [T, V] logits, in place. */
function logSoftmaxInPlace(x: Float32Array, T: number, V: number): void {
  for (let t = 0; t < T; t++) {
    const base = t * V;
    let max = -Infinity;
    for (let v = 0; v < V; v++) if (x[base + v] > max) max = x[base + v];
    let sum = 0;
    for (let v = 0; v < V; v++) {
      const e = Math.exp(x[base + v] - max);
      x[base + v] = e;
      sum += e;
    }
    const logSum = Math.log(sum);
    for (let v = 0; v < V; v++) x[base + v] = Math.log(x[base + v]) - logSum;
  }
}

/**
 * Cache-first model download (single file). Mirrors separation.ts but for a
 * self-contained .onnx without external data. The eval-harness override (when
 * set) replaces the English checkpoint's URL/cache.
 */
async function loadModel(
  model: AlignModelConfig,
  onDownload?: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const useOverride = modelOverride && model.id === ENGLISH_ALIGN_MODEL.id;
  const url = useOverride ? modelOverride!.url : model.url;
  const cacheName = useOverride ? modelOverride!.cacheName : model.cacheName;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(url);
  if (cached) {
    onDownload?.(1, 1);
    return new Uint8Array(await cached.arrayBuffer());
  }
  const head = await fetch(url, { method: 'HEAD' });
  const total = parseInt(head.headers.get('content-length') ?? '0', 10) || 48 * 1024 * 1024;
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) throw new Error(`Не удалось скачать модель (${resp.status}).`);
  const reader = resp.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onDownload?.(loaded, total);
  }
  const all = new Uint8Array(loaded);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  // Best-effort cache: a quota rejection must not kill the run — proceed with
  // the in-memory bytes (the next run will re-download).
  try {
    await cache.put(url, new Response(all.buffer as ArrayBuffer));
  } catch {
    /* uncached */
  }
  return all;
}
