/**
 * Chunk ("phrase") detection for stem editing.
 *
 * A separated stem is a chain of musical phrases separated by near-silence
 * (the separator attributes everything else to other stems). Splitting a
 * buffer into such chunks lets the user grab a whole misclassified phrase and
 * drag it onto another role — "this line is backing vocal, not lead".
 *
 * Detection is an energy VAD over fixed windows with hysteresis. The pure core
 * works on plain channel data (Node-testable); the AudioBuffer wrapper caches
 * by buffer identity, exactly like waveform peaks (a buffer object never
 * mutates in place — edits replace it wholesale).
 */

/** One contiguous sound region, in milliseconds from the buffer start. */
export interface AudioChunk {
  startMs: number;
  endMs: number;
}

/** Analysis window (and hop) in ms — roughly one syllable nucleus. */
const WIN_MS = 20;
/** Sound starts at peakRms × HIGH and stops below peakRms × HIGH / HYST;
 *  hysteresis keeps boundaries stable against amplitude ripple. */
const THR_HIGH = 0.06;
const HYSTERESIS = 3;
/** Absolute RMS floor: digital noise in "silent" gaps must never count. */
const RMS_FLOOR = 1e-4;
/** Silence shorter than this doesn't split a chunk (intra-phrase pauses). */
const MIN_SILENCE_MS = 160;
/** Sound shorter than this is a click/artifact, not a phrase. */
const MIN_CHUNK_MS = 100;
/** Chunk padding: keep attack/release transients with the phrase. */
const PAD_MS = 30;

/**
 * Pure core: detect chunks on plain channel data (channel 0 is representative,
 * like the waveform peaks). Returns [] for silence / an all-sound buffer gets
 * one full-length chunk.
 */
export function detectChunksMs(channels: Float32Array[], sampleRate: number): AudioChunk[] {
  const data = channels[0];
  if (!data || data.length === 0) return [];

  const win = Math.max(1, Math.round((WIN_MS / 1000) * sampleRate));
  const nWin = Math.ceil(data.length / win);
  const rms = new Float32Array(nWin);
  let peak = 0;
  for (let w = 0; w < nWin; w++) {
    const s = w * win;
    const e = Math.min(data.length, s + win);
    let acc = 0;
    for (let i = s; i < e; i++) acc += data[i] * data[i];
    const r = Math.sqrt(acc / Math.max(1, e - s));
    rms[w] = r;
    if (r > peak) peak = r;
  }
  const thrHigh = Math.max(peak * THR_HIGH, RMS_FLOOR);
  const thrLow = thrHigh / HYSTERESIS;
  const winMs = (win / sampleRate) * 1000;

  // Runs of consecutive sound windows (hysteresis on the exit edge only).
  const runs: Array<[number, number]> = []; // [startWin, endWin)
  let inSound = false;
  let runStart = 0;
  for (let w = 0; w < nWin; w++) {
    if (!inSound && rms[w] >= thrHigh) {
      inSound = true;
      runStart = w;
    } else if (inSound && rms[w] < thrLow) {
      inSound = false;
      runs.push([runStart, w]);
    }
  }
  if (inSound) runs.push([runStart, nWin]);

  const durMs = (data.length / sampleRate) * 1000;
  // Join runs separated by short silences, then keep only phrase-sized ones.
  const joined: Array<{ s: number; e: number }> = [];
  for (const [ws, we] of runs) {
    const s = ws * winMs;
    const e = we * winMs;
    const last = joined[joined.length - 1];
    if (last && s - last.e < MIN_SILENCE_MS) last.e = e;
    else joined.push({ s, e });
  }
  const chunks: AudioChunk[] = [];
  for (const r of joined) {
    if (r.e - r.s < MIN_CHUNK_MS) continue;
    let s = Math.max(0, r.s - PAD_MS);
    const e = Math.min(durMs, r.e + PAD_MS);
    const prev = chunks[chunks.length - 1];
    if (prev && s < prev.endMs) {
      // Paddings of neighboring chunks collided — meet in the middle of the gap.
      const mid = Math.round((prev.endMs + s) / 2);
      prev.endMs = mid;
      s = mid;
    }
    chunks.push({ startMs: Math.round(s), endMs: Math.round(e) });
  }
  return chunks;
}

/** Copy an AudioBuffer's channels into plain arrays (pure-input convenience). */
export function bufferChannels(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c).slice());
  return out;
}

const chunkCache = new WeakMap<AudioBuffer, AudioChunk[]>();

/** detectChunksMs for a decoded buffer, cached by buffer identity. */
export function detectChunks(buffer: AudioBuffer): AudioChunk[] {
  let chunks = chunkCache.get(buffer);
  if (!chunks) {
    chunks = detectChunksMs(bufferChannels(buffer), buffer.sampleRate);
    chunkCache.set(buffer, chunks);
  }
  return chunks;
}

/** Index of the chunk containing `ms` (or within `toleranceMs` of it), else -1. */
export function chunkAtMs(chunks: AudioChunk[], ms: number, toleranceMs = 0): number {
  for (let i = 0; i < chunks.length; i++) {
    if (ms >= chunks[i].startMs - toleranceMs && ms <= chunks[i].endMs + toleranceMs) return i;
  }
  return -1;
}
