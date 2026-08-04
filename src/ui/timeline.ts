/**
 * Timeline component.
 *
 * Layout (like an audio editor): a fixed LEFT GUTTER of track "headers" plus a
 * horizontally-scrollable TIMELINE CANVAS on the right.
 *  - Gutter (HTML, not canvas): one header block per text track + one for the
 *    optional waveform ("минус"). Headers are all the same width; clicking a
 *    track header activates that track. The gutter does not scroll.
 *  - Canvas: a shared time RULER, one optional WAVEFORM, and one ROW PER TEXT
 *    TRACK. Time is measured from the canvas left edge (x=0); there is no left
 *    margin on the canvas. Clicking the canvas seeks; dragging a marker edits
 *    its startMs; the wheel zooms.
 *
 * The gutter block heights are kept in sync with the canvas rows (same
 * constants), so each header lines up with its track's marker line.
 */
import { store } from '../state/store';
import { audioEngine } from '../lib/audioEngine';
import { timingCapture } from '../lib/timing';
import { computePeaks } from '../lib/waveform';
import { flatSyllables } from '../lib/textParser';
import { Line, Project } from '../types';

const ROW_H = 18; // px per timeline row — height of one track's marker line
const RULER_H = 26; // px for the time ruler
const TOP_PAD = 4;
const TRACK_PAD = 6; // vertical gap between track rows
const WAVE_H = 44; // px for the waveform track (drawn between ruler and lyrics)
const HIT_W = 8; // horizontal hit zone half-width around the marker for dragging
const MARKER_W = 1; // marker is a 1px line (hit area is wider, see pickAt)

/** A hit on a specific track's syllable marker. */
type Drag = { trackIndex: number; lineIndex: number; sylIndex: number; moved: boolean };

export function createTimeline(): { root: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'timeline';

  const head = document.createElement('div');
  head.className = 'timeline-head';
  head.innerHTML =
    '<span>Таймлайн</span><span class="hint">— клик = перемотка, перетаскивайте маркеры, Shift+колесо = зум</span>';
  root.appendChild(head);

  // Body: fixed gutter (left) + scrollable canvas (right).
  const body = document.createElement('div');
  body.className = 'timeline-body';

  const gutter = document.createElement('div');
  gutter.className = 'timeline-gutter';
  body.appendChild(gutter);

  const scroll = document.createElement('div');
  scroll.className = 'timeline-scroll';
  const canvas = document.createElement('canvas');
  canvas.className = 'timeline-canvas';
  const ctx = canvas.getContext('2d')!;
  scroll.appendChild(canvas);
  body.appendChild(scroll);

  root.appendChild(body);

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
  let drag: Drag | null = null;

  /** Vertical offset where the track rows begin (after ruler + waveform + pad). */
  function tracksTop(): number {
    const showWave = store.getProject().showWaveform && !!audioEngine.audioBuffer;
    return RULER_H + TOP_PAD + (showWave ? WAVE_H + TOP_PAD : 0);
  }

  /** Y of the top of the given track's row. */
  function trackTopForIndex(i: number): number {
    return tracksTop() + i * (ROW_H + TRACK_PAD);
  }

  function pickAt(clientX: number, clientY: number): Drag | null {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const project = store.getProject();
    for (let ti = 0; ti < project.tracks.length; ti++) {
      const flat = flatSyllables(project.tracks[ti].lines);
      const top = trackTopForIndex(ti);
      if (y < top || y > top + ROW_H) continue;
      for (let i = 0; i < flat.length; i++) {
        const { lineIndex, sylIndex, syl } = flat[i];
        if (syl.startMs === null) continue;
        const mx = msToX(syl.startMs);
        if (x >= mx - HIT_W && x <= mx + HIT_W) {
          return { trackIndex: ti, lineIndex, sylIndex, moved: false };
        }
      }
    }
    return null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const hit = pickAt(e.clientX, e.clientY);
    if (hit) {
      drag = hit;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    // Click on empty canvas space → seek.
    const rect = canvas.getBoundingClientRect();
    const ms = xToMs(e.clientX - rect.left);
    audioEngine.seek(ms);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    let ms = xToMs(e.clientX - rect.left);
    // Clamp: can't drag past the previous or next timed syllable WITHIN THE SAME TRACK.
    const project = store.getProject();
    const track = project.tracks[drag.trackIndex];
    if (!track) return;
    const flat = flatSyllables(track.lines);
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
    const ti = drag.trackIndex;
    const li = drag.lineIndex;
    const si = drag.sylIndex;
    store.mutate((p) => {
      const syl = p.tracks[ti]?.lines[li]?.syllables[si];
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
  store.subscribe(() => {
    renderGutter();
    draw();
  });
  // Reflect recording state so we can preview the next syllable at the playhead.
  timingCapture.onState((isRecording, cursor) => {
    recording = isRecording;
    recordCursor = cursor;
    draw();
  });

  // --- Gutter (left headers) ---
  // Rebuilt only when the set of tracks, their names or the active id changes,
  // or the waveform visibility flips — NOT on every frame. Each header lines
  // up with its canvas row because they share the same layout constants.
  let lastGutterSig = '';
  function renderGutter(): void {
    const project = store.getProject();
    const showWave = project.showWaveform && !!audioEngine.audioBuffer;
    const sig =
      project.tracks.map((t) => `${t.id}:${t.name}`).join('|') +
      '@' +
      project.activeTrackId +
      (showWave ? '+w' : '');
    if (sig === lastGutterSig) return;
    lastGutterSig = sig;
    gutter.innerHTML = '';

    // Ruler alignment spacer (keeps the headers below the ruler line).
    const rulerSpacer = document.createElement('div');
    rulerSpacer.className = 'timeline-gutter-ruler';
    gutter.appendChild(rulerSpacer);

    // Waveform header ("минус"), same height as the waveform block on the canvas.
    if (showWave) {
      const waveHead = document.createElement('div');
      waveHead.className = 'timeline-wave-head';
      waveHead.textContent = 'минус';
      gutter.appendChild(waveHead);
    }

    // One header per track.
    for (const track of project.tracks) {
      const th = document.createElement('div');
      th.className = 'timeline-track-head' + (track.id === project.activeTrackId ? ' active' : '');
      th.title = 'Сделать эту дорожку активной';
      const name = document.createElement('span');
      name.className = 'timeline-track-name';
      name.textContent = track.name;
      th.appendChild(name);
      th.addEventListener('click', () => {
        if (track.id === store.getProject().activeTrackId) return;
        store.mutate((p) => (p.activeTrackId = track.id));
      });
      gutter.appendChild(th);
    }
  }

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
    // Height: ruler + waveform + one row per track.
    const cssH = RULER_H + TOP_PAD + waveBlock + project.tracks.length * (ROW_H + TRACK_PAD) + 4;
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

    // One row per track. IMPORTANT: only TIMED syllables are drawn. Untimed ones
    // are skipped — this is intentional (see buildTimings comment). Do not change.
    const activeId = project.activeTrackId;
    for (let ti = 0; ti < project.tracks.length; ti++) {
      const track = project.tracks[ti];
      const isActive = track.id === activeId;
      const rowY = trackTopForIndex(ti);

      // Active track subtle highlight band.
      if (isActive) {
        ctx.fillStyle = 'rgba(255,225,77,0.06)';
        ctx.fillRect(0, rowY - 2, cssW, ROW_H + 4);
      }

      const flat = flatSyllables(track.lines);
      for (let i = 0; i < flat.length; i++) {
        const { lineIndex, sylIndex, syl } = flat[i];
        if (syl.startMs === null) continue;

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
        const next = nextStartMs(track.lines, lineIndex, sylIndex);
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
    }

    // Playhead (the red bar that sweeps across the timeline).
    const px = msToX(playheadMs);
    ctx.fillStyle = '#ff5c6c';
    ctx.fillRect(px, 0, 2, cssH);

    // While recording, show the next syllable to be stamped just to the right of
    // the playhead, in the active track's row.
    if (recording) {
      const activeIdx = project.tracks.findIndex((t) => t.id === activeId);
      const flat = activeIdx >= 0 ? flatSyllables(project.tracks[activeIdx].lines) : [];
      const next = flat[recordCursor];
      if (next && next.syl.startMs === null) {
        const label = (next.syl.text.trim() || '•').slice(0, 14);
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

  function nextStartMs(lines: Line[], lineIndex: number, sylIndex: number): number | null {
    const flat = flatSyllables(lines);
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

  // initial build after layout
  renderGutter();
  requestAnimationFrame(draw);

  return { root };
}
