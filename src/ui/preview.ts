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
import { flatSyllables } from '../lib/textParser';
import { getActiveTextTrack } from '../types';

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

  // --- Tap-to-record overlay ---
  // While recording, the whole preview becomes a tap target: tapping anywhere
  // stamps the current playback time onto the next syllable (mobile path, since
  // there's no Spacebar). Shows the upcoming syllable large, so the user can
  // read ahead while tapping.
  const recOverlay = document.createElement('div');
  recOverlay.className = 'rec-overlay';
  const recHint = document.createElement('div');
  recHint.className = 'rec-overlay-hint';
  recHint.textContent = 'Тапайте на каждый слог';
  const recSyl = document.createElement('div');
  recSyl.className = 'rec-overlay-syl';
  recOverlay.appendChild(recHint);
  recOverlay.appendChild(recSyl);
  wrap.appendChild(recOverlay);

  // Tapping the overlay stamps the next syllable (same as Space on desktop).
  recOverlay.addEventListener('pointerdown', (e) => {
    if (!timingCapture.isRecording()) return;
    e.preventDefault();
    timingCapture.stampNow();
  });

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

  /** Update the tap-overlay's "next syllable" text from the active track. */
  function updateRecOverlaySyl(cursor: number): void {
    const t = getActiveTextTrack(store.getProject());
    if (!t) {
      recSyl.textContent = '';
      return;
    }
    const flat = flatSyllables(t.lines);
    recSyl.textContent = flat[cursor]?.syl.text ?? '✓';
  }

  // Recording badge + tap-overlay state.
  timingCapture.onState((recording, cursor) => {
    badge.classList.toggle('rec', recording);
    badge.textContent = recording ? 'Запись таймингов' : 'Превью';
    wrap.classList.toggle('rec', recording);
    if (recording) updateRecOverlaySyl(cursor);
  });

  // Kick off the loop.
  rafId = requestAnimationFrame(loop);

  return {
    wrap,
    dispose: () => cancelAnimationFrame(rafId),
  };
}
