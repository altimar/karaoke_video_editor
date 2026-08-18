/**
 * Video background state — the MP4 counterpart of the per-role audio bytes
 * in audioLoader.ts. The project model stores only a filename marker
 * (`background.bgVideoFileName`); the raw bytes live here, outside the
 * project JSON.
 *
 * On load the video is REMUXED to video-only (mediabunny packet copy, no
 * re-encode): audio/subtitle tracks are stripped so they don't bloat the
 * saved project and the exported KFN. On any remux failure the ORIGINAL bytes
 * are kept (better a larger file than a failed load).
 *
 * Owns ONE hidden muted <video> element used as the live frame source for the
 * preview renderer (drawn into the canvas each RAF tick, audio-synced — see
 * ui/preview.ts). The export pipeline does NOT use it: it decodes frames via
 * mediabunny instead (lib/export.ts), sharing the same drawBackground code.
 */
import { Input, Output, BufferTarget, Mp4OutputFormat, Conversion, ALL_FORMATS, BlobSource } from 'mediabunny';

/** Raw MP4 bytes of the loaded background video (null when none). */
let videoBytes: Uint8Array | null = null;
/** Object URL feeding the preview <video> element. */
let objectUrl: string | null = null;
/** Hidden, muted video element — the preview frame source. Created lazily. */
let videoEl: HTMLVideoElement | null = null;

/**
 * Remux a video file down to its VIDEO track only (mp4, packet copy — no
 * re-encode). Returns the original bytes untouched when there is nothing to
 * strip (no audio) or anything goes wrong (unparseable input, remux error):
 * a failed cleanup must never block loading the background.
 */
export async function stripVideoOnlyMp4(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(new Blob([bytes.buffer as ArrayBuffer], { type: 'video/mp4' })),
    });
    const video = await input.getPrimaryVideoTrack();
    if (!video) return bytes; // no video track — nothing we can do
    if ((await input.getAudioTracks()).length === 0) return bytes; // already clean
    const target = new BufferTarget();
    const output = new Output({
      target,
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }), // moov up front
    });
    const conv = await Conversion.init({
      input,
      output,
      audio: { discard: true }, // drop every audio track; copy video as-is
      showWarnings: false,
    });
    await conv.execute();
    return target.buffer ? new Uint8Array(target.buffer) : bytes;
  } catch (e) {
    console.warn('Не удалось вырезать аудио из видео фона — используется оригинал:', e);
    return bytes;
  }
}

/** Load background video bytes: strip non-video tracks, store, feed the preview. */
export async function loadBgVideo(bytes: Uint8Array): Promise<void> {
  videoBytes = await stripVideoOnlyMp4(bytes);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(new Blob([videoBytes.buffer as ArrayBuffer], { type: 'video/mp4' }));
  const el = ensureVideoEl();
  el.src = objectUrl;
  el.load();
}

/** Drop the background video (back to color/gradient/image). */
export function clearBgVideo(): void {
  videoBytes = null;
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

/** Raw bytes for export (project save, KFN export), or null. */
export function getBgVideoBytes(): Uint8Array | null {
  return videoBytes;
}

/** The preview frame source element (hidden, muted). Null outside a browser. */
export function bgVideoEl(): HTMLVideoElement | null {
  return videoEl;
}

/** Create the hidden video element once and attach it to the document. */
function ensureVideoEl(): HTMLVideoElement {
  if (videoEl) return videoEl;
  videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.preload = 'auto';
  videoEl.style.display = 'none';
  document.body.appendChild(videoEl);
  return videoEl;
}
