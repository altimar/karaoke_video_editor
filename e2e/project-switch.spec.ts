/**
 * Switching projects while playing: opening another project must STOP the
 * previous project's playback (no audio leaking) and unload roles the new
 * project doesn't provide.
 */
import { test, expect } from '@playwright/test';
import { makeProjectZip, makeWavBytes } from './helpers';
import { loadAudioIntoRole } from './support';

const engineState = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const engine = (window as unknown as { __audioEngine: any }).__audioEngine;
    const byRole: Record<string, number> = {};
    for (const role of ['original', 'lead', 'minus', 'back']) {
      const buf = engine.getBuffer(role);
      byRole[role] = buf ? buf.duration : -1;
    }
    return { playing: engine.isPlaying, byRole };
  });

test('opening a project stops the old playback and clears absent roles', async ({ page }) => {
  await page.goto('/');

  // Project A…
  const A_BYTES = makeProjectZip(30).bytes;
  await page.locator('[data-testid="input-open-project"]').setInputFiles({
    name: 'a.karaokeproject', mimeType: 'application/zip', buffer: Buffer.from(A_BYTES),
  });
  await expect(page.locator('.toast.ok', { hasText: 'Проект загружен' })).toBeVisible({ timeout: 10_000 });
  // …then session state to leak: audio in a role the NEXT project won't
  // have (loaded after A's open, so A's own cleanup doesn't drop it)…
  await loadAudioIntoRole(page, 'back', makeWavBytes(5));
  // …and playback running.
  await page.locator('[data-testid="btn-play"]').click();
  await expect.poll(async () => (await engineState(page)).playing, { timeout: 5_000 }).toBe(true);
  expect((await engineState(page)).byRole.back).toBeGreaterThan(0); // the leaking role is loaded

  // Switch to another project WHILE PLAYING.
  const B_BYTES = makeProjectZip(12).bytes;
  await page.locator('[data-testid="input-open-project"]').setInputFiles({
    name: 'b.karaokeproject', mimeType: 'application/zip', buffer: Buffer.from(B_BYTES),
  });
  await expect(page.locator('.toast.ok', { hasText: 'Проект загружен' })).toBeVisible({ timeout: 10_000 });

  // Wait for B to be fully in (its 12 s minus decoded) — the definitive
  // end-of-handler marker, THEN check the cleanup state.
  // A's minus is 30 s — poll for the DROP below 13 (only B's 12 s buffer
  // satisfies both bounds), the definitive end-of-handler marker.
  await expect
    .poll(async () => (await engineState(page)).byRole.minus, { timeout: 10_000 })
    .toBeLessThan(13);
  const after = await engineState(page);
  expect(after.playing).toBe(false); // old playback stopped
  expect(after.byRole.back).toBe(-1); // absent role unloaded
  expect(after.byRole.minus).toBeGreaterThan(11); // …and it's B's
});
