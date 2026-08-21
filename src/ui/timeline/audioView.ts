/**
 * TrackView strategy for AUDIO tracks. Two interactive tools (timeline header):
 *
 *  - automation: draws the waveform peaks + volume-automation envelope,
 *    hit-tests envelope points for dragging, handles background clicks (add a
 *    point) and double-taps (delete a point).
 *  - edit: the envelope is hidden; instead, sound chunks between relative
 *    silences are highlighted on the ACTIVE row, can be hovered and dragged
 *    onto another audio track (onDrop mixes them into that role). A press on
 *    the empty row stretches a rubber band that selects every chunk it
 *    intersects; dragging any selected chunk moves the whole selection.
 *
 * All track-type-specific logic for audio lives here. The orchestrator hands it
 * the row position + env (including pre-computed peaks). It never recomputes
 * layout itself — the row top is always provided by the caller.
 */
import { store } from '../../state/store';
import { audioEngine } from '../../lib/audioEngine';
import { computePeaks } from '../../lib/waveform';
import { insertPoint, removePoint, movePoint, clampGain } from '../../lib/volumeAutomation';
import { AudioChunk, detectChunks, chunkAtMs } from '../../lib/audioChunks';
import { isEditableRole, moveChunkRangesToRole } from '../../lib/audioEdit';
import { AudioTrack, Track } from '../../types';
import { AUDIO_ROW_H, AUDIO_ROW_COLLAPSED_H } from './coords';
import { ChunkSelection, Ctx, TimelineEnv, TrackDrag, TrackView } from './types';

/** Row height for THIS track right now: tall when active, one line otherwise. */
function rowH(track: AudioTrack, env: TimelineEnv): number {
  return track.id === env.activeTrackId ? AUDIO_ROW_H : AUDIO_ROW_COLLAPSED_H;
}

/** Committed rubber-band chunk selection (edit tool), as module state — the
 *  orchestrator only resets it (Esc, leaving the tool) via
 *  `clearChunkSelection`. Ranges are time-based, so nothing can dangle: after
 *  a finished move the source's re-detected chunks simply no longer match. */
let chunkSelection: ChunkSelection | null = null;

/** Drop the rubber-band selection (Esc, switching away from the edit tool). */
export function clearChunkSelection(): void {
  chunkSelection = null;
}

/** Does a [startMs, endMs] span intersect any of the selection's ranges? */
function selectionTouches(sel: ChunkSelection, startMs: number, endMs: number): boolean {
  return sel.ranges.some((r) => startMs <= r.endMs && r.startMs <= endMs);
}

export const audioView: TrackView<AudioTrack> = {
  rowHeight: AUDIO_ROW_H,

  draw(ctx: Ctx, track: AudioTrack, rowY: number, env: TimelineEnv): void {
    const h = rowH(track, env);
    const collapsed = h !== AUDIO_ROW_H;
    const midY = rowY + h / 2;
    // Waveform peaks (mirrored) for THIS role's audio, if loaded.
    const buf = audioEngine.getBuffer(track.role);
    if (buf) {
      // Peaks are computed for the FULL content width (so zoom still adds
      // detail and the per-bucket cache stays stable), but we only draw the
      // visible window — O(viewport) fillRects per frame instead of O(content).
      const peaks = computePeaks(buf, Math.max(1, Math.ceil(env.width))).peaks;
      ctx.fillStyle = '#3a5a8c';
      const w = env.width;
      const x0 = Math.max(0, Math.floor(env.scrollLeft));
      const x1 = Math.min(w, Math.ceil(env.scrollLeft + env.viewportWidth));
      const dim = collapsed ? 0.55 : 1; // inactive rows recede visually
      for (let x = x0; x < x1; x++) {
        const idx = Math.floor((x / w) * peaks.length);
        const p = peaks[idx] ?? 0;
        const half = Math.max(1, p * (h / 2 - 1));
        ctx.globalAlpha = dim;
        ctx.fillRect(x, midY - half, 1, half * 2);
        ctx.globalAlpha = 1;
      }
    } else if (!track.audioFileName) {
      // Empty slot hint.
      ctx.fillStyle = '#5a5f7e';
      ctx.font = '11px system-ui';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText('загрузите аудио', env.width / 2, midY);
      ctx.textAlign = 'left';
    } else {
      // Filename in the model but no decoded buffer — e.g. a restored
      // autosave whose media didn't survive: point at the re-load path.
      ctx.fillStyle = '#5a5f7e';
      ctx.font = '11px system-ui';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText('аудио не загружено — клик по шапке дорожки', env.width / 2, midY);
      ctx.textAlign = 'left';
    }
    // Separator line under the row (only the visible slice). Drawn in the LAST
    // pixel INSIDE the row (h-1): the gutter's header card is a bordered box of
    // exactly this row's height, and its bottom border occupies that same last
    // pixel — so the two lines meet flush across the gutter/canvas junction.
    ctx.fillStyle = '#2a2e42';
    const sepX = Math.max(0, Math.floor(env.scrollLeft));
    const sepW = Math.min(env.width, Math.ceil(env.scrollLeft + env.viewportWidth)) - sepX;
    ctx.fillRect(sepX, rowY + h - 1, Math.max(0, sepW), 1);

    // Volume automation envelope (automation tool) — visible in the collapsed
    // row too (that's the point of keeping it), just thinner with smaller
    // handles. In the edit tool the strips are hidden and chunk regions show
    // on the active row instead.
    if (env.tool === 'edit') {
      drawEditOverlay(ctx, track, rowY, env, h);
    } else {
      drawEnvelope(ctx, track, rowY, env, h);
    }
  },

  hitTest(track: AudioTrack, rowY: number, x: number, y: number, env: TimelineEnv): TrackDrag | null {
    // Inactive rows are read-only — no point dragging.
    if (track.id !== env.activeTrackId) return null;
    const ti = indexOfTrack(track);
    if (ti < 0) return null;
    // Edit tool: grab a detected sound chunk of the active editable row, or
    // start a rubber band on its empty space. A chunk's hit zone is its own
    // rectangle (the row's vertical span at the chunk's time range); empty
    // space stretches a selection frame — a no-move release stays a click
    // (clear + seek), so seeking behavior is unchanged.
    if (env.tool === 'edit') {
      if (y < rowY || y > rowY + AUDIO_ROW_H) return null;
      if (!isEditableRole(track.role)) return null;
      const buf = audioEngine.getBuffer(track.role);
      if (!buf) return null;
      const chunks = detectChunks(buf);
      const ci = chunkAtMs(chunks, env.xToMs(x));
      if (ci >= 0) {
        const c = chunks[ci];
        // Grabbing a chunk of the committed selection drags the WHOLE
        // selection: every range moves on drop (startMs/endMs = the union).
        const sel = chunkSelection?.trackId === track.id ? chunkSelection : null;
        if (sel && selectionTouches(sel, c.startMs, c.endMs)) {
          return {
            kind: 'chunk',
            trackIndex: ti,
            chunkIndex: ci,
            startMs: sel.ranges[0].startMs,
            endMs: sel.ranges[sel.ranges.length - 1].endMs,
            ranges: sel.ranges,
            moved: false,
          };
        }
        return { kind: 'chunk', trackIndex: ti, chunkIndex: ci, startMs: c.startMs, endMs: c.endMs, moved: false };
      }
      return { kind: 'marquee', trackIndex: ti, x0: x, y0: y, x1: x, y1: y, moved: false };
    }
    const midY = rowY + AUDIO_ROW_H / 2;
    for (const p of track.volumeAutomation) {
      const px = env.msToX(p.timeMs);
      const py = midY - (p.gain - 1) * (AUDIO_ROW_H / 2);
      if (Math.abs(x - px) <= 6 && Math.abs(y - py) <= 6) {
        return { kind: 'volume', trackIndex: ti, timeMs: p.timeMs, moved: false };
      }
    }
    return null;
  },

  onBackgroundClick(_track: AudioTrack, rowY: number, x: number, y: number, env: TimelineEnv): boolean | void {
    // Adding points happens on the active row only.
    if (_track.id !== env.activeTrackId) return;
    // In the edit tool the row is not an envelope editor — decline so the
    // orchestrator falls through to a seek.
    if (env.tool === 'edit') return false;
    const ti = indexOfTrack(_track);
    if (ti < 0) return;
    const midY = rowY + AUDIO_ROW_H / 2;
    const ms = Math.max(0, Math.min(env.durationMs(), env.xToMs(x)));
    const gain = clampGain(1 + (midY - y) / (AUDIO_ROW_H / 2));
    store.mutate((p) => {
      const at = p.tracks[ti];
      if (at && at.type === 'audio') {
        at.volumeAutomation = insertPoint(at.volumeAutomation, {
          timeMs: Math.round(ms),
          gain: Math.round(gain * 100) / 100,
        });
      }
    });
  },

  onDrag(drag, rowY, x, y, env: TimelineEnv): void {
    // A rubber band just stretches (the selection commits on release); a chunk
    // drag has no live model mutation either — the move happens on drop.
    if (drag.kind === 'marquee') {
      drag.x1 = x;
      drag.y1 = y;
      drag.moved = drag.moved || Math.max(Math.abs(x - drag.x0), Math.abs(y - drag.y0)) > 3;
      return;
    }
    if (drag.kind === 'chunk') {
      drag.moved = true;
      return;
    }
    if (drag.kind !== 'volume') return;
    const ti = drag.trackIndex;
    const midY = rowY + AUDIO_ROW_H / 2;
    const ms = Math.max(0, Math.min(env.durationMs(), env.xToMs(x)));
    const gain = clampGain(1 + (midY - y) / (AUDIO_ROW_H / 2));
    drag.moved = true;
    const fromTime = drag.timeMs;
    store.mutate((p) => {
      const at = p.tracks[ti];
      if (at && at.type === 'audio') {
        at.volumeAutomation = movePoint(at.volumeAutomation, fromTime, {
          timeMs: Math.round(ms),
          gain: Math.round(gain * 100) / 100,
        });
      }
    });
    drag.timeMs = Math.round(ms);
  },

  onDoubleTap(drag): void {
    if (drag.kind !== 'volume') return;
    const ti = drag.trackIndex;
    const fromTime = drag.timeMs;
    store.mutate((p) => {
      const at = p.tracks[ti];
      if (at && at.type === 'audio') at.volumeAutomation = removePoint(at.volumeAutomation, fromTime);
    });
  },

  onDrop(drag, targetTrack, env): void {
    // Rubber-band release: commit the chunks the frame intersected. A no-move
    // press is a plain click — clear the selection and seek (the row's
    // historical empty-space behavior).
    if (drag.kind === 'marquee') {
      if (!drag.moved) {
        chunkSelection = null;
        const px = env.pointer?.x;
        if (px !== undefined) audioEngine.seek(env.xToMs(px));
        return;
      }
      const src = store.getProject().tracks[drag.trackIndex];
      if (!src || src.type !== 'audio' || !isEditableRole(src.role)) return;
      const buf = audioEngine.getBuffer(src.role);
      if (!buf) return;
      const lo = Math.max(0, Math.min(env.xToMs(drag.x0), env.xToMs(drag.x1)));
      const hi = Math.max(env.xToMs(drag.x0), env.xToMs(drag.x1));
      const ranges = detectChunks(buf)
        .filter((c) => c.startMs <= hi && lo <= c.endMs)
        .map((c) => ({ startMs: c.startMs, endMs: c.endMs }));
      chunkSelection = ranges.length > 0 ? { trackId: src.id, ranges } : null;
      return;
    }
    if (drag.kind !== 'chunk') return;
    const src = store.getProject().tracks[drag.trackIndex];
    if (!src || src.type !== 'audio') return;
    if (!targetTrack || targetTrack.type !== 'audio') return;
    if (targetTrack.role === src.role) return;
    // The source buffer is about to be replaced — its committed selection
    // (whose chunks are moving away) is stale by definition.
    chunkSelection = null;
    const ranges = drag.ranges ?? [{ startMs: drag.startMs, endMs: drag.endMs }];
    // Fire-and-forget: the reload redraws both rows when the new audio lands.
    void moveChunkRangesToRole(src.role, targetTrack.role, ranges);
  },
};

/** Find the index of a track in the current project by id (for store mutations). */
function indexOfTrack(track: { id: string }): number {
  return store.getProject().tracks.findIndex((t) => t.id === track.id);
}

/** Draw the volume-automation envelope (line + points) on top of the waveform.
 *  Height-aware: collapsed rows get a thin line and small handles. */
function drawEnvelope(ctx: Ctx, track: AudioTrack, rowY: number, env: TimelineEnv, h: number): void {
  const midY = rowY + h / 2;
  const pts = track.volumeAutomation;
  const collapsed = h !== AUDIO_ROW_H;
  const gainToY = (g: number): number => midY - (g - 1) * (h / 2);
  ctx.strokeStyle = pts.length > 0 ? '#ffe14d' : 'rgba(255,225,77,0.3)';
  ctx.lineWidth = collapsed ? 1 : 1.5;
  ctx.beginPath();
  if (pts.length === 0) {
    const y = gainToY(1);
    ctx.moveTo(0, y);
    ctx.lineTo(env.width, y);
  } else {
    const firstX = env.msToX(pts[0].timeMs);
    ctx.moveTo(0, gainToY(pts[0].gain));
    ctx.lineTo(firstX, gainToY(pts[0].gain));
    for (const p of pts) ctx.lineTo(env.msToX(p.timeMs), gainToY(p.gain));
    const last = pts[pts.length - 1];
    ctx.lineTo(env.width, gainToY(last.gain));
  }
  ctx.stroke();
  // Point handles.
  if (pts.length > 0) {
    ctx.fillStyle = '#ffe14d';
    ctx.strokeStyle = '#0e0f1a';
    ctx.lineWidth = 1.5;
    for (const p of pts) {
      const x = env.msToX(p.timeMs);
      const y = gainToY(p.gain);
      ctx.beginPath();
      ctx.arc(x, y, collapsed ? 2 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

/**
 * Edit-tool overlay: movable chunk regions on the ACTIVE audio row, the live
 * rubber-band frame + its preview of the chunks being selected, the committed
 * selection highlight, and the drop indicator bands on the row under the
 * pointer while a chunk drag is active.
 */
function drawEditOverlay(ctx: Ctx, track: AudioTrack, rowY: number, env: TimelineEnv, h: number): void {
  const chunkDrag = env.drag?.kind === 'chunk' ? env.drag : null;
  const marquee = env.drag?.kind === 'marquee' ? env.drag : null;
  const dragTrack = (chunkDrag ?? marquee)
    ? (store.getProject().tracks[(chunkDrag ?? marquee)!.trackIndex] as Track | undefined)
    : undefined;

  // Chunk regions — only on the active editable row with loaded audio.
  if (track.id === env.activeTrackId && isEditableRole(track.role)) {
    const buf = audioEngine.getBuffer(track.role);
    if (buf) {
      const chunks: AudioChunk[] = detectChunks(buf);
      const sel = chunkSelection?.trackId === track.id ? chunkSelection : null;
      // Hover the chunk under the pointer (only when not dragging).
      let hoverIdx = -1;
      const p = env.pointer;
      if (!chunkDrag && !marquee && p && p.y >= rowY && p.y <= rowY + h) {
        hoverIdx = chunkAtMs(chunks, env.xToMs(p.x));
      }
      // Live rubber-band preview: the time span the frame covers so far.
      let lo = Infinity;
      let hi = -Infinity;
      if (marquee && dragTrack?.id === track.id) {
        lo = Math.max(0, Math.min(env.xToMs(marquee.x0), env.xToMs(marquee.x1)));
        hi = Math.max(env.xToMs(marquee.x0), env.xToMs(marquee.x1));
      }
      const dragIdx = chunkDrag && dragTrack?.id === track.id ? chunkDrag.chunkIndex : -1;
      for (let i = 0; i < chunks.length; i++) {
        const x0 = env.msToX(chunks[i].startMs);
        const x1 = env.msToX(chunks[i].endMs);
        if (x1 < env.scrollLeft - 4 || x0 > env.scrollLeft + env.viewportWidth + 4) continue; // cull
        const dragging =
          dragIdx === i ||
          (chunkDrag?.ranges?.some((r) => chunks[i].startMs <= r.endMs && r.startMs <= chunks[i].endMs) ??
            false);
        const selected =
          (sel !== null && selectionTouches(sel, chunks[i].startMs, chunks[i].endMs)) ||
          (chunks[i].startMs <= hi && lo <= chunks[i].endMs);
        if (dragging) {
          ctx.fillStyle = 'rgba(110,168,254,0.32)';
          ctx.fillRect(x0, rowY, x1 - x0, h - 1);
          ctx.strokeStyle = '#6ea8fe';
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, rowY + 0.5, Math.max(1, x1 - x0 - 1), h - 2);
        } else if (selected) {
          ctx.fillStyle = 'rgba(110,168,254,0.24)';
          ctx.fillRect(x0, rowY, x1 - x0, h - 1);
          ctx.strokeStyle = 'rgba(110,168,254,0.7)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, rowY + 0.5, Math.max(1, x1 - x0 - 1), h - 2);
        } else if (i === hoverIdx) {
          ctx.fillStyle = 'rgba(110,168,254,0.20)';
          ctx.fillRect(x0, rowY, x1 - x0, h - 1);
        } else {
          ctx.fillStyle = 'rgba(110,168,254,0.08)';
          ctx.fillRect(x0, rowY, x1 - x0, h - 1);
        }
      }
    }
  }

  // The rubber-band frame itself (dashed); the stretch follows the pointer
  // wherever it goes, the press anchor stays where it landed.
  if (marquee && dragTrack?.id === track.id) {
    const rx = Math.min(marquee.x0, marquee.x1);
    const ry = Math.min(marquee.y0, marquee.y1);
    const rw = Math.abs(marquee.x1 - marquee.x0);
    const rh = Math.abs(marquee.y1 - marquee.y0);
    ctx.fillStyle = 'rgba(110,168,254,0.08)';
    ctx.fillRect(rx, ry, rw, Math.max(1, rh));
    ctx.strokeStyle = '#6ea8fe';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, rw - 1), Math.max(1, rh - 1));
    ctx.setLineDash([]);
  }

  // Drop indicator: where the held chunk(s) would land. Valid target = another
  // editable role (accent); the 'original' row shows a denied band; the source
  // row itself shows nothing (dropping there is a no-op, not an error). A
  // multi-selection draws one band per range.
  if (
    chunkDrag &&
    env.dropTargetTrackId === track.id &&
    dragTrack &&
    dragTrack.type === 'audio' &&
    dragTrack.role !== track.role
  ) {
    const valid = isEditableRole(track.role);
    const ranges = chunkDrag.ranges ?? [{ startMs: chunkDrag.startMs, endMs: chunkDrag.endMs }];
    for (const r of ranges) {
      const x0 = env.msToX(r.startMs);
      const x1 = env.msToX(r.endMs);
      ctx.fillStyle = valid ? 'rgba(255,225,77,0.22)' : 'rgba(255,92,108,0.18)';
      ctx.fillRect(x0, rowY, x1 - x0, h - 1);
      ctx.strokeStyle = valid ? '#ffe14d' : '#ff5c6c';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, rowY + 0.5, Math.max(1, x1 - x0 - 1), h - 2);
    }
  }
}
