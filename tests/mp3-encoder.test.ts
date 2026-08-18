/**
 * Tests for the KFN MP3 encoder: pure-JS LAME (works in Node), so the encode
 * path itself is testable headless — tone in, valid MP3 stream out.
 */
import { test } from 'vitest';
import { encodeMp3Channels, isMp3, MP3_KBPS } from '../src/lib/mp3Encoder';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

test('encodes a tone to a valid MP3 stream', async () => {
  const sampleRate = 44100;
  const seconds = 1;
  const n = sampleRate * seconds;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    R[i] = 0.5 * Math.sin((2 * Math.PI * 660 * i) / sampleRate);
  }
  const mp3 = await encodeMp3Channels([L, R], sampleRate);
  // Valid stream: recognized by the mp3 sniffer (sync or ID3).
  assert(isMp3(mp3), 'encoded bytes pass the mp3 sniff');
  // Size sanity: 1 s at 192 kbps ≈ 24 KB (±30%).
  const expected = (MP3_KBPS * 1000 / 8) * seconds;
  assert(mp3.length > expected * 0.7 && mp3.length < expected * 1.3, `size near ${expected} B (got ${mp3.length})`);
});

test('mono input encodes too', async () => {
  const sampleRate = 44100;
  const n = sampleRate / 2;
  const M = new Float32Array(n);
  for (let i = 0; i < n; i++) M[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / sampleRate);
  const mp3 = await encodeMp3Channels([M], sampleRate);
  assert(isMp3(mp3), 'mono mp3 passes the sniff');
});

test('isMp3 sniffs headers, rejects WAV/other', () => {
  assert(isMp3(new Uint8Array([0x49, 0x44, 0x33, 0x03])), 'ID3 header detected');
  assert(isMp3(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), 'frame sync detected');
  assert(!isMp3(new Uint8Array([0x52, 0x49, 0x46, 0x46])), 'WAV (RIFF) rejected');
  assert(!isMp3(new Uint8Array([0x00, 0x00, 0x0f, 0x20])), 'random bytes rejected');
  assert(!isMp3(new Uint8Array([0xff, 0x08, 0x00, 0x00])), 'reserved version bits rejected');
});
