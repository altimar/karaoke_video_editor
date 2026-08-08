/**
 * MP4 exporter.
 *
 * Renders the project frame-by-frame onto an offscreen canvas (using the SAME
 * renderFrame as the preview), captures each frame via Mediabunny's
 * CanvasSource (H.264/AVC), and muxes it together with the song's audio
 * (re-encoded to AAC via AudioBufferSource). Output is a real .mp4 file with
 * both tracks — no ffmpeg, no server.
 *
 * Requires the WebCodecs API (Chrome/Edge). We feature-detect up front.
 */
import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  Quality,
} from 'mediabunny';
import { Project, TextTrack, Track, VolumePoint, AudioRole, getAudioTrackByRole, isRoleAudible } from '../types';
import { renderFrame } from './render';

/**
 * Build a copy of the project scaled to the target resolution, multiplying all
 * pixel-based text style values (font size, stroke, glow) of EVERY track by the
 * same factor. This lets renderFrame draw directly at the output resolution — so
 * there is no separate native-resolution pass followed by a per-frame drawImage
 * downscale, which was the previous export bottleneck. The authored look is
 * preserved because every dimension scales uniformly.
 */
function scaledProject(project: Project, targetW: number, targetH: number): Project {
  const scale = targetH / project.height;
  if (scale === 1) return project; // no scaling needed at native resolution
  // Scale pixel-based style values of TEXT tracks only; audio tracks pass through.
  const tracks: Track[] = project.tracks.map((t) => {
    if (t.type !== 'text') return t;
    const text: TextTrack = {
      ...t,
      style: {
        ...t.style,
        fontSize: t.style.fontSize * scale,
        strokeWidth: t.style.strokeWidth * scale,
        glowBlur: t.style.glowBlur * scale,
      },
    };
    return text;
  });
  return { ...project, width: targetW, height: targetH, tracks };
}

/**
 * Mix + render several audio buffers (each with its own volume automation) into
 * ONE AudioBuffer, summing them at the destination. Used for the video export:
 * the 'minus' and 'back' roles are combined (the 'original' role is excluded).
 * Each buffer is played through its own GainNode programmed from its envelope,
 * so the export matches the live playback mix. All buffers must share a sample
 * rate (they do — decoded through one AudioContext).
 */
export async function renderMixedAudioWithGain(
  stems: { buffer: AudioBuffer; points: VolumePoint[] }[],
): Promise<AudioBuffer> {
  if (stems.length === 0) throw new Error('Нет аудио для рендера');
  // Single stem, no automation → return as-is (no work needed).
  if (stems.length === 1 && stems[0].points.length === 0) return stems[0].buffer;
  const sampleRate = stems[0].buffer.sampleRate;
  const channels = Math.max(1, ...stems.map((s) => s.buffer.numberOfChannels));
  const maxDurSec = Math.max(...stems.map((s) => s.buffer.duration));
  const length = Math.ceil(maxDurSec * sampleRate);
  const Ctor = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctor(channels, length, sampleRate);
  for (const { buffer, points } of stems) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    if (points.length > 0) {
      const g = gain.gain;
      g.setValueAtTime(points[0].gain, 0);
      for (let i = 1; i < points.length; i++) {
        g.linearRampToValueAtTime(points[i].gain, points[i].timeMs / 1000);
      }
      g.setValueAtTime(points[points.length - 1].gain, maxDurSec);
    }
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(0);
  }
  return ctx.startRendering();
}

export type ProgressFn = (fraction: number) => void;

import { ExportError, ExportCanceledError } from './exportErrors';
// Re-exported from exportErrors so lightweight consumers (kfnExport, dialog) can
// import them without pulling in the full MP4 pipeline (mediabunny/WebCodecs).
export { ExportError, ExportCanceledError };

/** Available export qualities: label, height in px, and a target video bitrate. */
export interface QualityPreset {
  id: string;
  label: string;
  height: number;
  bitrate: number; // bits per second
}

/**
 * Export quality presets, from 360p up to 4K. Width is derived from height using
 * the project's aspect ratio (16:9 by default). Bitrates are chosen for clean,
 * watchable text on top of backgrounds — they scale with resolution.
 */
export const QUALITY_PRESETS: QualityPreset[] = [
  { id: '360p', label: '360p', height: 360, bitrate: 1_000_000 },
  { id: '480p', label: '480p', height: 480, bitrate: 2_000_000 },
  { id: '720p', label: '720p (HD)', height: 720, bitrate: 4_000_000 },
  { id: '1080p', label: '1080p (Full HD)', height: 1080, bitrate: 8_000_000 },
  { id: '1440p', label: '1440p (2K)', height: 1440, bitrate: 16_000_000 },
  { id: '4k', label: '2160p (4K)', height: 2160, bitrate: 32_000_000 },
];

export const DEFAULT_QUALITY_ID = '480p';

/** Find a preset by id (falls back to the default 480p). */
export function getQualityPreset(id: string): QualityPreset {
  return QUALITY_PRESETS.find((q) => q.id === id) ?? QUALITY_PRESETS[1];
}

/** Options controlling an export run. */
export interface ExportOptions {
  /** Quality preset; determines output resolution + bitrate. */
  qualityId: string;
  /** If provided and aborted, the export stops and rejects with ExportCanceledError. */
  signal?: AbortSignal;
}

/** True if this browser can run the WebCodecs-based export. */
export function canExport(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}

/**
 * Export the project to an MP4 Blob.
 *
 * Rendering is done at the project's native resolution (where fonts/effects are
 * authored) and then scaled onto the target-resolution canvas, so the picture
 * looks identical at every quality — only the output size and bitrate change.
 *
 * The audio track is the MIX of the 'minus' and 'back' roles (each with its own
 * volume automation); the 'original' role is excluded from the export.
 *
 * @param project  The project.
 * @param audioByRole  Decoded PCM per role (only minus/back are used here).
 * @param options  Quality preset + optional abort signal.
 * @param onProgress Called with 0..1 as frames are encoded.
 */
export async function exportToMp4(
  project: Project,
  audioByRole: Map<AudioRole, AudioBuffer>,
  options: ExportOptions,
  onProgress?: ProgressFn,
): Promise<Blob> {
  if (!canExport()) {
    throw new ExportError(
      'Экспорт не поддерживается в этом браузере. Нужен Chrome или Edge (WebCodecs API).',
    );
  }

  const preset = getQualityPreset(options.qualityId);
  const { fps, durationMs } = project;
  const durationSec = durationMs / 1000;

  // Target resolution: keep the project's aspect ratio, snap width to even
  // pixels (some encoders require even dimensions).
  const aspect = project.width / project.height;
  let outH = preset.height;
  let outW = Math.round(outH * aspect);
  if (outW % 2 !== 0) outW += 1;

  // Single offscreen canvas at the OUTPUT resolution. We render straight into it
  // using a project scaled to this resolution — no separate native-res pass and
  // no per-frame drawImage downscale. This roughly halves the per-frame work at
  // sub-native qualities (360p/480p/720p).
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new ExportError('Не удалось получить 2D-контекст для экспорта.');
  const renderProject = scaledProject(project, outW, outH);

  // --- Output: MP4 container writing into an in-memory buffer ---
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat(),
    target,
  });

  // --- Video track: each CanvasSource.add() captures the current canvas.
  // Frame dimensions come from the canvas; the encoding config only sets codec
  // + quality (bitrate) + key frame interval. Frame rate is declared in track
  // metadata so timestamps are snapped to it.
  // NOTE: `quality` MUST be a `Quality` instance, not a bare string — Mediabunny's
  // runtime validator rejects strings with "config.quality ... must be a Quality". ---
  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: preset.bitrate }),
    keyFrameInterval: 5,
  });

  // --- Audio track: feed the whole decoded AudioBuffer as AAC. Channel count
  // and sample rate are read directly from the AudioBuffer by the source. ---
  const audioSource = new AudioBufferSource({
    codec: 'aac',
    quality: new Quality('high'),
  });

  output.addVideoTrack(videoSource, { frameRate: fps });
  output.addAudioTrack(audioSource);

  const signal = options.signal;
  const checkCanceled = (): void => {
    if (signal?.aborted) throw new ExportCanceledError('Экспорт отменён');
  };

  await output.start();

  const frameDur = 1 / fps; // seconds
  const totalFrames = Math.max(1, Math.ceil(durationSec * fps));

  try {
    // Render every frame. (We can't skip "static" frames: layouts like the
    // scrolling view move text continuously, even between syllable fills.)
    for (let i = 0; i < totalFrames; i++) {
      checkCanceled();
      const timeMs = (i / fps) * 1000;
      renderFrame(ctx, timeMs, renderProject);
      const tSec = i / fps;
      // Add waits for the encoder when needed → respects backpressure, keeps memory bounded.
      await videoSource.add(tSec, frameDur, { keyFrame: i % (fps * 5) === 0 });
      if (onProgress) onProgress((i + 1) / totalFrames);
    }

    checkCanceled();
    // Mix the audible stems (lead/minus/back) with their volume automation into
    // a single buffer, respecting each role's mute/solo state. 'original' is
    // always excluded — the export is a rendered mix, never the reference track.
    const stems: { buffer: AudioBuffer; points: VolumePoint[] }[] = [];
    for (const role of ['lead', 'minus', 'back'] as AudioRole[]) {
      if (!isRoleAudible(project, role)) continue;
      const buf = audioByRole.get(role);
      if (!buf) continue;
      const at = getAudioTrackByRole(project, role);
      stems.push({ buffer: buf, points: at?.volumeAutomation ?? [] });
    }
    if (stems.length === 0) throw new ExportError('Нет аудио для экспорта (все дорожки заглушены).');
    const finalAudio = await renderMixedAudioWithGain(stems);
    await audioSource.add(finalAudio);

    checkCanceled();
    await output.finalize();
  } catch (err) {
    // On cancel or error, release the encoder/muxer resources and propagate.
    await output.cancel().catch(() => {});
    throw err;
  }

  if (!target.buffer) throw new ExportError('Экспорт не произвёл данных.');
  // Build the final mp4 Blob with a precise MIME type.
  return new Blob([target.buffer], { type: 'video/mp4' });
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
