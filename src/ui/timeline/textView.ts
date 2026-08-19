/**
 * TrackView strategy for TEXT tracks: draws syllable markers/labels/duration
 * bars, hit-tests a marker for dragging, and applies the drag to the store
 * (clamped between the previous and next timed syllable in the same track).
 *
 * All track-type-specific logic for text lives here; the orchestrator only
 * hands it the row position + env.
 */
import { store } from '../../state/store';
import { flatSyllables, clampBetweenNeighbors, rangeShiftBounds, timingProblems } from '../../lib/textParser';
import { TextTrack } from '../../types';
import { ROW_H, TEXT_ROW_H_ACTIVE } from './coords';
import { Ctx, TimelineEnv, TrackDrag, TrackView, selectionBounds } from './types';

/** Gap between the marker line and its label (px). */
const LABEL_DX = 5;
/** Hit/selection padding around the label text (px). */
const LABEL_PAD = 4;

/** Shared measuring context for label widths (hit zones follow the text). */
const measureCtx =
  typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;

/** The clickable zone of a marker at `mx` with label `label`: from the line
 *  through the end of the label text + padding. A label-less syllable gets a
 *  minimal strip around the line itself. */
function markerZone(mx: number, label: string): { x0: number; x1: number } {
  let w = 0;
  if (label) {
    if (measureCtx) {
      measureCtx.font = '11px system-ui';
      w = measureCtx.measureText(label).width;
    } else {
      w = label.length * 6;
    }
  }
  return { x0: mx - 1, x1: w > 0 ? mx + LABEL_DX + w + LABEL_PAD : mx + 5 };
}

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
    // Validator: syllables that break monotonic timing / exceed the duration.
    const problems = timingProblems(track.lines, env.durationMs());
    const selBounds =
      env.selection !== null && env.selection.trackId === track.id ? selectionBounds(env.selection) : null;
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

      const inSel = selBounds !== null && i >= selBounds[0] && i <= selBounds[1];
      const bad = problems.has(i);
      const label = syl.text.trim().slice(0, 10);

      // Selection highlight: the label's own zone (line → text end + padding),
      // so what lights up is exactly what the keys operate on.
      if (inSel) {
        const zone = markerZone(mx, label);
        ctx.fillStyle = 'rgba(255,225,77,0.16)';
        ctx.fillRect(zone.x0, laneY, zone.x1 - zone.x0, ROW_H);
      }

      // syllable text label
      ctx.fillStyle = bad ? '#ff5c6c' : inSel ? '#ffe14d' : '#7a7f9e';
      ctx.font = (inSel ? 'bold ' : '') + '11px system-ui';
      ctx.textBaseline = 'middle';
      if (label) ctx.fillText(label, mx + LABEL_DX, laneY + ROW_H / 2);

      // marker handle — thin 1px line spanning its lane
      ctx.fillStyle = bad ? '#ff5c6c' : '#ffe14d';
      ctx.fillRect(mx, laneY, inSel ? 2 : 1, ROW_H);
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
    // The marker moves WITH the pointer: where the user grabbed inside the
    // label stays under the finger, the line doesn't snap to the cursor.
    const targetMs = env.xToMs(x) - drag.grabMs;

    // Block move: the grabbed marker belongs to an active multi-selection —
    // the whole range shifts together (delta-based, originals snapshotted on
    // the first move; bounds computed against the pre-drag layout).
    const sb = env.selection && env.selection.trackId === track.id ? selectionBounds(env.selection) : null;
    if (sb && sb[0] !== sb[1] && myFlatIdx >= sb[0] && myFlatIdx <= sb[1]) {
      const [rb0, rb1] = sb;
      if (!drag.origStarts || !drag.rangeBounds) {
        drag.origStarts = flat.slice(rb0, rb1 + 1).map((f) => f.syl.startMs);
        drag.rangeBounds = rangeShiftBounds(flat, rb0, rb1, env.durationMs());
      }
      const base = drag.origStarts[myFlatIdx - rb0];
      if (base === null) return;
      const { lo, hi } = drag.rangeBounds;
      const delta = Math.round(Math.max(lo, Math.min(hi, targetMs - base)));
      const origStarts = drag.origStarts;
      drag.moved = true;
      store.mutate((p) => {
        const t = p.tracks[ti];
        if (!t || t.type !== 'text') return;
        const f = flatSyllables(t.lines);
        for (let i = rb0; i <= rb1; i++) {
          const orig = origStarts[i - rb0];
          if (orig !== null && f[i]) f[i].syl.startMs = Math.round(orig + delta);
        }
      });
      return;
    }

    // Single marker: absolute move, clamped between the previous/next TIMED
    // syllable of the same track.
    const ms = clampBetweenNeighbors(flat, myFlatIdx, targetMs, env.durationMs());
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
    // The hit zone is the LABEL (line → text end + padding), not a fixed
    // ±px around the line — users aim at the letters.
    const zone = markerZone(mx, syl.text.trim().slice(0, 10));
    if (x >= zone.x0 && x <= zone.x1) {
      return {
        kind: 'syllable',
        trackIndex,
        lineIndex,
        sylIndex,
        // Keep the grab point inside the marker so the line doesn't jump to
        // the cursor when the label (not the line) was grabbed.
        grabMs: env.xToMs(x) - syl.startMs,
        moved: false,
      };
    }
  }
  return null;
}
