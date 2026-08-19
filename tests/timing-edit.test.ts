/**
 * Timing-edit helpers: neighbor clamping, block-shift bounds, range removal,
 * and the timing validator (overlaps / out-of-duration).
 */
import { test } from 'vitest';
import { flatSyllables, clampBetweenNeighbors, rangeShiftBounds, removeTimingsAndShift, timingProblems, syllableCharOffset, serializeLyrics } from '../src/lib/textParser';
import { Line } from '../src/types';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

/** lines from [text, startMs] pairs ('' sep = same word, ' ' = new word). */
function makeLines(pairs: Array<Array<[string, number | null]>>): Line[] {
  return pairs.map((line) => ({
    syllables: line.map(([text, startMs], i) => ({ text, startMs, sep: i === 0 ? '' : ' ' })),
  }));
}

const LINES = makeLines([[['а', 0], ['бу', 500], ['ки', 1000]], [['вто', 2000], ['рая', 2500]]]);

test('clampBetweenNeighbors: sandwiched between timed neighbors', () => {
  const flat = flatSyllables(LINES);
  assert(clampBetweenNeighbors(flat, 1, 999, 10000) === 999, 'free inside the gap');
  assert(clampBetweenNeighbors(flat, 1, -50, 10000) === 0, 'left wall: previous syllable at 0');
  assert(clampBetweenNeighbors(flat, 1, 1500, 10000) === 1000, 'right wall: next syllable at 1000');
  assert(clampBetweenNeighbors(flat, 4, 999999, 10000) === 10000, 'last syllable clamped to duration');
});

test('rangeShiftBounds: block keeps between outer neighbors and [0, duration]', () => {
  const flat = flatSyllables(LINES);
  // Block [1..3] = 500..2000; left neighbor at 0, right neighbor at 2500.
  let b = rangeShiftBounds(flat, 1, 3, 10000);
  assert(b.lo === -500 && b.hi === 500, `±500 expected, got ${JSON.stringify(b)}`);
  // Block [0..4] = whole song: only global walls.
  b = rangeShiftBounds(flat, 0, 4, 10000);
  assert(b.lo === 0 && b.hi === 7500, `0..7500 expected, got ${JSON.stringify(b)}`);
  // Untimed-only range: no-op.
  const untimed = makeLines([[['x', null], ['y', null]]]);
  b = rangeShiftBounds(flatSyllables(untimed), 0, 1, 10000);
  assert(b.lo === 0 && b.hi === 0, 'nothing timed → zero bounds');
});

test('removeTimingsAndShift: marker removed, tail timings pull back, text untouched', () => {
  const lines = makeLines([[['а', 0], ['б', 500], ['в', 1000], ['г', 1500]]]);
  const next = removeTimingsAndShift(lines, 1, 1);
  assert(next.length === 1, 'the text (line structure) is untouched');
  const starts = next[0].syllables.map((s) => s.startMs);
  assert(JSON.stringify(starts) === JSON.stringify([0, 1000, 1500, null]),
    `tail pulled back + last untimed, got ${JSON.stringify(starts)}`);
  // Inputs untouched.
  assert(lines[0].syllables[1].startMs === 500, 'input not mutated');
});

test('removeTimingsAndShift: a range removes several markers at once', () => {
  const lines = makeLines([[['а', 0], ['б', 500], ['в', 1000], ['г', 1500], ['д', 2000]]]);
  const next = removeTimingsAndShift(lines, 1, 2);
  const starts = next[0].syllables.map((s) => s.startMs);
  assert(JSON.stringify(starts) === JSON.stringify([0, 1500, 2000, null, null]),
    `two markers gone, tail pulled back by two, got ${JSON.stringify(starts)}`);
});

test('removeTimingsAndShift: works across line boundaries', () => {
  const lines = makeLines([[['а', 0], ['б', 500]], [['в', 1000], ['г', 1500]]]);
  const next = removeTimingsAndShift(lines, 1, 1);
  assert(next.length === 2, 'both lines remain');
  const starts = next.flatMap((l) => l.syllables.map((s) => s.startMs));
  assert(JSON.stringify(starts) === JSON.stringify([0, 1000, 1500, null]),
    `flat shift crosses lines, got ${JSON.stringify(starts)}`);
});

test('timingProblems: marks the later syllable of overlaps and beyond-duration starts', () => {
  const lines = makeLines([
    [['а', 0], ['б', 0], ['в', 500], ['г', 400], ['д', 900]],
  ]);
  const bad = timingProblems(lines, 1000);
  // б(0) ≤ а(0) → zero duration; г(400) < в(500) → overlap.
  assert(bad.size === 2 && bad.has(1) && bad.has(3), `indices 1 and 3, got ${[...bad]}`);
  // Out of duration.
  const beyond = makeLines([[['х', 5000]]]);
  const bad2 = timingProblems(beyond, 1000);
  assert(bad2.size === 1 && bad2.has(0), 'beyond-duration syllable marked');
  // Clean timing → empty.
  assert(timingProblems(LINES, 10000).size === 0, 'monotonic in-duration timing is clean');
});

test('syllableCharOffset matches serializeLyrics positions', () => {
  const lines = makeLines([
    [['при', 0], ['вет', 500]],      // "привет"
    [['мир', 900], ['и', 1000], ['я', 1100]], // "мир и я"
  ]);
  // makeLines uses ' ' seps → rendered: "при вет\nмир и я".
  const text = serializeLyrics(lines);
  const expectAt = (li: number, si: number, sylText: string): void => {
    const off = syllableCharOffset(lines, li, si);
    assert(text.startsWith(sylText, off), `offset ${off} should point at "${sylText}" in "${JSON.stringify(text)}"`);
  };
  expectAt(0, 0, 'при');
  expectAt(0, 1, 'вет'); // after a space sep
  expectAt(1, 0, 'мир'); // line start (after the newline)
  expectAt(1, 1, 'и');   // after a space sep
  expectAt(1, 2, 'я');
  // Every non-slash sep renders as one space char (sep '' only opens a line).
  const gapLines = [{ syllables: [
    { text: 'при', startMs: 0, sep: '' },
    { text: 'вет', startMs: 5, sep: ' ' },
  ] }];
  assert(serializeLyrics(gapLines) === 'при вет', 'space sep renders as one gap');
  assert(syllableCharOffset(gapLines, 0, 1) === 4, `offset after a space sep, got ${syllableCharOffset(gapLines, 0, 1)}`);
  // Slash seps count as one char.
  const slashed: Array<Array<[string, number | null]>> = [[['а', 0], ['б', 1], ['в', 2]]];
  const slashedLines = [{ syllables: [
    { text: 'а', startMs: 0, sep: '' },
    { text: 'б', startMs: 1, sep: '/' },
    { text: 'в', startMs: 2, sep: '/' },
  ] }];
  const slashedText = serializeLyrics(slashedLines);
  assert(slashedText === 'а/б/в', `slash rendering, got ${JSON.stringify(slashedText)}`);
  assert(syllableCharOffset(slashedLines, 0, 1) === 2, `slash sep offset, got ${syllableCharOffset(slashedLines, 0, 1)}`);
  void slashed;
});
