/**
 * Preview component.
 *
 * Owns the preview <canvas> (sized to the project's native resolution, scaled
 * down by CSS) and a RAF loop that calls renderFrame every animation frame with
 * the current playback time. When audio is paused, it still re-renders so style
 * edits are reflected live at the current playhead position.
 */
import { store } from '../state/store';
import { audioEngine } from '../lib/audioEngine';
import { renderFrame } from '../lib/render';
import { timingCapture } from '../lib/timing';

export function createPreview(): { wrap: HTMLElement; dispose: () => void } {
  const wrap = document.createElement('div');
  wrap.className = 'preview-wrap';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false })!;
  wrap.appendChild(canvas);

  const badge = document.createElement('div');
  badge.className = 'preview-badge';
  badge.textContent = 'Превью';
  wrap.appendChild(badge);

  let rafId = 0;

  function syncSize(): void {
    const p = store.getProject();
    // Only reallocate when dimensions actually change (avoids per-frame churn).
    if (canvas.width !== p.width || canvas.height !== p.height) {
      canvas.width = p.width;
      canvas.height = p.height;
    }
  }

  function loop(): void {
    const p = store.getProject();
    syncSize();
    // While recording, keep showing live time so the user sees fills land as they tap.
    const timeMs = audioEngine.isPlaying ? audioEngine.currentTimeMs : lastTimeMs;
    renderFrame(ctx, timeMs, p);
    rafId = requestAnimationFrame(loop);
  }

  // Track playhead even when paused (so seeking updates the static frame).
  let lastTimeMs = 0;
  audioEngine.onTime((t) => {
    lastTimeMs = t;
  });

  // Subscribe so that future logic can react to project edits; the RAF loop
  // already re-renders every frame so no manual invalidation is needed.
  store.subscribe(() => {
    /* live preview re-renders each RAF frame */
  });

  // Recording badge state.
  timingCapture.onState((recording) => {
    badge.classList.toggle('rec', recording);
    badge.textContent = recording ? 'Запись таймингов' : 'Превью';
  });

  // Kick off the loop.
  rafId = requestAnimationFrame(loop);

  return {
    wrap,
    dispose: () => cancelAnimationFrame(rafId),
  };
}
