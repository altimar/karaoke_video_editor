/**
 * TrackView strategy for AUDIO tracks: draws the waveform peaks + volume
 * automation envelope, hit-tests envelope points for dragging, handles
 * background clicks (add a point) and double-taps (delete a point).
 *
 * All track-type-specific logic for audio lives here. The orchestrator hands it
 * the row position + env (including pre-computed peaks). It never recomputes
 * layout itself — the row top is always provided by the caller.
 */
import { store } from '../../state/store';
import { audioEngine } from '../../lib/audioEngine';
import { computePeaks } from '../../lib/waveform';
import { insertPoint, removePoint, movePoint, clampGain } from '../../lib/volumeAutomation';
import { AudioTrack } from '../../types';
import { AUDIO_ROW_H } from './coords';
import { Ctx, TimelineEnv, TrackDrag, TrackView } from './types';

export const audioView: TrackView<AudioTrack> = {
  rowHeight: AUDIO_ROW_H,

  draw(ctx: Ctx, track: AudioTrack, rowY: number, env: TimelineEnv): void {
    const midY = rowY + AUDIO_ROW_H / 2;
    // Waveform peaks (mirrored) for THIS role's audio, if loaded.
    const buf = audioEngine.getBuffer(track.role);
    if (buf) {
      const peaks = computePeaks(buf, Math.max(1, Math.ceil(env.width))).peaks;
      ctx.fillStyle = '#3a5a8c';
      const w = env.width;
      for (let x = 0; x < w; x++) {
        const idx = Math.floor((x / w) * peaks.length);
        const p = peaks[idx] ?? 0;
        const half = Math.max(1, p * (AUDIO_ROW_H / 2 - 1));
        ctx.fillRect(x, midY - half, 1, half * 2);
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
    // Separator line under the row.
    ctx.fillStyle = '#2a2e42';
    ctx.fillRect(0, rowY + AUDIO_ROW_H, env.width, 1);

    // Volume automation envelope.
    drawEnvelope(ctx, track, rowY, env);
  },

  hitTest(track: AudioTrack, rowY: number, x: number, y: number, env: TimelineEnv): TrackDrag | null {
    const ti = indexOfTrack(track);
    if (ti < 0) return null;
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

  onBackgroundClick(_track: AudioTrack, rowY: number, x: number, y: number, env: TimelineEnv): void {
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
};

/** Find the index of a track in the current project by id (for store mutations). */
function indexOfTrack(track: { id: string }): number {
  return store.getProject().tracks.findIndex((t) => t.id === track.id);
}

/** Draw the volume-automation envelope (line + points) on top of the waveform. */
function drawEnvelope(ctx: Ctx, track: AudioTrack, rowY: number, env: TimelineEnv): void {
  const midY = rowY + AUDIO_ROW_H / 2;
  const pts = track.volumeAutomation;
  const gainToY = (g: number): number => midY - (g - 1) * (AUDIO_ROW_H / 2);
  ctx.strokeStyle = pts.length > 0 ? '#ffe14d' : 'rgba(255,225,77,0.3)';
  ctx.lineWidth = 1.5;
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
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
