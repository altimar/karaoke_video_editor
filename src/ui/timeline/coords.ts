/**
 * Timeline layout constants + pure geometry helpers.
 *
 * Shared by the timeline orchestrator and every track-view module so all of
 * them agree on row heights, the ruler band and vertical positions. Pure
 * (no DOM, no state) — safe to import from any track view.
 */
import { Track } from '../../types';

/** px per text-track row (marker line height). */
export const ROW_H = 18;
/** px per audio-track row (waveform + envelope). */
export const AUDIO_ROW_H = 56;
/** px for the background pseudo-row (filmstrip / status line under all tracks). */
export const BG_ROW_H = 30;
/** px for the time ruler band at the top of the canvas. */
export const RULER_H = 26;
/** px gap below the ruler before the first row. */
export const TOP_PAD = 4;
/** px vertical gap between track rows. */
export const TRACK_PAD = 6;
/** horizontal hit-zone half-width around a text marker for dragging. */
export const HIT_W = 8;

/** Row height for a track (audio rows are taller than text rows). */
export function rowHeight(track: Track): number {
  return track.type === 'audio' ? AUDIO_ROW_H : ROW_H;
}

/** Vertical offset where the track rows begin (right under the ruler). */
export function tracksTop(): number {
  return RULER_H + TOP_PAD;
}

/** Y of the top of the given track's row (summing preceding row heights). */
export function trackTopForIndex(ti: number, tracks: Track[]): number {
  let y = tracksTop();
  for (let i = 0; i < ti; i++) y += rowHeight(tracks[i]) + TRACK_PAD;
  return y;
}

/** Index of the track whose row contains canvas-y, or -1 if not over a row. */
export function trackIndexAtY(y: number, tracks: Track[]): number {
  for (let ti = 0; ti < tracks.length; ti++) {
    const top = trackTopForIndex(ti, tracks);
    const h = rowHeight(tracks[ti]);
    if (y >= top && y <= top + h) return ti;
  }
  return -1;
}

/**
 * Y of the background pseudo-row — a single status/hint line AFTER all track
 * rows (it belongs to `project.background`, not to any Track). Its top is
 * simply "below the last track", which trackTopForIndex already computes for
 * index == tracks.length.
 */
export function bgRowTop(tracks: Track[]): number {
  return trackTopForIndex(tracks.length, tracks);
}

/** True if canvas-y is within the background row. */
export function isBgRowAtY(y: number, tracks: Track[]): boolean {
  const top = bgRowTop(tracks);
  return y >= top && y <= top + BG_ROW_H;
}
