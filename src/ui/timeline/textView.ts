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
import { Line, TextTrack } from '../../types';
import { ROW_H, HIT_W } from './coords';
import { Ctx, TimelineEnv, TrackDrag, TrackView } from './types';

export const textView: TrackView<TextTrack> = {
  rowHeight: ROW_H,

  draw(ctx: Ctx, track: TextTrack, rowY: number, env: TimelineEnv): void {
    const flat = flatSyllables(track.lines);
    // Visible content window (with a little slack); skip syllables entirely
    // off-screen so we don't build gradients/labels for them every frame.
    const left = env.scrollLeft - 40;
    const right = env.scrollLeft + env.viewportWidth + 40;
    for (let i = 0; i < flat.length; i++) {
      const { lineIndex, sylIndex, syl } = flat[i];
      if (syl.startMs === null) continue;
      const mx = env.msToX(syl.startMs);
      if (mx < left || mx > right) continue;

      // syllable text label
      ctx.fillStyle = '#7a7f9e';
      ctx.font = '11px system-ui';
      ctx.textBaseline = 'middle';
      const label = syl.text.trim();
      if (label) ctx.fillText(label.slice(0, 10), mx + 5, rowY + ROW_H / 2);

      // fill bar to the right up to next syllable start (shows duration visually)
      const next = nextStartMs(track.lines, lineIndex, sylIndex);
      const endX = next !== null ? env.msToX(next) : env.msToX(env.durationMs());
      const grad = ctx.createLinearGradient(mx, 0, endX, 0);
      grad.addColorStop(0, 'rgba(255,225,77,0.55)');
      grad.addColorStop(1, 'rgba(255,225,77,0.10)');
      ctx.fillStyle = grad;
      ctx.fillRect(mx, rowY + ROW_H / 2 - 2, Math.max(2, endX - mx), 4);

      // marker handle — thin 1px line
      ctx.fillStyle = '#ffe14d';
      ctx.fillRect(mx, rowY, 1, ROW_H);
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
  if (y < rowY || y > rowY + ROW_H) return null;
  const flat = flatSyllables(track.lines);
  for (let i = 0; i < flat.length; i++) {
    const { lineIndex, sylIndex, syl } = flat[i];
    if (syl.startMs === null) continue;
    const mx = env.msToX(syl.startMs);
    if (x >= mx - HIT_W && x <= mx + HIT_W) {
      return { kind: 'syllable', trackIndex, lineIndex, sylIndex, moved: false };
    }
  }
  return null;
}

function nextStartMs(lines: Line[], lineIndex: number, sylIndex: number): number | null {
  const flat = flatSyllables(lines);
  const i = flat.findIndex((f) => f.lineIndex === lineIndex && f.sylIndex === sylIndex);
  for (let j = i + 1; j < flat.length; j++) {
    if (flat[j].syl.startMs !== null) return flat[j].syl.startMs;
  }
  return null;
}
