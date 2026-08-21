/**
 * Stem-editing primitives: chunk detection by relative silence (audioChunks)
 * and the pure PCM move core (audioEdit.moveSamples / moveSamplesRanges).
 */
import { test } from 'vitest';
import { detectChunksMs, chunkAtMs } from '../src/lib/audioChunks';
import { moveSamples, moveSamplesRanges } from '../src/lib/audioEdit';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const close = (a: number, b: number, eps = 0.001) => Math.abs(a - b) < eps;

/** One channel of `seconds` at `sampleRate`, filled with a sine in the given
 *  [start,end) second ranges (0.4 amplitude), silence elsewhere. */
function toneBursts(seconds: number, bursts: Array<[number, number]>, sampleRate = 1000): Float32Array[] {
  const data = new Float32Array(Math.round(seconds * sampleRate));
  for (const [s, e] of bursts) {
    const from = Math.round(s * sampleRate);
    const to = Math.round(e * sampleRate);
    for (let i = from; i < to && i < data.length; i++) {
      data[i] = 0.4 * Math.sin((2 * Math.PI * 10 * i) / sampleRate);
    }
  }
  return [data];
}

// --- detectChunksMs ---

test('detectChunksMs: phrases between silences become chunks (padded)', () => {
  // 4s: tone 1–2s, tone 3–3.5s, 60ms blip at 3.8s (too short → dropped).
  const chunks = detectChunksMs(toneBursts(4, [[1, 2], [3, 3.5], [3.8, 3.86]]), 1000);
  assert(chunks.length === 2, `two phrases expected, got ${JSON.stringify(chunks)}`);
  const [a, b] = chunks;
  // Padding (30ms) widens each phrase slightly beyond its true bounds.
  assert(a.startMs >= 950 && a.startMs <= 1000, `first chunk starts near 1000, got ${a.startMs}`);
  assert(a.endMs >= 2000 && a.endMs <= 2040, `first chunk ends near 2000, got ${a.endMs}`);
  assert(b.startMs >= 2950 && b.startMs <= 3000, `second chunk starts near 3000, got ${b.startMs}`);
  assert(b.endMs >= 3500 && b.endMs <= 3540, `second chunk ends near 3500, got ${b.endMs}`);
});

test('detectChunksMs: gaps shorter than the minimum silence merge into one chunk', () => {
  // Two 500ms phrases split by a 100ms breath — one chunk.
  const chunks = detectChunksMs(toneBursts(2, [[0.5, 1.0], [1.1, 1.6]]), 1000);
  assert(chunks.length === 1, `merged into one chunk, got ${JSON.stringify(chunks)}`);
  assert(chunks[0].startMs < 500 && chunks[0].endMs > 1600, 'spans both phrases');
});

test('detectChunksMs: all-sound buffer → one full-length chunk; silence → none', () => {
  const one = detectChunksMs(toneBursts(2, [[0, 2]]), 1000);
  assert(one.length === 1 && one[0].startMs === 0 && one[0].endMs === 2000, `single full chunk, got ${JSON.stringify(one)}`);
  const none = detectChunksMs(toneBursts(2, []), 1000);
  assert(none.length === 0, 'silent buffer → no chunks');
});

test('chunkAtMs: containment and tolerance', () => {
  const chunks = [{ startMs: 1000, endMs: 2000 }, { startMs: 3000, endMs: 3500 }];
  assert(chunkAtMs(chunks, 1500) === 0, 'inside first');
  assert(chunkAtMs(chunks, 3200) === 1, 'inside second');
  assert(chunkAtMs(chunks, 2500) === -1, 'in the gap → none');
  assert(chunkAtMs(chunks, 2960, 50) === 1, 'near edge within tolerance');
  assert(chunkAtMs(chunks, 2900, 50) === -1, 'outside tolerance');
});

// --- moveSamples ---

test('moveSamples: zeroes the source range and adds it into a longer destination', () => {
  const from = [new Float32Array(1000).fill(0.5)];
  const to = [new Float32Array(600).fill(0.1)];
  const { from: f, to: t } = moveSamples(from, to, 200, 400, 1000, 1000);
  assert(f[0].length === 1000, 'source length kept');
  assert(f[0][100] === 0.5 && f[0][500] === 0.5, 'outside the range untouched');
  assert(f[0][200] === 0 && f[0][399] === 0, 'range zeroed');
  assert(t[0].length === 600, 'destination length kept (already longer)');
  assert(close(t[0][100], 0.1), 'destination before the range untouched');
  assert(close(t[0][300], 0.6), 'destination inside the range = 0.1 + 0.5');
  // Inputs must not be mutated (0.1 is not exact in float32 — use close()).
  assert(from[0][200] === 0.5 && close(to[0][300], 0.1), 'inputs untouched');
});

test('moveSamples: zero-extends a shorter destination', () => {
  const from = [new Float32Array(1000).fill(0.5)];
  const to = [new Float32Array(300).fill(0.1)];
  const { to: t } = moveSamples(from, to, 400, 600, 1000, 1000);
  assert(t[0].length === 600, 'destination grown to fit the chunk');
  assert(close(t[0][100], 0.1), 'original samples kept');
  assert(close(t[0][500], 0.5), 'chunk lands at its position over silence');
  assert(t[0][350] === 0, 'gap between old end and chunk stays silent');
});

test('moveSamples: null destination = empty role, chunk at its position', () => {
  const from = [new Float32Array(1000).fill(0.5)];
  const { to: t } = moveSamples(from, null, 400, 600, 1000, 1000);
  assert(t.length === 1 && t[0].length === 600, 'single channel, chunk-length buffer');
  assert(close(t[0][500], 0.5) && t[0][100] === 0 && t[0][599] === 0.5, 'chunk at 400..600');
});

test('moveSamples: resamples when the rates differ', () => {
  const from = [new Float32Array(1000).fill(0.5)];
  const to = [new Float32Array(4000).fill(0.1)]; // 4× rate
  const { to: t } = moveSamples(from, to, 100, 300, 1000, 4000);
  // 200 source samples → 800 dest samples starting at dest offset 400.
  assert(close(t[0][200], 0.1), 'before the chunk untouched');
  assert(close(t[0][500], 0.6), 'inside the chunk = 0.1 + 0.5');
  assert(close(t[0][1199], 0.6), 'chunk still sounding at its last sample');
  assert(close(t[0][1400], 0.1), 'after the chunk back to 0.1');
});

test('moveSamples: wider chunk is averaged down into a narrower destination', () => {
  const L = new Float32Array(1000).fill(0.5);
  const R = new Float32Array(1000).fill(0.1);
  const mono = [new Float32Array(1000).fill(0.2)];
  const { to: t } = moveSamples([L, R], mono, 0, 400, 1000, 1000);
  assert(t.length === 1, 'mono destination stays mono');
  assert(close(t[0][200], 0.2 + 0.3), 'mono gets the (0.5+0.1)/2 average + its own 0.2');
});

// --- moveSamplesRanges (the rubber-band multi-chunk batch) ---

test('moveSamplesRanges: moves two disjoint spans in one pass', () => {
  const from = [new Float32Array(1000).fill(0.5)];
  const to = [new Float32Array(1000).fill(0.1)];
  const { from: f, to: t } = moveSamplesRanges(from, to, [[200, 300], [600, 800]], 1000, 1000);
  assert(f[0][250] === 0 && f[0][700] === 0, 'both spans zeroed in the source');
  assert(f[0][150] === 0.5 && f[0][500] === 0.5 && f[0][900] === 0.5, 'outside both spans untouched');
  assert(close(t[0][250], 0.6) && close(t[0][700], 0.6), 'both spans mixed in place');
  assert(close(t[0][500], 0.1), 'destination between the spans untouched');
});

test('moveSamplesRanges: equals sequential single-span moves', () => {
  const src = () => [Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 50) * 0.5)];
  const spans: Array<[number, number]> = [
    [100, 250],
    [400, 900],
  ];
  const batch = moveSamplesRanges(src(), [new Float32Array(1000).fill(0.1)], spans, 1000, 1000);
  let f = src();
  let t = [new Float32Array(1000).fill(0.1)];
  for (const [s, e] of spans) {
    const r = moveSamples(f, t, s, e, 1000, 1000);
    f = r.from;
    t = r.to;
  }
  for (let i = 0; i < 1000; i++) {
    assert(close(batch.from[0][i], f[0][i], 1e-6), `from[${i}] differs`);
    assert(close(batch.to[0][i], t[0][i], 1e-6), `to[${i}] differs`);
  }
});

test('moveSamplesRanges: null destination zero-extends to the farthest span', () => {
  const from = [new Float32Array(1000).fill(0.5)];
  const { to: t } = moveSamplesRanges(from, null, [[100, 150], [700, 750]], 1000, 1000);
  assert(t[0].length === 750, 'covers up to the last span');
  assert(t[0][125] === 0.5 && t[0][725] === 0.5, 'both chunks present');
  assert(t[0][50] === 0 && t[0][400] === 0, 'silence elsewhere');
});

test('moveSamplesRanges: degenerate spans are dropped, empty input changes nothing', () => {
  const from = [new Float32Array(10).fill(0.5)];
  const to = [new Float32Array(10).fill(0.1)];
  const { from: f, to: t } = moveSamplesRanges(from, to, [[5, 5], [8, 4]], 1000, 1000);
  assert(f[0].every((v) => v === 0.5) && t[0].every((v) => close(v, 0.1)), 'plain copies');
  assert(from[0][5] === 0.5 && close(to[0][5], 0.1), 'inputs untouched');
});
