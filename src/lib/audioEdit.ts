/**
 * Stem editing — moving a time range of audio ("phrase") from one role to
 * another, in place.
 *
 * The stem separator sometimes assigns a phrase to the wrong role (a lead line
 * ends up in the backing stem, or an instrument bleeds into the backing vocal).
 * The timeline's edit tool lets the user drag such a phrase chunk onto another
 * audio track; this module performs the actual PCM surgery:
 *
 *  - the source range is zeroed (silence — the phrase now lives elsewhere);
 *  - the same range is ADDED ("mixed") into the destination at the same time
 *    position (the destination is zero-extended when shorter);
 *  - both roles are re-encoded to WAV and pushed back through the regular
 *    audioLoader pipeline, so playback, waveform, export and save/load all see
 *    the edited audio with zero special cases.
 *
 * The 'original' role is never editable — it is the reference the separator
 * and aligner ran against; cutting it up would break re-running them.
 *
 * The pure core (`moveSamples`) works on plain channel data and is unit
 * tested in Node; the browser integration (`moveChunkToRole`) owns buffers,
 * encoding and the audio engine.
 */
import { audioEngine } from './audioEngine';
import { loadAudioBytesIntoRole } from './audioLoader';
import { encodeWav } from './wavEncoder';
import { AudioRole, getAudioTrackByRole } from '../types';
import { store } from '../state/store';

/** Roles whose audio can be dragged around (everything except the reference original). */
export function isEditableRole(role: AudioRole): boolean {
  return role !== 'original';
}

/**
 * Pure core: cut [start, end) (source-rate samples) out of `from` (zeroed in
 * the copy) and mix it into `to` at the same TIME position (the destination is
 * zero-extended when shorter; `to === null` = empty role, the chunk becomes
 * its first audio). Resamples the chunk linearly when the rates differ, and
 * maps channel counts (a wider chunk is averaged down, a narrower one fills
 * the first channels). Never mutates the inputs.
 */
export function moveSamples(
  from: Float32Array[],
  to: Float32Array[] | null,
  start: number,
  end: number,
  fromRate: number,
  toRate: number,
): { from: Float32Array[]; to: Float32Array[] } {
  const fromLen = from[0]?.length ?? 0;
  const s = Math.max(0, Math.min(fromLen, start));
  const e = Math.max(s, Math.min(fromLen, end));

  const fromOut = from.map((ch) => ch.slice());
  for (const ch of fromOut) ch.fill(0, s, e);

  // The chunk, resampled to the destination rate.
  const chunk = from.map((ch) => ch.slice(s, e));
  const chunkRes = fromRate === toRate ? chunk : chunk.map((ch) => resampleLinear(ch, fromRate, toRate));
  const destOffset = Math.round((s / fromRate) * toRate);

  const destChCount = to ? to.length : chunkRes.length;
  const destLen = to ? (to[0]?.length ?? 0) : 0;
  const outLen = Math.max(destLen, destOffset + (chunkRes[0]?.length ?? 0));
  const toOut: Float32Array[] = [];
  for (let c = 0; c < destChCount; c++) {
    const arr = new Float32Array(outLen);
    if (to && to[c]) arr.set(to[c]);
    toOut.push(arr);
  }
  // Map the chunk's channels onto the destination's (averaged when wider).
  const mix = chunkRes.length > destChCount ? mixdown(chunkRes) : chunkRes;
  for (let c = 0; c < Math.min(mix.length, destChCount); c++) {
    const dst = toOut[c];
    const src = mix[c];
    for (let i = 0; i < src.length; i++) dst[destOffset + i] += src[i];
  }
  return { from: fromOut, to: toOut };
}

/** Linear-interpolation resample between sample rates (good enough for edits). */
function resampleLinear(data: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return data;
  const outLen = Math.max(1, Math.round((data.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(data.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = data[i0] * (1 - t) + data[i1] * t;
  }
  return out;
}

/** Average all channels into one mono channel. */
function mixdown(channels: Float32Array[]): Float32Array[] {
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) out[i] += ch[i];
  const n = channels.length;
  for (let i = 0; i < len; i++) out[i] /= n;
  return [out];
}

/** Encode channels as a stereo WAV (mono is duplicated to both channels). */
function encodeRoleWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const left = channels[0] ?? new Float32Array(0);
  const right = channels.length > 1 ? channels[1] : left;
  return encodeWav(left, right, sampleRate);
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c).slice());
  return out;
}

/**
 * Move [startMs, endMs) of one role's audio into another role (mixed in at the
 * same time position) and reload both roles through the audio pipeline.
 * Returns false (and changes nothing) for invalid moves.
 */
export async function moveChunkToRole(
  fromRole: AudioRole,
  toRole: AudioRole,
  startMs: number,
  endMs: number,
): Promise<boolean> {
  if (fromRole === toRole) return false;
  if (!isEditableRole(fromRole) || !isEditableRole(toRole)) return false;
  const fromBuf = audioEngine.getBuffer(fromRole);
  if (!fromBuf) return false;
  const toBuf = audioEngine.getBuffer(toRole);
  const fromRate = fromBuf.sampleRate;
  const toRate = toBuf?.sampleRate ?? fromRate;

  const s = Math.max(0, Math.round((startMs / 1000) * fromRate));
  const e = Math.min(fromBuf.length, Math.round((endMs / 1000) * fromRate));
  if (e <= s) return false;

  const { from, to } = moveSamples(channelsOf(fromBuf), toBuf ? channelsOf(toBuf) : null, s, e, fromRate, toRate);

  // Keep each role's filename (the destination of an empty slot inherits the
  // source's — the audio in it now comes from that stem).
  const p = store.getProject();
  const fromName = getAudioTrackByRole(p, fromRole)?.audioFileName || 'stem.wav';
  const toName = getAudioTrackByRole(p, toRole)?.audioFileName || fromName;

  // Swapping a voice's src resets its position — restore it (and playback).
  const wasPlaying = audioEngine.isPlaying;
  const pos = audioEngine.currentTimeMs;
  await loadAudioBytesIntoRole(fromRole, encodeRoleWav(from, fromRate), fromName);
  await loadAudioBytesIntoRole(toRole, encodeRoleWav(to, toRate), toName);
  audioEngine.seek(Math.min(pos, audioEngine.durationMs));
  if (wasPlaying) void audioEngine.play();
  return true;
}
