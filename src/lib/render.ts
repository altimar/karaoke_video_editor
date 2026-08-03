/**
 * The render pipeline (thin orchestrator).
 *
 * One function, `renderFrame`, draws a full frame for a given time and is used by
 * BOTH the live preview (RAF loop) and the MP4 exporter (frame loop) — so the
 * exported video is pixel-identical to what you preview.
 *
 * This module owns only the BACKGROUND layer and the dispatch to the text
 * renderer. All lyrics-layout logic lives in independent modules under
 * text_renderers/ (one per animation mode), selected by `project.style.layout`.
 */
import { Project, Style } from '../types';
import { RenderCtx } from './text_renderers/types';
import { activeIndex, applyFont, buildTimings } from './text_renderers/helpers';
import { getRenderer } from './text_renderers/registry';

// Re-export so existing callers (stylePanel) keep importing from one place.
export type { RenderCtx } from './text_renderers/types';

// --- Background layer ---

/** Draw an image covering the target box, preserving aspect ratio (CSS `cover`). */
function drawImageCover(ctx: RenderCtx, img: HTMLImageElement, w: number, h: number): void {
  const ir = img.width / img.height;
  const br = w / h;
  let dw: number, dh: number;
  if (ir > br) {
    dh = h;
    dw = h * ir;
  } else {
    dw = w;
    dh = w / ir;
  }
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Draw the background (color / gradient / image) filling the whole canvas. */
function drawBackground(ctx: RenderCtx, project: Project, bgImg: HTMLImageElement | null): void {
  const { width, height, style } = project;
  ctx.clearRect(0, 0, width, height);
  if (style.bgType === 'gradient') {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, style.bgColors[0]);
    grad.addColorStop(1, style.bgColors[1]);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = style.bgType === 'image' && bgImg ? '#000' : style.bgColor;
  }
  ctx.fillRect(0, 0, width, height);
  if (style.bgType === 'image' && bgImg) drawImageCover(ctx, bgImg, width, height);
}

// Cache decoded background images by data URL to avoid re-decoding each frame.
const bgImageCache = new Map<string, HTMLImageElement>();

function getBgImage(style: Style): HTMLImageElement | null {
  if (style.bgType !== 'image' || !style.bgImageDataUrl) return null;
  const cached = bgImageCache.get(style.bgImageDataUrl);
  if (cached && cached.complete) return cached;
  const img = new Image();
  img.src = style.bgImageDataUrl;
  bgImageCache.set(style.bgImageDataUrl, img);
  return img.complete ? img : null;
}

export function invalidateBgImageCache(): void {
  bgImageCache.clear();
}

/**
 * Render one full frame at timeMs. Draws the background, then delegates the
 * lyrics layer to the renderer selected by `project.style.layout`.
 */
export function renderFrame(ctx: RenderCtx, timeMs: number, project: Project): void {
  if (project.lines.length === 0) return;

  // 1. Background.
  const bgImg = getBgImage(project.style);
  drawBackground(ctx, project, bgImg);

  // 2. Shared timing data for the lyrics layer.
  const timings = buildTimings(project);
  if (timings.length === 0) return;
  const activeIdx = activeIndex(timings, timeMs);
  const activeLineIndex = activeIdx >= 0 ? timings[activeIdx].lineIndex : 0;

  // 3. Font applies to every renderer; set once on the shared context.
  applyFont(ctx, project.style);

  // 4. Dispatch to the selected renderer, handing it its resolved settings.
  const renderer = getRenderer(project.style.layout);
  const stored = project.rendererSettings?.[renderer.id] ?? {};
  const settings: Record<string, number | boolean> = {};
  for (const spec of renderer.settings) {
    const v = stored[spec.key];
    settings[spec.key] = v !== undefined ? v : spec.default;
  }
  renderer.render(ctx, timeMs, { project, timings, activeLineIndex }, settings);
}
