/**
 * Load audio into a role through the timeline UI (header click arms the
 * hidden input with the role). Uses a WAV LONGER than 3 minutes — regression
 * for the reported bug where audio got cut to ~3 minutes after save/reopen.
 */
import { test, expect } from '@playwright/test';
import { makeWavBytes } from './helpers';
import { getAppState, loadAudioIntoRole } from './support';

test('minus role loads a >3min WAV at full duration', async ({ page }) => {
  const WAV_SECONDS = 200; // 3:20 — beyond the reported 3-minute cutoff
  const wav = makeWavBytes(WAV_SECONDS);
  await page.goto('/');

  await loadAudioIntoRole(page, 'minus', wav);

  // durationMs in the project is updated once decode finishes.
  await expect
    .poll(async () => (await getAppState(page)).durationMs, { timeout: 30_000 })
    .toBeGreaterThan((WAV_SECONDS - 1) * 1000);

  const state = await getAppState(page);
  expect(state.fileNameByRole.minus).toBe('song.wav');
  // The decoded buffer keeps the FULL duration (no truncation).
  expect(state.bufferDurationByRole.minus).toBeGreaterThan(WAV_SECONDS - 1);
  expect(state.bufferDurationByRole.minus).toBeLessThan(WAV_SECONDS + 1);
});
