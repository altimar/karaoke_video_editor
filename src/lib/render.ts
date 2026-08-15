/**
 * The render pipeline (thin orchestrator).
 *
 * One function, `renderFrame`, draws a full frame for a given time and is used by
 * BOTH the live preview (RAF loop) and the MP4 exporter (frame loop) — so the
 * exported video is pixel-identical to what you preview.
 *
 * This module owns only the BACKGROUND layer and the dispatch to the text
 * renderers. The background is drawn ONCE per frame (it is shared across all
 * tracks), then each text track is rendered on top, in array order. Tracks are
 * independent: each has its own lyrics, text style, layout and renderer
 * settings, and they may overlap visually. All lyrics-layout logic lives in
 * independent modules under text_renderers/ (one per animation mode), selected
 * by each track's `style.layout`.
 */
import { Background, BgFit, Project } from '../types';
import { RenderCtx } from './text_renderers/types';
import { activeIndex, applyFont, buildTimings } from './text_renderers/helpers';
import { getRenderer } from './text_renderers/registry';

// Re-export so existing callers (stylePanel) keep importing from one place.
export type { RenderCtx } from './text_renderers/types';

// --- Background layer ---

/**
 * Draw an image-like source into the target box according to the fit mode:
 * - 'cover'   — preserve aspect, fill the box, crop the excess (centered);
 * - 'stretch' — fill the box exactly, distorting the aspect ratio;
 * - 'contain' — fit entirely inside, centered; the surrounding area keeps
 *              whatever was drawn below (the bg color/gradient layer).
 */
function drawBgImage(ctx: RenderCtx, img: CanvasImageSource, w: number, h: number, fit: BgFit): void {
  // <video> reports its intrinsic size via videoWidth/videoHeight; images and
  // decoded frames via width/height. Read both defensively.
  const s = img as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
  const iw = s.videoWidth || s.width || 0;
  const ih = s.videoHeight || s.height || 0;
  if (!iw || !ih) return;
  if (fit === 'stretch') {
    ctx.drawImage(img, 0, 0, w, h);
    return;
  }
  const ir = iw / ih;
  const br = w / h;
  let dw: number, dh: number;
  if (fit === 'cover') {
    if (ir > br) {
      dh = h;
      dw = h * ir;
    } else {
      dw = w;
      dh = w / ir;
    }
  } else {
    // contain
    if (ir > br) {
      dw = w;
      dh = w / ir;
    } else {
      dh = h;
      dw = h * ir;
    }
  }
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * Draw the background filling the whole canvas.
 *
 * The color/gradient layer is ALWAYS drawn first — it is the fallback that
 * shows through wherever nothing else covers it: before the video's first
 * frame and after it ends (a background video shorter than the song shows the
 * background color at the tail; a longer one is trimmed by the export loop,
 * which never renders past durationMs).
 *
 * `bgVideoFrame` is the current background-video frame source: the live
 * <video> element for the preview, a decoded frame for the export. null →
 * no video layer (not loaded, or past its end).
 */
function drawBackground(
  ctx: RenderCtx,
  project: Project,
  bg: Background,
  bgImg: HTMLImageElement | null,
  bgVideoFrame: CanvasImageSource | null,
): void {
  const { width, height } = project;
  ctx.clearRect(0, 0, width, height);
  if (bg.bgType === 'gradient') {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, bg.bgColors[0]);
    grad.addColorStop(1, bg.bgColors[1]);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = bg.bgType === 'image' && bgImg ? '#000' : bg.bgColor;
  }
  ctx.fillRect(0, 0, width, height);
  if (bg.bgType === 'image' && bgImg) drawBgImage(ctx, bgImg, width, height, bg.bgFit ?? 'cover');
  if (bg.bgType === 'video' && bgVideoFrame) drawBgImage(ctx, bgVideoFrame, width, height, bg.bgFit ?? 'cover');
}

// Cache decoded background images by data URL to avoid re-decoding each frame.
const bgImageCache = new Map<string, HTMLImageElement>();

function getBgImage(bg: Background): HTMLImageElement | null {
  if (bg.bgType !== 'image' || !bg.bgImageDataUrl) return null;
  const cached = bgImageCache.get(bg.bgImageDataUrl);
  if (cached && cached.complete) return cached;
  const img = new Image();
  img.src = bg.bgImageDataUrl;
  bgImageCache.set(bg.bgImageDataUrl, img);
  return img.complete ? img : null;
}

export function invalidateBgImageCache(): void {
  bgImageCache.clear();
}

/**
 * Resolve one track's renderer settings: merge stored values with the renderer's
 * declared defaults. Returned object has exactly the keys the renderer expects.
 */
function resolveSettings(layout: string, stored: Record<string, Record<string, number | boolean>> | undefined): Record<string, number | boolean> {
  const renderer = getRenderer(layout as never);
  const values = stored?.[renderer.id] ?? {};
  const settings: Record<string, number | boolean> = {};
  for (const spec of renderer.settings) {
    const v = values[spec.key];
    settings[spec.key] = v !== undefined ? v : spec.default;
  }
  return settings;
}

/**
 * Render one full frame at timeMs. Draws the shared background once, then renders
 * every text track on top, in array order. Tracks are independent and may overlap.
 *
 * `bgVideoFrame` (optional): the background-video frame source at timeMs — the
 * preview passes its synced <video> element, the MP4 export passes the decoded
 * frame. Omitted/null → the color/gradient fallback shows (also what happens
 * when the video is shorter than the song).
 */
export function renderFrame(ctx: RenderCtx, timeMs: number, project: Project, bgVideoFrame?: CanvasImageSource | null): void {
  if (project.tracks.length === 0) return;

  // 1. Shared background (drawn once for the whole frame).
  const bg = project.background;
  const bgImg = getBgImage(bg);
  drawBackground(ctx, project, bg, bgImg, bgVideoFrame ?? null);

  // 2. Render each text track independently, on top of the background.
  //    Audio tracks have no visual representation in the frame — skip them.
  for (const track of project.tracks) {
    if (track.type !== 'text') continue;
    const timings = buildTimings(track.lines, project.durationMs);
    if (timings.length === 0) continue;

    const activeIdx = activeIndex(timings, timeMs);
    const activeLineIndex = activeIdx >= 0 ? timings[activeIdx].lineIndex : 0;

    // Font applies to every renderer; set once per track on the shared context.
    applyFont(ctx, track.style);

    const renderer = getRenderer(track.style.layout);
    const settings = resolveSettings(track.style.layout, track.rendererSettings);
    renderer.render(ctx, timeMs, {
      lines: track.lines,
      style: track.style,
      width: project.width,
      height: project.height,
      durationMs: project.durationMs,
      timings,
      activeLineIndex,
    }, settings);
  }
}
