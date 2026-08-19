/**
 * Timeline PAINTER — everything that turns state into canvas pixels: the
 * canvas sizing/backing-store sync, the time ruler, one row per track
 * (delegated to the track views), the Фон pseudo-row (filmstrip/status), the
 * playhead and the recording pill. Owns the rAF-throttled repaint entry
 * (`scheduleDraw`). No input handling, no DOM beyond the canvas it is given.
 *
 * The orchestrator (index.ts) owns the mutable state and passes READ access
 * through `PainterDeps` (getters for live values); drawing itself is
 * stateless besides the throttle flag.
 */
import { Track } from '../../types';
import { flatSyllables } from '../../lib/textParser';
import { getBgVideoBytes } from '../../lib/backgroundVideo';
import { ensureBgFilmstrip } from '../../lib/bgThumbnails';
import { store } from '../../state/store';
import {
  RULER_H, TOP_PAD, TRACK_PAD, BG_ROW_H, rowHeight, trackTopForIndex, bgRowTop,
} from './coords';
import { Ctx, TimelineEnv, TrackView } from './types';

/** Read access to the orchestrator's live state (all getters — no stale snapshots). */
export interface PainterDeps {
  canvas: HTMLCanvasElement;
  /** Content-width spacer — kept in sync with the zoom on every draw. */
  wrap: HTMLElement;
  /** The scroll container (scrollLeft / clientWidth define the visible window). */
  scroll: HTMLElement;
  /** Track-view registry (by `track.type`) — rows draw themselves. */
  views: Record<string, TrackView>;
  displayTracks: () => Track[];
  makeEnv: () => TimelineEnv;
  /** Song duration in ms (clamped to ≥1). */
  durationMs: () => number;
  contentWidth: () => number;
  viewportWidth: () => number;
  msToX: (ms: number) => number;
  /** Content-space x → ms (the ruler hover tooltip reads the pointer time). */
  xToMs: (x: number) => number;
  playheadMs: () => number;
  /** Recording state for the "next syllable" pill beside the playhead. */
  recording: () => { active: boolean; cursor: number };
}

export function createPainter(deps: PainterDeps): { draw(): void; scheduleDraw(): void } {
  const { canvas, wrap, scroll, views } = deps;
  const ctx = canvas.getContext('2d')!;

  let drawScheduled = false;
  function scheduleDraw(): void {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      draw();
    });
  }

  function draw(): void {
    const tracks = deps.displayTracks();
    // Height: ruler + one row per track + the background pseudo-row. Ends
    // EXACTLY at the bg row bottom — no trailing pad: the canvas must not
    // extend past the last row (visible dead space under «Фон»).
    let cssH = RULER_H + TOP_PAD;
    for (const t of tracks) cssH += rowHeight(t, deps.makeEnv().activeTrackId) + TRACK_PAD;
    cssH += BG_ROW_H;
    // The canvas is viewport-wide; the spacer carries the full content width so
    // the scroll container can pan. canvas backing store scales only with the
    // viewport (× dpr), never with zoom — so it can't exceed the device limit.
    const dpr = window.devicePixelRatio || 1;
    const vw = deps.viewportWidth();
    const cw = deps.contentWidth();
    wrap.style.width = `${cw}px`;
    if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${cssH}px`;
    }
    // Draw in CSS pixels (dpr baked into the transform), then shift everything
    // left by scrollLeft so the visible slice of content lands in the viewport.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, cssH);
    ctx.translate(-scroll.scrollLeft, 0);

    // Visible content window — used to cull ruler ticks / active band fills.
    const left = scroll.scrollLeft;
    const right = scroll.scrollLeft + vw;

    // Ruler ticks — iterate by ms (as before) but cull ticks off the visible
    // window. A small left margin keeps labels of ticks just entering view.
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const step = niceStepMs(deps.durationMs(), cw);
    for (let ms = 0; ms <= deps.durationMs(); ms += step) {
      const x = deps.msToX(ms);
      if (x < left - 40 || x > right) continue;
      ctx.fillStyle = '#2a2e42';
      ctx.fillRect(x, 0, 1, RULER_H);
      ctx.fillStyle = '#9498b8';
      ctx.fillText(fmtTime(ms), x + 4, 6);
    }

    // One row per track — delegate drawing to its view.
    const env = deps.makeEnv();
    // Ruler hover: a time bubble right under the cursor (pre-click feedback
    // for seeking). Content-space pointer → screen-space x, clamped in view.
    if (env.pointer && env.pointer.y <= RULER_H) {
      const ms = Math.max(0, Math.min(deps.durationMs(), deps.xToMs(env.pointer.x)));
      const label = fmtTimePrecise(ms);
      const tw = ctx.measureText(label).width;
      const bw = tw + 12;
      const bh = 16;
      const sx = env.pointer.x - scroll.scrollLeft;
      const bx = Math.max(2, Math.min(vw - bw - 2, sx - bw / 2));
      ctx.fillStyle = '#232639';
      ctx.strokeStyle = '#3a3f5a';
      ctx.lineWidth = 1;
      roundRect(ctx, bx, RULER_H + 3, bw, bh, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e6e8f5';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 6, RULER_H + 3 + bh / 2 + 0.5);
    }

    const activeId = env.activeTrackId;
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      const view = views[track.type];
      if (!view) continue;
      const rowY = trackTopForIndex(ti, tracks, activeId);
      // Active track subtle highlight band (only the visible slice).
      if (track.id === activeId) {
        ctx.fillStyle = 'rgba(255,225,77,0.06)';
        ctx.fillRect(Math.max(0, left), rowY - 2, Math.min(cw, right) - Math.max(0, left), rowHeight(track, activeId) + 4);
      }
      view.draw(ctx, track, rowY, env);
    }

    drawBackgroundRow(ctx, tracks, env, { left, right, vw, cw });

    // Playhead (red bar sweeping across the timeline).
    const px = deps.msToX(deps.playheadMs());
    ctx.fillStyle = '#ff5c6c';
    ctx.fillRect(px, 0, 2, cssH);

    // While recording, show the next syllable to be stamped beside the playhead.
    const rec = deps.recording();
    if (rec.active) {
      const activeIdx = tracks.findIndex((t) => t.id === activeId);
      const activeTrack = activeIdx >= 0 ? tracks[activeIdx] : null;
      if (activeTrack && activeTrack.type === 'text') {
        const flat = flatSyllables(activeTrack.lines);
        const next = flat[rec.cursor];
        if (next && next.syl.startMs === null) {
          drawRecordPill(ctx, px, next.syl.text);
        }
      }
    }
  }

  /** The Фон pseudo-row: filmstrip for a video bg, status text otherwise. */
  function drawBackgroundRow(
    ctx: Ctx,
    tracks: Track[],
    env: TimelineEnv,
    win: { left: number; right: number; vw: number; cw: number },
  ): void {
    const bgY = bgRowTop(tracks, env.activeTrackId);
    const bg = store.getProject().background;
    ctx.fillStyle = '#2a2e42';
    const bgSepX = Math.max(0, Math.floor(win.left));
    const bgSepW = Math.min(win.cw, win.right) - bgSepX;
    ctx.fillRect(bgSepX, bgY + BG_ROW_H - 1, Math.max(0, bgSepW), 1);

    let drewFilmstrip = false;
    if (bg.bgType === 'video') {
      const bytes = getBgVideoBytes();
      if (bytes) {
        const strip = ensureBgFilmstrip(bytes);
        if (strip && strip.thumbs.length > 0) {
          drewFilmstrip = true;
          const { thumbs } = strip;
          // Thumbnails keep their NATIVE aspect (height = row, width from the
          // frame's ratio) and are left-anchored at their timestamp. When the
          // zoom level makes them wider than the sampling interval, a fixed
          // INDEX STRIDE is used — NOT a viewport-relative skip — so the drawn
          // subset stays identical while scrolling (a viewport-relative skip
          // made thumbnails visually "jump" as the scroll position decided
          // which of the overlapping frames to drop).
          const GAP = 4; // min px between neighboring thumbnails
          const pxPerSec = deps.contentWidth() / deps.durationMs() * 1000;
          const spacing = strip.intervalSec * pxPerSec; // px between samples
          let maxW = 1;
          for (const th of thumbs) maxW = Math.max(maxW, Math.round((th.canvas.width / th.canvas.height) * BG_ROW_H));
          const stride = Math.max(1, Math.ceil((maxW + GAP) / spacing));
          for (let i = 0; i < thumbs.length; i += stride) {
            const c = thumbs[i].canvas;
            const tw = Math.max(1, Math.round((c.width / c.height) * BG_ROW_H));
            const x = deps.msToX(thumbs[i].tSec * 1000);
            if (x + tw < win.left || x > win.right) continue; // cull off-screen only
            ctx.drawImage(c, x, bgY, tw, BG_ROW_H);
          }
          // Where the video ends earlier than the song, show the fallback
          // color zone (the bg color visible in preview/export after the end).
          const endX = deps.msToX(Math.min(strip.durationSec * 1000, deps.durationMs()));
          if (endX < win.right) {
            ctx.fillStyle = bg.bgColor;
            ctx.fillRect(Math.max(endX, win.left), bgY, win.right - Math.max(endX, win.left), BG_ROW_H);
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.fillRect(endX, bgY, 1, BG_ROW_H);
            ctx.fillStyle = '#5a5f7e';
            ctx.font = '10px system-ui';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            if (win.right - Math.max(endX, win.left) > 70) ctx.fillText('цвет фона', Math.max(endX, win.left) + 6, bgY + BG_ROW_H / 2);
          }
        }
      }
    }
    if (!drewFilmstrip) {
      ctx.fillStyle = '#5a5f7e';
      ctx.font = '11px system-ui';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const bgLabel =
        bg.bgType === 'video'
          ? `фон: видео (${bg.bgVideoFileName ?? 'bg.mp4'})${getBgVideoBytes() ? ' — кадры готовятся…' : ''}`
          : bg.bgType === 'image'
            ? 'фон: картинка'
            : bg.bgType === 'gradient'
              ? 'фон: градиент'
              : 'фон: цвет';
      ctx.fillText(
        bg.bgType === 'video' || bg.bgType === 'image' ? bgLabel + ' — клик сменить' : 'фон — клик: картинка или MP4',
        env.width / 2,
        bgY + BG_ROW_H / 2,
      );
      ctx.textAlign = 'left';
    }
  }

  function drawRecordPill(ctx: Ctx, px: number, raw: string): void {
    const label = (raw.trim() || '•').slice(0, 14);
    ctx.font = 'bold 12px system-ui';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const labelX = px + 6;
    const padX = 5;
    const tw = ctx.measureText(label).width;
    const pillY = RULER_H + 4;
    const pillH = 18;
    ctx.fillStyle = 'rgba(255,92,108,0.18)';
    roundRect(ctx, labelX - padX, pillY, tw + padX * 2, pillH, 4);
    ctx.fill();
    ctx.strokeStyle = '#ff5c6c';
    ctx.lineWidth = 1;
    roundRect(ctx, labelX - padX, pillY, tw + padX * 2, pillH, 4);
    ctx.stroke();
    ctx.fillStyle = '#ffd0d6';
    ctx.fillText(label, labelX, pillY + pillH / 2 + 1);
  }

  function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** m:ss.d — the ruler hover bubble (a bit more precise than tick labels). */
  function fmtTimePrecise(ms: number): string {
    const t = Math.floor(ms / 100);
    const s = Math.floor(t / 10);
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, '0')}.${t % 10}`;
  }

  function fmtTime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  }

  function niceStepMs(durMs: number, widthPx: number): number {
    const targetPx = 80;
    const msPerPx = durMs / widthPx;
    const targetMs = targetPx * msPerPx;
    const candidates = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000];
    for (const c of candidates) if (c >= targetMs) return c;
    return 60000;
  }

  return { draw, scheduleDraw };
}
