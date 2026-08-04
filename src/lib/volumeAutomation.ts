/**
 * Volume automation helpers.
 *
 * The envelope is a sorted array of `{ timeMs, gain }` points. Between points,
 * gain is linearly interpolated. Before the first point and after the last, the
 * gain holds flat at that point's value. An empty array = no automation (flat
 * gain 1.0). These functions are pure (no DOM/audio), so they're shared by the
 * audio engine (live playback), the exporter (offline render) and the timeline
 * (drawing + hit-testing the envelope).
 */
import { VolumePoint } from '../types';

/** The default flat gain when no automation points are present. */
export const DEFAULT_GAIN = 1.0;

/**
 * Linear-interpolated gain at the given time. Before the first point → first
 * point's gain; after the last → last point's gain; between → linear ramp.
 * Empty array → DEFAULT_GAIN (1.0).
 */
export function gainAtTime(points: VolumePoint[], timeMs: number): number {
  if (points.length === 0) return DEFAULT_GAIN;
  if (timeMs <= points[0].timeMs) return points[0].gain;
  const last = points[points.length - 1];
  if (timeMs >= last.timeMs) return last.gain;
  // Find the bracketing segment via binary-ish scan (points are sorted).
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (timeMs >= a.timeMs && timeMs <= b.timeMs) {
      if (b.timeMs === a.timeMs) return b.gain; // duplicate time → take later
      const t = (timeMs - a.timeMs) / (b.timeMs - a.timeMs);
      return a.gain + (b.gain - a.gain) * t;
    }
  }
  return last.gain; // unreachable, but keeps the type checker happy
}

/**
 * Insert a point, keeping the array sorted by timeMs. Returns a NEW array
 * (immutable update for the store). If a point at the same time exists, it is
 * replaced.
 */
export function insertPoint(points: VolumePoint[], point: VolumePoint): VolumePoint[] {
  const next = points.filter((p) => p.timeMs !== point.timeMs);
  next.push(point);
  next.sort((a, b) => a.timeMs - b.timeMs);
  return next;
}

/** Remove the point at the given time. Returns a NEW array. */
export function removePoint(points: VolumePoint[], timeMs: number): VolumePoint[] {
  return points.filter((p) => p.timeMs !== timeMs);
}

/** Update a point's time + gain, re-sorting if the time changed. New array. */
export function movePoint(
  points: VolumePoint[],
  fromTime: number,
  to: { timeMs: number; gain: number },
): VolumePoint[] {
  const without = points.filter((p) => p.timeMs !== fromTime);
  without.push(to);
  without.sort((a, b) => a.timeMs - b.timeMs);
  return without;
}

/** Clamp a gain value into the supported range [0, 2]. */
export function clampGain(g: number): number {
  return Math.max(0, Math.min(2, g));
}
