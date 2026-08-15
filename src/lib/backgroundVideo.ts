/**
 * Video background state — the MP4 counterpart of the per-role audio bytes
 * in audioLoader.ts. The project model stores only a filename marker
 * (`background.bgVideoFileName`); the raw bytes live here, outside the
 * project JSON.
 *
 * Owns ONE hidden muted <video> element used as the live frame source for the
 * preview renderer (drawn into the canvas each RAF tick, audio-synced — see
 * ui/preview.ts). The export pipeline does NOT use it: it decodes frames via
 * mediabunny instead (lib/export.ts), sharing the same drawBackground code.
 */
/** Raw MP4 bytes of the loaded background video (null when none). */
let videoBytes: Uint8Array | null = null;
/** Object URL feeding the preview <video> element. */
let objectUrl: string | null = null;
/** Hidden, muted video element — the preview frame source. Created lazily. */
let videoEl: HTMLVideoElement | null = null;

/** Load background video bytes: store them + feed the preview element. */
export function loadBgVideo(bytes: Uint8Array): void {
  videoBytes = bytes;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'video/mp4' }));
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
