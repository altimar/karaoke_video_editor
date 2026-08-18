/**
 * MP3 encoder for the KFN export (pure-JS LAME via @breezystack/lamejs).
 *
 * A .kfn embeds its audio files as-is; raw WAV stems (~10 MB per minute each)
 * would bloat it. On export each role's audio is re-encoded to MP3 192 kbps
 * (~1.4 MB/min) — the format KaraFun itself uses inside its own .kfn files
 * (AAC/m4a was tried first; the KaraFun player refused to play it). Files that
 * are ALREADY mp3 are embedded untouched (no lossy→lossy re-encode).
 *
 * The PROJECT keeps WAV stems — phrase moves must stay lossless there.
 */
import lamejs from '@breezystack/lamejs';

/** MP3 bitrate for KFN audio (bits per second). */
export const MP3_KBPS = 192;

/** LAME works on 1152-sample blocks. */
const BLOCK = 1152;
/** Yield to the event loop every N blocks so the UI stays responsive. */
const YIELD_EVERY = 400;

/**
 * Encode channel data to MP3. Pure JS (works in Node and in the browser);
 * yields periodically to keep the export dialog responsive.
 */
export async function encodeMp3Channels(channels: Float32Array[], sampleRate: number): Promise<Uint8Array> {
  const numFrames = Math.max(0, ...channels.map((ch) => ch.length));
  const encoder = new lamejs.Mp3Encoder(channels.length, sampleRate, MP3_KBPS);
  const left = channels[0] ?? new Float32Array(0);
  const right = channels.length > 1 ? channels[1] : left;

  const toInt16 = (src: Float32Array, from: number, count: number): Int16Array => {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const v = Math.max(-1, Math.min(1, src[from + i] ?? 0));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };

  const chunks: Uint8Array[] = [];
  for (let pos = 0; pos < numFrames; pos += BLOCK) {
    const count = Math.min(BLOCK, numFrames - pos);
    const encoded = channels.length > 1
      ? encoder.encodeBuffer(toInt16(left, pos, count), toInt16(right, pos, count))
      : encoder.encodeBuffer(toInt16(left, pos, count));
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded.buffer.slice(0, encoded.byteLength)));
    if ((pos / BLOCK) % YIELD_EVERY === YIELD_EVERY - 1) await new Promise((r) => setTimeout(r, 0));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail.buffer.slice(0, tail.byteLength)));

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Sniff whether bytes already are an MP3 stream (ID3v2 header or an MPEG audio
 * frame sync) — such files are embedded into the KFN untouched.
 */
export function isMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // "ID3"
  // Frame sync: 11 set bits, then version bits (not 01 = reserved).
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08;
}

/**
 * Decode arbitrary audio bytes (mp3/wav/m4a…) to channel data + sample rate.
 * OfflineAudioContext(44100) resamples on decode.
 */
export async function decodeToChannels(bytes: Uint8Array): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  if (bytes.byteLength === 0) throw new Error('Пустое аудио.');
  const Ctor: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctor(1, 1, 44100);
  const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  return { channels, sampleRate: decoded.sampleRate };
}
