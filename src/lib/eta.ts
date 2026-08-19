/**
 * Progress ETA estimation — "осталось ~1:23" for the long-running bars
 * (model downloads, separation, export).
 *
 * The estimate is recomputed from a SLIDING WINDOW of recent (time, fraction)
 * samples, so it adapts when the speed changes (network hiccups, a heavier
 * chunk, a faster phase) instead of averaging over the whole run. A new phase
 * (fraction resets towards 0) resets the window.
 *
 * Pure time-math; the clock is injectable for tests.
 */

export interface EtaEstimator {
  /** Feed the current progress (0..1); returns a human remaining-time hint or null. */
  update(fraction: number): string | null;
  /** Drop the history (a new phase begins). */
  reset(): void;
}

/** Samples older than this leave the window (the estimate follows speed changes). */
const WINDOW_MS = 10_000;
/** The two oldest/newest samples must span at least this to trust a speed. */
const MIN_SPAN_MS = 1200;
/** Never show estimates beyond this — pure noise at that point. */
const MAX_REMAINING_MS = 3 * 60 * 60 * 1000;

export function createEta(now: () => number = () => performance.now()): EtaEstimator {
  let samples: Array<{ t: number; f: number }> = [];

  return {
    reset(): void {
      samples = [];
    },
    update(fraction: number): string | null {
      const t = now();
      const last = samples[samples.length - 1];
      // A significant backwards jump = a new phase (second model download,
      // phase 2 of separation): start the window over.
      if (last && fraction < last.f - 0.02) samples = [];
      samples.push({ t, f: Math.max(0, Math.min(1, fraction)) });
      const cutoff = t - WINDOW_MS;
      samples = samples.filter((s) => s.t >= cutoff);
      if (samples.length < 2) return null;

      const a = samples[0];
      const b = samples[samples.length - 1];
      const span = b.t - a.t;
      const df = b.f - a.f;
      if (span < MIN_SPAN_MS || df <= 0) return null;

      const rate = df / span; // fraction per ms
      const remaining = (1 - b.f) / rate;
      if (!isFinite(remaining) || remaining > MAX_REMAINING_MS) return null;
      return formatRemaining(remaining);
    },
  };
}

/** "~1:23" / "~12:05" (minutes:seconds, capped display). */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `~${m}:${r.toString().padStart(2, '0')}`;
}
