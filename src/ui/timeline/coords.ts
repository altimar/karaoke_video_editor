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
/** px for the ACTIVE text-track row: three syllable lanes stacked (1st syllable
 * → lane 1, 2nd → lane 2, 3rd → lane 3, 4th → lane 1, …) so markers don't
 * overlap when zoomed out. Inactive text rows stay a single ROW_H lane. */
export const TEXT_ROW_H_ACTIVE = ROW_H * 3;
/** px per ACTIVE audio-track row (waveform + envelope editing). */
export const AUDIO_ROW_H = 56;
/** px per COLLAPSED (inactive) audio row: one thin line — mini waveform with
 * the automation strip on top, so pulled gains stay visible at a glance. */
export const AUDIO_ROW_COLLAPSED_H = 20;
/** px for the background pseudo-row (filmstrip / status line under all tracks). */
export const BG_ROW_H = 30;
/** px for the time ruler band at the top of the canvas. */
export const RULER_H = 26;
/** px gap below the ruler before the first row. Includes a TRACK_PAD-sized
 * slot ABOVE the first row so the FIRST header card can be the same
 * rowHeight + TRACK_PAD as the rest (its top sits flush at ruler + 4). */
export const TOP_PAD = 10;
/** px vertical gap between track rows. */
export const TRACK_PAD = 6;
/** horizontal hit-zone half-width around a text marker for dragging. */
export const HIT_W = 8;

/** Row height for a track: the ACTIVE audio track is tall (waveform editing),
 *  inactive ones collapse to one line; the ACTIVE text track shows three
 *  syllable lanes, inactive text rows are single marker lines. */
export function rowHeight(track: Track, activeTrackId: string): number {
  if (track.type !== 'audio') {
    return track.id === activeTrackId ? TEXT_ROW_H_ACTIVE : ROW_H;
  }
  return track.id === activeTrackId ? AUDIO_ROW_H : AUDIO_ROW_COLLAPSED_H;
}

/** Vertical offset where the track rows begin (right under the ruler). */
export function tracksTop(): number {
  return RULER_H + TOP_PAD;
}

/** Y of the top of the given track's row (summing preceding row heights). */
export function trackTopForIndex(ti: number, tracks: Track[], activeTrackId: string): number {
  let y = tracksTop();
  for (let i = 0; i < ti; i++) y += rowHeight(tracks[i], activeTrackId) + TRACK_PAD;
  return y;
}

/** Index of the track whose row contains canvas-y, or -1 if not over a row. */
export function trackIndexAtY(y: number, tracks: Track[], activeTrackId: string): number {
  for (let ti = 0; ti < tracks.length; ti++) {
    const top = trackTopForIndex(ti, tracks, activeTrackId);
    const h = rowHeight(tracks[ti], activeTrackId);
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
export function bgRowTop(tracks: Track[], activeTrackId: string): number {
  return trackTopForIndex(tracks.length, tracks, activeTrackId);
}

/** True if canvas-y is within the background row. */
export function isBgRowAtY(y: number, tracks: Track[], activeTrackId: string): boolean {
  const top = bgRowTop(tracks, activeTrackId);
  return y >= top && y <= top + BG_ROW_H;
}
