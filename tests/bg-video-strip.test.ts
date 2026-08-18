/**
 * Tests for stripVideoOnlyMp4: the background video is remuxed to its video
 * track only (audio dropped, video packets copied). Uses the real E2E fixture
 * (e2e/fixtures/bg-sample.mp4 — H.264 + one AAC track, 2 s), produced by the
 * app's own export pipeline. Mediabunny's demux/mux is pure JS, so this runs
 * in Node without WebCodecs.
 */
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { Input, BlobSource, ALL_FORMATS } from 'mediabunny';
import { stripVideoOnlyMp4 } from '../src/lib/backgroundVideo';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const FIXTURE = 'e2e/fixtures/bg-sample.mp4';

async function inspect(bytes: Uint8Array): Promise<{ video: string | null; audioCount: number; duration: number }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes])) });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getAudioTracks();
  return {
    video: video?.codec ?? null,
    audioCount: audio.length,
    duration: video ? await video.computeDuration() : 0,
  };
}

test('strips the audio track, keeps the video track and duration', async () => {
  const original = new Uint8Array(readFileSync(FIXTURE));
  const before = await inspect(original);
  assert(before.audioCount === 1, `fixture has 1 audio track (got ${before.audioCount})`);
  assert(before.video !== null, 'fixture has a video track');

  const stripped = await stripVideoOnlyMp4(original);
  const after = await inspect(stripped);
  assert(after.audioCount === 0, `audio removed (got ${after.audioCount} tracks)`);
  assert(after.video === before.video, `video codec preserved (got ${after.video})`);
  assert(Math.abs(after.duration - before.duration) < 0.05, `duration preserved (got ${after.duration}, want ${before.duration})`);
  assert(stripped.byteLength < original.byteLength, `result is smaller (${stripped.byteLength} < ${original.byteLength})`);
});

test('already-clean video passes through untouched (no rewrite)', async () => {
  const original = new Uint8Array(readFileSync(FIXTURE));
  const once = await stripVideoOnlyMp4(original);
  const twice = await stripVideoOnlyMp4(once);
  assert(twice === once, 'second run returns the same bytes object — nothing to strip');
});

test('garbage bytes fall back to the original (no throw)', async () => {
  const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xff]);
  const out = await stripVideoOnlyMp4(garbage);
  assert(out === garbage, 'unparseable input returned as-is');
});
