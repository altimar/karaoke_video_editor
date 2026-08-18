/**
 * Minimal WAV (PCM 16-bit, stereo) encoder.
 *
 * Used to turn the separated instrumental PCM (Float32) back into a byte blob
 * that the existing audio pipeline (`audioEngine.loadBytes` / `audioLoader`)
 * can decode and store, exactly as if the user had loaded a WAV file by hand.
 *
 * Only what the app needs: stereo, 44.1 kHz, little-endian. No metadata chunks.
 */

/** Little-endian binary writer over a growable DataView. */
class Writer {
  private view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.view = new DataView(new ArrayBuffer(size));
  }

  /** Write an ASCII 4-byte chunk id ("RIFF", "fmt ", "data"). */
  str(s: string): void {
    for (let i = 0; i < 4; i++) this.view.setUint8(this.offset++, s.charCodeAt(i));
  }
  u32(v: number): void {
    this.view.setUint32(this.offset, v, true);
    this.offset += 4;
  }
  u16(v: number): void {
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }
  /** Clamp a float sample (-1..1) to signed 16-bit and write it. */
  s16(v: number): void {
    const c = Math.max(-1, Math.min(1, v));
    this.view.setInt16(this.offset, c < 0 ? c * 0x8000 : c * 0x7fff, true);
    this.offset += 2;
  }

  get bytes(): Uint8Array {
    return new Uint8Array(this.view.buffer);
  }
}

/**
 * Encode two equal-length mono Float32 channels as a stereo WAV file.
 * Channels shorter than the longest are zero-padded to match.
 */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
  const numFrames = Math.max(left.length, right.length);
  const bytesPerSample = 2; // 16-bit
  const channels = 2;
  const dataSize = numFrames * channels * bytesPerSample;
  const totalSize = 44 + dataSize; // 44-byte canonical header + PCM payload

  const w = new Writer(totalSize);
  // RIFF header
  w.str('RIFF');
  w.u32(36 + dataSize); // file size minus 8 (RIFF id + this field)
  w.str('WAVE');
  // fmt subchunk (PCM)
  w.str('fmt ');
  w.u32(16); // PCM fmt chunk size
  w.u16(1); // audio format = PCM
  w.u16(channels);
  w.u32(sampleRate);
  w.u32(sampleRate * channels * bytesPerSample); // byte rate
  w.u16(channels * bytesPerSample); // block align
  w.u16(16); // bits per sample
  // data subchunk
  w.str('data');
  w.u32(dataSize);
  // Interleaved samples (L,R,L,R…), clamped to int16.
  for (let i = 0; i < numFrames; i++) {
    w.s16(left[i] ?? 0);
    w.s16(right[i] ?? 0);
  }
  return w.bytes;
}

/**
 * Encode any channel layout through the (stereo) encoder: mono is duplicated
 * to both channels, layouts beyond stereo keep their first two channels.
 */
export function encodeWavChannels(channels: Float32Array[], sampleRate: number): Uint8Array {
  const left = channels[0] ?? new Float32Array(0);
  const right = channels.length > 1 ? channels[1] : left;
  return encodeWav(left, right, sampleRate);
}
