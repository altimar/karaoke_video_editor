// @vitest-environment jsdom
/**
 * Timing capture: the record cursor seeds from the PLAYHEAD position — seeking
 * mid-song and pressing Record re-records the tail, not the first untimed
 * syllable of the whole track.
 */
import { test, beforeEach, afterEach } from 'vitest';
import { timingCapture } from '../src/lib/timing';
import { audioEngine } from '../src/lib/audioEngine';
import { store } from '../src/state/store';
import { createDefaultProject, Syllable } from '../src/types';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

/** Seed the store with an active text track of the given syllable timings. */
function loadSyllables(starts: Array<number | null>): void {
  const p = createDefaultProject();
  const text = p.tracks.find((t) => t.type === 'text')!;
  const syllables: Syllable[] = starts.map((startMs, i) => ({ text: `s${i}`, startMs, sep: i === 0 ? '' : ' ' }));
  text.lines = [{ syllables }];
  p.activeTrackId = text.id;
  store.setProject(p);
}

/** Shadow the engine's currentTimeMs getter (no voices exist in tests). */
function setPlayhead(ms: number): void {
  Object.defineProperty(audioEngine, 'currentTimeMs', { get: () => ms, configurable: true });
}
function clearPlayhead(): void {
  delete (audioEngine as unknown as Record<string, unknown>).currentTimeMs;
}

beforeEach(() => loadSyllables([0, 1000, 2000, 3000, null, null]));
afterEach(() => {
  if (timingCapture.isRecording()) timingCapture.stop();
  clearPlayhead();
});

test('playhead mid-song → cursor starts at the first syllable ahead of it', () => {
  setPlayhead(1500);
  timingCapture.start();
  assert(timingCapture.getCursor() === 2, `syllable @2000 expected, got ${timingCapture.getCursor()}`);
});

test('playhead exactly on a marker (within tolerance) → that syllable itself', () => {
  setPlayhead(2000);
  timingCapture.start();
  assert(timingCapture.getCursor() === 2, `on-marker tolerance picks @2000, got ${timingCapture.getCursor()}`);
  setPlayhead(2300); // beyond the 200 ms tolerance → the NEXT syllable
  timingCapture.stop();
  timingCapture.start();
  assert(timingCapture.getCursor() === 3, `past-marker picks @3000, got ${timingCapture.getCursor()}`);
});

test('playhead at the start → cursor 0', () => {
  setPlayhead(0);
  timingCapture.start();
  assert(timingCapture.getCursor() === 0, `cursor 0 expected, got ${timingCapture.getCursor()}`);
});

test('nothing timed ahead (untimed tail) → first untimed syllable', () => {
  setPlayhead(9000);
  timingCapture.start();
  assert(timingCapture.getCursor() === 4, `first untimed (4) expected, got ${timingCapture.getCursor()}`);
});

test('fully untimed track → cursor 0 regardless of playhead', () => {
  loadSyllables([null, null, null]);
  setPlayhead(5000);
  timingCapture.start();
  assert(timingCapture.getCursor() === 0, `cursor 0 expected, got ${timingCapture.getCursor()}`);
});

test('playhead past a fully timed track → cursor at the end (nothing to stamp)', () => {
  loadSyllables([0, 1000, 2000]);
  setPlayhead(999999);
  timingCapture.start();
  assert(timingCapture.getCursor() === 3, `cursor = length expected, got ${timingCapture.getCursor()}`);
});
