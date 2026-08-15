/**
 * Test volume automation helpers (gainAtTime interpolation + point ops).
 */
import { test } from 'vitest';
import { gainAtTime, insertPoint, removePoint, movePoint, clampGain } from '../src/lib/volumeAutomation';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const close = (a: number, b: number, eps = 0.001) => Math.abs(a - b) < eps;

test('gainAtTime: empty automation → gain 1.0 everywhere', () => {
  assert(gainAtTime([], 0) === 1.0, 'empty automation → gain 1.0');
  assert(gainAtTime([], 5000) === 1.0, 'empty automation → gain 1.0 at any time');
});

test('gainAtTime: single point holds flat', () => {
  assert(gainAtTime([{ timeMs: 0, gain: 0.5 }], 1000) === 0.5, 'single point holds flat');
  assert(gainAtTime([{ timeMs: 1000, gain: 0.5 }], 0) === 0.5, 'before first point → first gain');
  assert(gainAtTime([{ timeMs: 1000, gain: 2.0 }], 5000) === 2.0, 'after last point → last gain');
});

test('gainAtTime: two points — linear interpolation', () => {
  const pts = [{ timeMs: 0, gain: 0 }, { timeMs: 1000, gain: 1.0 }];
  assert(close(gainAtTime(pts, 0), 0), 'at first point → its gain');
  assert(close(gainAtTime(pts, 1000), 1.0), 'at second point → its gain');
  assert(close(gainAtTime(pts, 500), 0.5), 'midpoint → 0.5 (linear ramp)');
  assert(close(gainAtTime(pts, 250), 0.25), 'quarter → 0.25');
  assert(close(gainAtTime(pts, 750), 0.75), 'three-quarter → 0.75');
});

test('gainAtTime: three points — piecewise linear', () => {
  const pts3 = [
    { timeMs: 0, gain: 1.0 },
    { timeMs: 1000, gain: 0.0 },
    { timeMs: 2000, gain: 2.0 },
  ];
  assert(close(gainAtTime(pts3, 500), 0.5), '3 pts: midpoint of seg1');
  assert(close(gainAtTime(pts3, 1500), 1.0), '3 pts: midpoint of seg2 (0→2)');
});

test('insertPoint adds, keeps sorted, dedups by time', () => {
  let arr: Array<{ timeMs: number; gain: number }> = [];
  arr = insertPoint(arr, { timeMs: 1000, gain: 1.0 });
  arr = insertPoint(arr, { timeMs: 0, gain: 0.5 });
  arr = insertPoint(arr, { timeMs: 500, gain: 0.8 });
  assert(arr.length === 3, `insertPoint adds (got ${arr.length})`);
  assert(arr[0].timeMs === 0 && arr[1].timeMs === 500 && arr[2].timeMs === 1000, 'insertPoint keeps sorted');
  // Replace at same time.
  arr = insertPoint(arr, { timeMs: 500, gain: 1.5 });
  assert(arr.length === 3, `insertPoint dedup by time (got ${arr.length})`);
  assert(arr[1].gain === 1.5, 'insertPoint replaces same-time point');
});

test('removePoint removes', () => {
  let arr: Array<{ timeMs: number; gain: number }> = [
    { timeMs: 0, gain: 0.5 },
    { timeMs: 500, gain: 1.5 },
    { timeMs: 1000, gain: 1.0 },
  ];
  arr = removePoint(arr, 500);
  assert(arr.length === 2, `removePoint removes (got ${arr.length})`);
  assert(!arr.some((p) => p.timeMs === 500), 'removed point gone');
});

test('movePoint re-sorts when the time changes', () => {
  let m = [{ timeMs: 0, gain: 1 }, { timeMs: 1000, gain: 2 }];
  m = movePoint(m, 0, { timeMs: 1500, gain: 0.5 });
  assert(m[0].timeMs === 1000 && m[1].timeMs === 1500, 'movePoint re-sorts when time changes');
  assert(m[1].gain === 0.5, 'movePoint updates gain');
});

test('clampGain bounds', () => {
  assert(clampGain(-1) === 0, 'clampGain lower bound 0');
  assert(clampGain(3) === 2, 'clampGain upper bound 2');
  assert(clampGain(1.5) === 1.5, 'clampGain passes valid value');
});
