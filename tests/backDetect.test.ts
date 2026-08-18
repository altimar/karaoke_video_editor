/**
 * Backing-vocals detector (separation post-check): quiet-everywhere lead
 * leakage → no back stem; real (or chorus-only) backing vocals → keep.
 */
import { test } from 'vitest';
import { detectBackingVocals } from '../src/lib/backDetect';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const SR = 44100;

/** 20 s of vocal-like signal: sine bursts (2 s on / 1 s off), given amplitude. */
function bursts(amp: number, seconds = 20, freq = 220): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const on = Math.floor(t / 3) % 2 === 0 && t % 3 < 2; // 2 s sound, 1 s pause
    if (on) out[i] = amp * Math.sin(2 * Math.PI * freq * t);
  }
  return out;
}

/** Same envelope but a different pitch — an independent voice. */
function burstsOther(amp: number): Float32Array {
  return bursts(amp, 20, 331);
}

test('quiet copy of the lead everywhere → leakage (no backing vocals)', () => {
  const lead = bursts(0.5);
  const back = bursts(0.05); // -20 dB copy
  const v = detectBackingVocals(lead, back, SR);
  assert(v.backVocals === false, `leakage expected, got ${JSON.stringify(v)}`);
  assert(v.ratioDb < -15, `overall ratio far below lead, got ${v.ratioDb.toFixed(1)} dB`);
});

test('silent back → leakage', () => {
  const v = detectBackingVocals(bursts(0.5), new Float32Array(20 * SR), SR);
  assert(v.backVocals === false, 'digital silence is never a backing vocal');
});

test('independent voice at a comparable level → backing vocals', () => {
  const lead = bursts(0.5);
  const back = burstsOther(0.3); // -4.4 dB, different content
  const v = detectBackingVocals(lead, back, SR);
  assert(v.backVocals === true, `real back expected, got ${JSON.stringify(v)}`);
});

test('quiet overall but LOUD in the choruses → backing vocals (peak saves it)', () => {
  const lead = bursts(0.5);
  // Mostly -20 dB leakage, but one 1 s chorus window at -3 dB — a real back
  // that only sings in the chorus.
  const back = bursts(0.05, 20, 331);
  const from = Math.round(10 * SR);
  for (let i = from; i < from + SR; i++) back[i] = 0.35 * Math.sin((2 * Math.PI * 331 * i) / SR);
  const v = detectBackingVocals(lead, back, SR);
  assert(v.backVocals === true, `chorus peaks must keep the stem, got ${JSON.stringify(v)}`);
});

test('borderline -12 dB overall → kept ( errs toward keeping the stem)', () => {
  const lead = bursts(0.5);
  const back = burstsOther(0.125); // ≈ -12 dB overall, peaks ≈ -12 dB
  const v = detectBackingVocals(lead, back, SR);
  assert(v.backVocals === true, `-12 dB is above the -15 dB drop threshold`);
});
