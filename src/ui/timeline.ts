/**
 * Timeline component.
 *
 * A scrollable, zoomable horizontal canvas showing one row per line of lyrics.
 * Each syllable has a draggable marker at its start time. Dragging a marker
 * edits startMs; clicking empty ruler space seeks; the wheel zooms.
 *
 * Coordinates: ms → px via (ms / durationMs) * contentWidth. We render onto a
 * canvas whose width grows with zoom; it lives in a horizontally scrollable div.
 */
import { store } from '../state/store';
import { audioEngine } from '../lib/audioEngine';
import { timingCapture } from '../lib/timing';
import { computePeaks } from '../lib/waveform';
import { flatSyllables } from '../lib/textParser';
import { Project } from '../types';

const ROW_H = 18; // px per timeline row — height of the text line
const RULER_H = 26; // px for the time ruler
const TOP_PAD = 4;
const MARKER_W = 1; // marker is a 1px line (hit area is wider, see pickAt)
const WAVE_H = 44; // px for the waveform track (drawn between ruler and lyrics)
const TIMELINE_ROWS = 3; // fixed number of rows; syllables cycle through them
const HIT_W = 8; // horizontal hit zone half-width around the marker for dragging

export function createTimeline(): { root: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'timeline';

  const head = document.createElement('div');
  head.className = 'timeline-head';
  head.innerHTML =
    '<span>Таймлайн</span><span class="hint">— клик = перемотка, перетаскивайте маркеры, Shift+колесо = зум</span>';
  root.appendChild(head);

  const scroll = document.createElement('div');
  scroll.className = 'timeline-scroll';
  const canvas = document.createElement('canvas');
  canvas.className = 'timeline-canvas';
  const ctx = canvas.getContext('2d')!;
  scroll.appendChild(canvas);
  root.appendChild(scroll);

  let zoom = 1; // multiplied onto the base width
  let playheadMs = 0;
  // Recording state: whether we're capturing timings, and the flat index of the
  // syllable that the next Space will stamp. Used to preview it beside the playhead.
  let recording = false;
  let recordCursor = 0;

  // Minimum content width so short songs are still usable.
  const baseWidth = () => Math.max(800, scroll.clientWidth - 4);
  const contentWidth = () => baseWidth() * zoom;

  function durationMs(p?: Project): number {
    const proj = p ?? store.getProject();
    return Math.max(proj.durationMs, 1);
  }

  const msToX = (ms: number) => (ms / durationMs()) * contentWidth();
  const xToMs = (x: number) => (x / contentWidth()) * durationMs();

  // --- Interaction state ---
  type Drag = { lineIndex: number; sylIndex: number; moved: boolean };
  let drag: Drag | null = null;

  function pickAt(clientX: number, clientY: number): Drag | null {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const project = store.getProject();
    const flat = flatSyllables(project.lines);
    for (let i = 0; i < flat.length; i++) {
      const { lineIndex, sylIndex, syl } = flat[i];
      if (syl.startMs === null) continue;
      const mx = msToX(syl.startMs);
      const rowY = rowTopForRow(i % TIMELINE_ROWS);
      if (x >= mx - HIT_W && x <= mx + HIT_W && y >= rowY && y <= rowY + ROW_H) {
        return { lineIndex, sylIndex, moved: false };
      }
    }
    return null;
  }

  /** Vertical offset where lyrics rows begin (after ruler, optional waveform, padding). */
  function lyricsTop(): number {
    const showWave = store.getProject().showWaveform && !!audioEngine.audioBuffer;
    return RULER_H + TOP_PAD + (showWave ? WAVE_H + TOP_PAD : 0);
  }

  /** Y position for a row (0..TIMELINE_ROWS-1). Rows have a fixed height. */
  function rowTopForRow(row: number): number {
    return lyricsTop() + row * ROW_H;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const hit = pickAt(e.clientX, e.clientY);
    if (hit) {
      drag = hit;
      canvas.setPointerCapture(e.pointerId);
    } else {
      // Click on empty space → seek.
      const rect = canvas.getBoundingClientRect();
      const ms = xToMs(e.clientX - rect.left);
      audioEngine.seek(ms);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    let ms = xToMs(e.clientX - rect.left);
    // Clamp: can't drag past the previous or next timed syllable.
    const project = store.getProject();
    const flat = flatSyllables(project.lines);
    const myFlatIdx = flat.findIndex(
      (f) => f.lineIndex === drag!.lineIndex && f.sylIndex === drag!.sylIndex,
    );
    let minMs = 0;
    let maxMs = durationMs();
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
      const syl = p.lines[li]?.syllables[si];
      if (syl) syl.startMs = Math.round(ms);
    });
  });

  canvas.addEventListener('pointerup', (e) => {
    if (drag) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      drag = null;
    }
  });

  // Zoom: Shift+wheel zooms (anchored at the cursor); plain wheel scrolls the
  // timeline horizontally so trackpad/scroll users can still pan around.
  scroll.addEventListener(
    'wheel',
    (e) => {
      if (!e.shiftKey) return; // plain wheel → let the browser scroll horizontally
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchorX = e.clientX - rect.left; // px under cursor
      const anchorMs = xToMs(anchorX);
      zoom = Math.max(1, Math.min(40, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      // Keep the same time point under the cursor after zoom.
      const newAnchorX = msToX(anchorMs);
      scroll.scrollLeft += newAnchorX - anchorX;
      draw();
    },
    { passive: false },
  );

  audioEngine.onTime((t) => {
    playheadMs = t;
    draw();
  });
  store.subscribe(draw);
  // Reflect recording state so we can preview the next syllable at the playhead.
  timingCapture.onState((isRecording, cursor) => {
    recording = isRecording;
    recordCursor = cursor;
    draw();
  });

  function fmtTime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  }

  function draw(): void {
    const project = store.getProject();
    const dpr = window.devicePixelRatio || 1;
    const showWave = project.showWaveform && !!audioEngine.audioBuffer;
    const waveBlock = showWave ? WAVE_H + TOP_PAD : 0;
    // Fixed height: ruler + waveform + exactly TIMELINE_ROWS rows.
    const cssH = RULER_H + TOP_PAD + waveBlock + TIMELINE_ROWS * ROW_H + 8;
    const cssW = contentWidth();
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Ruler ticks
    ctx.fillStyle = '#9498b8';
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const step = niceStepMs(durationMs(), cssW);
    for (let ms = 0; ms <= durationMs(); ms += step) {
      const x = msToX(ms);
      ctx.fillStyle = '#2a2e42';
      ctx.fillRect(x, 0, 1, RULER_H);
      ctx.fillStyle = '#9498b8';
      ctx.fillText(fmtTime(ms), x + 4, 6);
    }

    // Waveform track (optional): a mirrored peak overview aligned to the time
    // axis, drawn just below the ruler. Helps align syllable markers to audio.
    if (showWave && audioEngine.audioBuffer) {
      const waveY = RULER_H + TOP_PAD;
      const midY = waveY + WAVE_H / 2;
      // Compute one peak per pixel column at the current zoom.
      const peaks = computePeaks(audioEngine.audioBuffer, Math.max(1, Math.ceil(cssW))).peaks;
      ctx.fillStyle = '#3a5a8c';
      for (let x = 0; x < cssW; x++) {
        // Map pixel → peak bucket. peaks length ≈ cssW but may differ slightly.
        const idx = Math.floor((x / cssW) * peaks.length);
        const p = peaks[idx] ?? 0;
        const half = Math.max(1, p * (WAVE_H / 2 - 1));
        ctx.fillRect(x, midY - half, 1, half * 2);
      }
      // Subtle separator line under the waveform.
      ctx.fillStyle = '#2a2e42';
      ctx.fillRect(0, waveY + WAVE_H, cssW, 1);
    }

    // Rows + syllables. IMPORTANT: only TIMED syllables are drawn. Untimed ones
    // are skipped — this is intentional (see buildTimings comment). Do not change.
    // Syllables cycle through TIMELINE_ROWS rows by their global flat index.
    const flat = flatSyllables(project.lines);
    for (let i = 0; i < flat.length; i++) {
      const { lineIndex, sylIndex, syl } = flat[i];
      if (syl.startMs === null) continue;
      const rowY = rowTopForRow(i % TIMELINE_ROWS);

      const mx = msToX(syl.startMs as number);

      // syllable text label
      ctx.fillStyle = '#7a7f9e';
      ctx.font = '11px system-ui';
      ctx.textBaseline = 'middle';
      const label = syl.text.trim();
      if (label) {
        ctx.fillText(label.slice(0, 10), mx + MARKER_W + 4, rowY + ROW_H / 2);
      }

      // fill bar to the right up to next syllable start (shows duration visually)
      const next = nextStartMs(lineIndex, sylIndex, project);
      const endX = next !== null ? msToX(next) : msToX(durationMs());
      const grad = ctx.createLinearGradient(mx, 0, endX, 0);
      grad.addColorStop(0, 'rgba(255,225,77,0.55)');
      grad.addColorStop(1, 'rgba(255,225,77,0.10)');
      ctx.fillStyle = grad;
      ctx.fillRect(mx, rowY + ROW_H / 2 - 2, Math.max(2, endX - mx), 4);

      // marker handle — thin 1px line
      ctx.fillStyle = '#ffe14d';
      ctx.fillRect(mx, rowY, MARKER_W, ROW_H);
    }

    // Playhead (the red bar that sweeps across the timeline).
    const px = msToX(playheadMs);
    ctx.fillStyle = '#ff5c6c';
    ctx.fillRect(px, 0, 2, cssH);

    // While recording, show the next syllable to be stamped just to the right of
    // the playhead, so the user can see what they're about to time.
    if (recording) {
      const next = flat[recordCursor];
      if (next && next.syl.startMs === null) {
        const label = (next.syl.text.trim() || '•').slice(0, 14);
        ctx.font = 'bold 12px system-ui';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const labelX = px + 6;
        // Pill background for legibility against the timeline.
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
    }
  }

  /** Rounded-rectangle path helper (does not fill/stroke by itself). */
  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function nextStartMs(lineIndex: number, sylIndex: number, project: Project): number | null {
    const flat = flatSyllables(project.lines);
    const i = flat.findIndex((f) => f.lineIndex === lineIndex && f.sylIndex === sylIndex);
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[j].syl.startMs !== null) return flat[j].syl.startMs;
    }
    return null;
  }

  function niceStepMs(durMs: number, widthPx: number): number {
    // Aim for ~ one tick every 80px.
    const targetPx = 80;
    const msPerPx = durMs / widthPx;
    const targetMs = targetPx * msPerPx;
    const candidates = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000];
    for (const c of candidates) if (c >= targetMs) return c;
    return 60000;
  }

  // initial draw after layout
  requestAnimationFrame(draw);

  return { root };
}
