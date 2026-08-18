/**
 * TrackView strategy for AUDIO tracks. Two interactive tools (timeline header):
 *
 *  - automation: draws the waveform peaks + volume-automation envelope,
 *    hit-tests envelope points for dragging, handles background clicks (add a
 *    point) and double-taps (delete a point).
 *  - edit: the envelope is hidden; instead, sound chunks between relative
 *    silences are highlighted on the ACTIVE row, can be hovered and dragged
 *    onto another audio track (onDrop mixes them into that role).
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
import { isEditableRole, moveChunkToRole } from '../../lib/audioEdit';
import { AudioTrack, Track } from '../../types';
import { AUDIO_ROW_H, AUDIO_ROW_COLLAPSED_H } from './coords';
import { Ctx, TimelineEnv, TrackDrag, TrackView } from './types';

/** Row height for THIS track right now: tall when active, one line otherwise. */
function rowH(track: AudioTrack, env: TimelineEnv): number {
  return track.id === env.activeTrackId ? AUDIO_ROW_H : AUDIO_ROW_COLLAPSED_H;
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
    // Edit tool: grab a detected sound chunk of the active editable row. The
    // hit zone is the chunk's own rectangle (the row's vertical span at the
    // chunk's time range) — clicks elsewhere on the canvas stay free for seek.
    if (env.tool === 'edit') {
      if (y < rowY || y > rowY + AUDIO_ROW_H) return null;
      if (!isEditableRole(track.role)) return null;
      const buf = audioEngine.getBuffer(track.role);
      if (!buf) return null;
      const chunks = detectChunks(buf);
      const ci = chunkAtMs(chunks, env.xToMs(x));
      if (ci < 0) return null;
      const c = chunks[ci];
      return { kind: 'chunk', trackIndex: ti, chunkIndex: ci, startMs: c.startMs, endMs: c.endMs, moved: false };
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
    // A chunk drag has no live model mutation — the move happens on drop.
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

  onDrop(drag, targetTrack): void {
    if (drag.kind !== 'chunk') return;
    const src = store.getProject().tracks[drag.trackIndex];
    if (!src || src.type !== 'audio') return;
    if (!targetTrack || targetTrack.type !== 'audio') return;
    if (targetTrack.role === src.role) return;
    // Fire-and-forget: the reload redraws both rows when the new audio lands.
    void moveChunkToRole(src.role, targetTrack.role, drag.startMs, drag.endMs);
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
 * Edit-tool overlay: movable chunk regions on the ACTIVE audio row + the drop
 * indicator band on the row under the pointer while a chunk drag is active.
 */
function drawEditOverlay(ctx: Ctx, track: AudioTrack, rowY: number, env: TimelineEnv, h: number): void {
  const drag = env.drag?.kind === 'chunk' ? env.drag : null;
  const srcTrack = drag ? (store.getProject().tracks[drag.trackIndex] as Track | undefined) : undefined;

  // Chunk regions — only on the active editable row with loaded audio.
  if (track.id === env.activeTrackId && isEditableRole(track.role)) {
    const buf = audioEngine.getBuffer(track.role);
    if (buf) {
      const chunks: AudioChunk[] = detectChunks(buf);
      // Hover the chunk under the pointer (only when not dragging).
      let hoverIdx = -1;
      const p = env.pointer;
      if (!drag && p && p.y >= rowY && p.y <= rowY + h) {
        hoverIdx = chunkAtMs(chunks, env.xToMs(p.x));
      }
      const dragIdx = drag && srcTrack?.id === track.id ? drag.chunkIndex : -1;
      for (let i = 0; i < chunks.length; i++) {
        const x0 = env.msToX(chunks[i].startMs);
        const x1 = env.msToX(chunks[i].endMs);
        if (x1 < env.scrollLeft - 4 || x0 > env.scrollLeft + env.viewportWidth + 4) continue; // cull
        if (i === dragIdx) {
          ctx.fillStyle = 'rgba(110,168,254,0.32)';
          ctx.fillRect(x0, rowY, x1 - x0, h - 1);
          ctx.strokeStyle = '#6ea8fe';
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

  // Drop indicator: where the held chunk would land. Valid target = another
  // editable role (accent); the 'original' row shows a denied band; the source
  // row itself shows nothing (dropping there is a no-op, not an error).
  if (drag && env.dropTargetTrackId === track.id && srcTrack && srcTrack.type === 'audio' && srcTrack.role !== track.role) {
    const valid = isEditableRole(track.role);
    const x0 = env.msToX(drag.startMs);
    const x1 = env.msToX(drag.endMs);
    ctx.fillStyle = valid ? 'rgba(255,225,77,0.22)' : 'rgba(255,92,108,0.18)';
    ctx.fillRect(x0, rowY, x1 - x0, h - 1);
    ctx.strokeStyle = valid ? '#ffe14d' : '#ff5c6c';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, rowY + 0.5, Math.max(1, x1 - x0 - 1), h - 2);
  }
}
