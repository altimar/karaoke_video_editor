/**
 * Timeline scrubbing → live preview frame.
 *
 * While the user drags a syllable marker, nudges it with arrows or walks with
 * Tab, the preview canvas shows the frame AT THAT MOMENT (not the playhead) —
 * instant "what the viewer will see on this syllable" feedback. The scrub
 * time auto-expires shortly after the last interaction, and is ignored while
 * audio is playing (playback always wins).
 *
 * Timeline writes (setScrubTime), the preview reads (getScrubTime) — no
 * imports between the UI modules.
 */

let scrubMs: number | null = null;
let expiryTimer: number | null = null;

/** Show the frame at `ms` in the preview; auto-clears `ttlMs` after the last call. */
export function setScrubTime(ms: number, ttlMs = 1500): void {
  scrubMs = Math.max(0, ms);
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = window.setTimeout(() => {
    scrubMs = null;
    expiryTimer = null;
  }, ttlMs);
}

/** Drop the scrub immediately (e.g. playback started). */
export function clearScrub(): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  scrubMs = null;
}

/** The scrub time, or null when idle — the preview falls back to the playhead. */
export function getScrubTime(): number | null {
  return scrubMs;
}
