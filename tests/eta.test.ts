/**
 * ETA estimator: sliding-window speed, adaptation to rate changes, phase
 * resets, and the too-early/too-slow guards.
 */
import { test } from 'vitest';
import { createEta, formatRemaining } from '../src/lib/eta';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

test('constant rate → correct remaining time', () => {
  let t = 0;
  const eta = createEta(() => t);
  assert(eta.update(0) === null, 'single sample is not enough');
  t = 1000;
  assert(eta.update(0.1) === null, 'span below the minimum → no estimate yet');
  t = 3000;
  // Rate 0.3 per 3 s → remaining (1−0.3)/1e-4 = 7000 ms.
  const got = eta.update(0.3);
  assert(got === '~0:07', `got ${got}`);
});

test('the estimate follows speed changes (window rolls)', () => {
  let t = 0;
  const eta = createEta(() => t);
  // Slow start: 20% per 4 s…
  eta.update(0);
  t = 4000;
  eta.update(0.2);
  // …then a burst: +60% in 2 s. The mixed window (from t=0) still averages:
  // rate = 0.8/6000 → remaining 0.2/(1.33e-4) = 1500 ms.
  t = 6000;
  const mixed = eta.update(0.8);
  const mixedSec = mixed ? Number(mixed.slice(2).replace(':', '')) : -1; // "m" + "ss"
  assert(mixedSec === 1 || mixedSec === 2 || mixedSec === 102 || mixedSec === 202,
    `mixed-window estimate ≈1.5 s (got ${mixed})`);
  // 10 s later the slow samples left the window; the burst rate rules:
  // +6% per 2 s → remaining 0.14/(3e-5) ≈ 4667 ms.
  t = 16000;
  eta.update(0.8);
  t = 18000;
  const rolled = eta.update(0.86);
  assert(rolled === '~0:05', `rolled-window estimate follows the new speed (got ${rolled})`);
});

test('a phase reset (fraction jumps back) restarts the estimation', () => {
  let t = 0;
  const eta = createEta(() => t);
  eta.update(0.5);
  t = 3000;
  eta.update(0.6);
  t = 3100;
  // Phase 2 begins: fraction back to ~0 → the window clears, no estimate yet.
  assert(eta.update(0.01) === null, 'reset drops the history');
  t = 6000;
  // Fresh phase: df 0.19 over 2900 ms → remaining ≈ 12.2 s.
  const fresh = eta.update(0.2);
  assert(fresh === '~0:12', `fresh phase estimate (got ${fresh})`);
});

test('non-increasing progress yields no estimate (guard against stalls)', () => {
  let t = 0;
  const eta = createEta(() => t);
  eta.update(0.5);
  t = 5000;
  assert(eta.update(0.5) === null, 'df = 0 → no speed → null');
});

test('formatting', () => {
  assert(formatRemaining(0) === '~0:00', 'zero');
  assert(formatRemaining(83_000) === '~1:23', '1:23');
  assert(formatRemaining(725_000) === '~12:05', '12:05');
});
