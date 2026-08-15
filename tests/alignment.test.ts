/**
 * Unit tests for the pure CTC forced-alignment math (lib/alignment/ctc.ts).
 * No model needed — logits are synthetic.
 */
import { test } from 'vitest';
import {
  BLANK_ID,
  VOCAB_SIZE,
  flattenSyllablesForAlignment,
  buildWords,
  buildTranscript,
  ctcForcedAlign,
  stitchChunks,
  distributeSyllableTimes,
} from '../src/lib/alignment/ctc';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

// --- transcript building ---

const lines = [
  {
    syllables: [
      { text: 'Hel', sep: '', startMs: null },
      { text: 'lo', sep: '/', startMs: null },
      { text: 'world', sep: ' ', startMs: null },
    ],
  },
  {
    syllables: [
      { text: 'la', sep: '', startMs: null },
      { text: 'la', sep: '/', startMs: null },
    ],
  },
] as any;

test('flatten + buildWords: space splits words, slash keeps them together', () => {
  const flat = flattenSyllablesForAlignment(lines);
  assert(flat.length === 5, `5 syllables (got ${flat.length})`);
  const words = buildWords(flat);
  assert(words.length === 3, `3 words: Hello / world / lala (got ${words.length})`);
  assert(words[0].syllables.join(',') === '0,1', 'word 1 = Hel/lo');
  assert(words[1].syllables.join(',') === '2', 'word 2 = world');
  assert(words[2].syllables.join(',') === '3,4', 'word 3 = la/la');
  assert(words[0].tokenIds.join(',') === '11,5,15,15,8', `tokens for HELLO (got ${words[0].tokenIds})`);
});

test('buildWords strips punctuation and unknown letters', () => {
  const flat = flattenSyllablesForAlignment([
    { syllables: [{ text: "Hey,',", sep: '', startMs: null }] },
  ] as any);
  const words = buildWords(flat);
  // H=11 E=5 Y=22 '=27 — comma and quote-quote dropped except the vocab apostrophe.
  assert(words[0].tokenIds.join(',') === '11,5,22,27', `HEY' tokens (got ${words[0].tokenIds})`);
});

test('buildTranscript joins words with separators and skips token-less words', () => {
  const flat = flattenSyllablesForAlignment(lines);
  const words = buildWords(flat);
  const { tokens, tokenWord } = buildTranscript(words);
  // HEL|LO|WORLD|LA|LA with '|' (id 4) between the 3 words → 2 separators.
  const seps = tokenWord.filter((w) => w === -1).length;
  assert(seps === 2, `2 separators (got ${seps})`);
  assert(tokens.length === words.reduce((s, w) => s + w.tokenIds.length, 0) + seps, 'token count');
  // Token-less words are skipped entirely.
  const withEmpty = [
    { syllables: [0], tokenIds: [] },
    { syllables: [1], tokenIds: [5] },
  ] as any;
  const t2 = buildTranscript(withEmpty);
  assert(t2.tokens.length === 1 && t2.tokenWord[0] === 1, 'empty word skipped, no leading separator');
});

// --- Viterbi on synthetic logits ---

/** Build [T, V] logits: `script` maps frame → token id; everything else is blank. */
function synthLogits(T: number, script: Array<[number, number]>, secondBest = -5): Float32Array {
  const lp = new Float32Array(T * VOCAB_SIZE).fill(secondBest);
  for (let t = 0; t < T; t++) lp[t * VOCAB_SIZE + BLANK_ID] = 0;
  for (const [t, tok] of script) {
    lp[t * VOCAB_SIZE + BLANK_ID] = secondBest;
    lp[t * VOCAB_SIZE + tok] = 0;
  }
  return lp;
}

test('forcedAlign: places distinct tokens at their frames', () => {
  // Transcript "AB" (A=7, B=24): A emitted at frame 3, B at frame 10.
  const T = 20;
  const lp = synthLogits(T, [[3, 7], [10, 24]]);
  const { frames } = ctcForcedAlign(lp, T, VOCAB_SIZE, [7, 24]);
  assert(frames[0] === 3, `A at frame 3 (got ${frames[0]})`);
  assert(frames[1] === 10, `B at frame 10 (got ${frames[1]})`);
});

test('forcedAlign: repeated tokens need the skip-blank transition', () => {
  // "AA": CTC cannot emit A twice in a row without a blank between — the
  // aligner must use the skip-over-blank path or blank frames in between.
  const T = 15;
  const lp = synthLogits(T, [[2, 7], [8, 7]]);
  const { frames } = ctcForcedAlign(lp, T, VOCAB_SIZE, [7, 7]);
  assert(frames[0] === 2, `first A at 2 (got ${frames[0]})`);
  assert(frames[1] === 8, `second A at 8 (got ${frames[1]})`);
});

test('forcedAlign: tokens emitted across a long stretch stay ordered', () => {
  // "HELLO WORLD" style long token stream — verify strict frame ordering.
  const toks = [11, 5, 21, 21, 14, 4, 18, 14, 13, 21, 14]; // HELLO|WORLD
  const T = 200;
  const script: Array<[number, number]> = [];
  toks.forEach((tok, i) => script.push([5 + i * 16, tok]));
  const lp = synthLogits(T, script);
  const { frames } = ctcForcedAlign(lp, T, VOCAB_SIZE, toks);
  for (let i = 1; i < toks.length; i++) {
    assert(frames[i] >= frames[i - 1], `frame order at token ${i}: ${frames[i - 1]} → ${frames[i]}`);
  }
  assert(frames[0] === 5 && frames[10] === 5 + 10 * 16, 'endpoints exact');
});

// --- chunk stitching ---

test('stitchChunks keeps [0,keep) of every chunk but the last', () => {
  const V = 2;
  const mk = (vals: number[]) => ({ logits: new Float32Array(vals.flatMap((v) => [v, v + 0.1])), frames: vals.length, keep: vals.length - 2 });
  const merged = stitchChunks([mk([1, 2, 3, 4, 5]), mk([6, 7, 8, 9])], V);
  // chunk1 keeps 3 frames (1,2,3), chunk2 keeps all 4 → 7 frames.
  assert(merged.length === 7 * V, `7 frames (got ${merged.length / V})`);
  assert(merged[0] === 1 && merged[3 * V] === 6 && merged[6 * V] === 9, 'values in order');
});

// --- syllable time distribution ---

test('distributeSyllableTimes proportional: splits a word span by letter weight', () => {
  const flat = flattenSyllablesForAlignment(lines); // Hel(3)/lo(2) | world(5) | la(2)/la(2)
  const words = buildWords(flat);
  const { tokens, tokenWord } = buildTranscript(words);
  // Craft frames: word HELLO spans frames 10..50, WORLD 60..90, LALA 100..140.
  const frames = new Int32Array(tokens.length).fill(-1);
  let ti = 0;
  words.forEach((w, wi) => {
    if (w.tokenIds.length === 0) return;
    if (tokenWord[ti] === -1) ti++;
    const from = [10, 60, 100][wi];
    const to = [50, 90, 140][wi];
    const n = w.tokenIds.length;
    w.tokenIds.forEach((_, k, arr) => {
      frames[ti++] = Math.round(from + ((to - from) * k) / Math.max(1, n - 1));
      void arr;
    });
  });
  const frameMs = 20;
  const starts = distributeSyllableTimes(words, tokenWord, frames, flat, frameMs, 3000, 'proportional');
  // HELLO span = 200..1000ms. Hel(3 letters)/lo(2): lo starts at 200 + 800*3/5 = 680.
  assert(starts[0] === 200, `Hel at word start 200 (got ${starts[0]})`);
  assert(Math.abs(starts[1] - 680) <= 1, `lo at 680 (got ${starts[1]})`);
  // world: single syllable at its word start 60*20=1200.
  assert(starts[2] === 1200, `world at 1200 (got ${starts[2]})`);
  // LALA span 2000..2800: la/la equal weights → 2000 and 2400.
  assert(starts[3] === 2000, `la1 at 2000 (got ${starts[3]})`);
  assert(Math.abs(starts[4] - 2400) <= 1, `la2 at 2400 (got ${starts[4]})`);
  // Strictly increasing overall.
  for (let i = 1; i < starts.length; i++) assert(starts[i] > starts[i - 1], `monotonic at ${i}`);
});

test('distributeSyllableTimes: punctuation-only words get interpolated', () => {
  const flat = flattenSyllablesForAlignment([
    { syllables: [{ text: 'a', sep: '', startMs: null }] },
    { syllables: [{ text: '—', sep: ' ', startMs: null }] }, // no letters at all
    { syllables: [{ text: 'b', sep: ' ', startMs: null }] },
  ] as any);
  const words = buildWords(flat);
  const { tokens, tokenWord } = buildTranscript(words);
  const frames = new Int32Array(tokens.length).fill(-1);
  // a at frame 10 (200ms), b at frame 100 (2000ms).
  frames[0] = 10;
  frames[tokens.length - 1] = 100;
  const starts = distributeSyllableTimes(words, tokenWord, frames, flat, 20, 5000, 'proportional');
  assert(starts[0] === 200, `a at 200 (got ${starts[0]})`);
  assert(starts[2] === 2000, `b at 2000 (got ${starts[2]})`);
  assert(starts[1] > 200 && starts[1] < 2000, `dash interpolated between (got ${starts[1]})`);
});

test('distributeSyllableTimes chars: syllable starts at its first letter frame', () => {
  const flat = flattenSyllablesForAlignment(lines); // Hel/lo world la/la
  const words = buildWords(flat);
  const { tokens, tokenWord } = buildTranscript(words);
  // HELLO: H@10 E@20 L@30 L@40 O@50 → Hel starts 200ms, lo starts 30*20=600ms.
  const frames = new Int32Array(tokens.length).fill(-1);
  let ti = 0;
  words.forEach((w, wi) => {
    if (w.tokenIds.length === 0) return;
    if (tokenWord[ti] === -1) ti++;
    const base = [10, 60, 100][wi];
    w.tokenIds.forEach((_, k) => { frames[ti++] = base + k * 10; });
  });
  const starts = distributeSyllableTimes(words, tokenWord, frames, flat, 20, 3000, 'chars');
  assert(starts[0] === 200, `Hel at H frame (got ${starts[0]})`);
  // 'Hel' consumes H,E,L (frames 10,20,30); 'lo' starts at the 2nd L (frame 40).
  assert(starts[1] === 800, `lo at 2nd L frame 800 (got ${starts[1]})`);
});
