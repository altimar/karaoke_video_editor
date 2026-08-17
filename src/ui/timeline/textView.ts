/**
 * TrackView strategy for TEXT tracks: draws syllable markers/labels/duration
 * bars, hit-tests a marker for dragging, and applies the drag to the store
 * (clamped between the previous and next timed syllable in the same track).
 *
 * All track-type-specific logic for text lives here; the orchestrator only
 * hands it the row position + env.
 */
import { store } from '../../state/store';
import { flatSyllables } from '../../lib/textParser';
import { TextTrack } from '../../types';
import { ROW_H, TEXT_ROW_H_ACTIVE, HIT_W } from './coords';
import { Ctx, TimelineEnv, TrackDrag, TrackView } from './types';

/**
 * Lane of the n-th TIMED syllable: 1st → lane 0, 2nd → lane 1, 3rd → lane 2,
 * 4th → lane 0, … (round-robin across the three lanes of the active text row).
 * Inactive rows have a single lane (always 0).
 */
function laneOf(timedIndex: number, threeLanes: boolean): number {
  return threeLanes ? timedIndex % 3 : 0;
}

export const textView: TrackView<TextTrack> = {
  rowHeight: ROW_H,

  draw(ctx: Ctx, track: TextTrack, rowY: number, env: TimelineEnv): void {
    const threeLanes = env.activeTrackId === track.id;
    const h = threeLanes ? TEXT_ROW_H_ACTIVE : ROW_H;
    const flat = flatSyllables(track.lines);
    // Visible content window (with a little slack); skip syllables entirely
    // off-screen so we don't build gradients/labels for them every frame.
    const left = env.scrollLeft - 40;
    const right = env.scrollLeft + env.viewportWidth + 40;
    let timedIndex = 0;
    for (let i = 0; i < flat.length; i++) {
      const { syl } = flat[i];
      if (syl.startMs === null) continue;
      const lane = laneOf(timedIndex, threeLanes);
      timedIndex++;
      const laneY = rowY + lane * ROW_H;
      const mx = env.msToX(syl.startMs);
      if (mx < left || mx > right) continue;

      // syllable text label
      ctx.fillStyle = '#7a7f9e';
      ctx.font = '11px system-ui';
      ctx.textBaseline = 'middle';
      const label = syl.text.trim();
      if (label) ctx.fillText(label.slice(0, 10), mx + 5, laneY + ROW_H / 2);

      // marker handle — thin 1px line spanning its lane
      ctx.fillStyle = '#ffe14d';
      ctx.fillRect(mx, laneY, 1, ROW_H);
    }

    // Separator in the row's LAST pixel — same convention as audioView: the
    // gutter's header card bottom border sits on that exact pixel. SKIPPED
    // for a bound text track: it renders directly above its vocal, and the
    // pair reads as one unit — no line at the junction (the cards share one
    // frame there too, see .pair-top/.pair-bottom).
    if (track.boundVocalRole === null) {
      ctx.fillStyle = '#2a2e42';
      const sepX = Math.max(0, Math.floor(env.scrollLeft));
      const sepW = Math.min(env.width, Math.ceil(env.scrollLeft + env.viewportWidth)) - sepX;
      ctx.fillRect(sepX, rowY + h - 1, Math.max(0, sepW), 1);
    }
  },

  hitTest(_track: TextTrack, _rowY: number, _x: number, _y: number, _env: TimelineEnv): TrackDrag | null {
    // Text marker hit-testing uses live syllables, so the orchestrator calls
    // `pickMarker` (below) per row instead of this generic stub. Kept to satisfy
    // the TrackView interface; returns nothing.
    return null;
  },

  onDrag(drag, _rowY, x, _y, env: TimelineEnv): void {
    if (drag.kind !== 'syllable') return;
    const ti = drag.trackIndex;
    // Re-read the track from the store (it may have changed during the drag).
    const project = store.getProject();
    const track = project.tracks[ti];
    if (!track || track.type !== 'text') return;
    const flat = flatSyllables(track.lines);
    const myFlatIdx = flat.findIndex(
      (f) => f.lineIndex === drag.lineIndex && f.sylIndex === drag.sylIndex,
    );
    if (myFlatIdx < 0) return;
    let ms = env.xToMs(x);
    // Clamp: can't drag past the previous or next timed syllable WITHIN THE SAME TRACK.
    let minMs = 0;
    let maxMs = env.durationMs();
    for (let i = myFlatIdx - 1; i >= 0; i--) {
      if (flat[i].syl.startMs !== null) {
        minMs = flat[i].syl.startMs as number;
        break;
      }
    }
    for (let i = myFlatIdx + 1; i < flat.length; i++) {
      if (flat[i].syl.startMs !== null) {
        maxMs = flat[i].syl.startMs as number;
        break;
      }
    }
    ms = Math.max(minMs, Math.min(maxMs, ms));
    drag.moved = true;
    const li = drag.lineIndex;
    const si = drag.sylIndex;
    store.mutate((p) => {
      const t = p.tracks[ti];
      if (t && t.type === 'text') {
        const syl = t.lines[li]?.syllables[si];
        if (syl) syl.startMs = Math.round(ms);
      }
    });
  },
};

/**
 * Hit-test a specific text track's syllable markers at canvas (x, y).
 * Kept as a standalone function (not part of the generic interface) because it
 * needs the track's current syllables — the orchestrator calls it per text row.
 */
export function pickMarker(
  trackIndex: number,
  track: TextTrack,
  rowY: number,
  x: number,
  y: number,
  env: TimelineEnv,
): TrackDrag | null {
  const threeLanes = env.activeTrackId === track.id;
  const h = threeLanes ? TEXT_ROW_H_ACTIVE : ROW_H;
  if (y < rowY || y > rowY + h) return null;
  const flat = flatSyllables(track.lines);
  let timedIndex = 0;
  for (let i = 0; i < flat.length; i++) {
    const { lineIndex, sylIndex, syl } = flat[i];
    if (syl.startMs === null) continue;
    const lane = laneOf(timedIndex, threeLanes);
    timedIndex++;
    // A marker is grabbable only within ITS lane: with three lanes several
    // markers share the same x, the click must pick the one under the cursor.
    const laneY = rowY + lane * ROW_H;
    if (y < laneY || y > laneY + ROW_H) continue;
    const mx = env.msToX(syl.startMs);
    if (x >= mx - HIT_W && x <= mx + HIT_W) {
      return { kind: 'syllable', trackIndex, lineIndex, sylIndex, moved: false };
    }
  }
  return null;
}
