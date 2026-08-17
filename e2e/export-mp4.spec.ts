/**
 * MP4 export smoke (real WebCodecs in headless Chromium): a short project
 * exports to a non-empty .mp4. Skipped when WebCodecs is unavailable.
 */
import { test, expect } from '@playwright/test';
import { makeWavBytes, readBytes } from './helpers';
import { getAppState, loadAudioIntoRole, exportViaDialog } from './support';

test('export MP4: download is a non-empty mp4', async ({ page }) => {
  // CI runners have no real H.264 encoder — the export never produces a
  // download there. Covered locally (Playwright's Chromium with codecs).
  test.skip(!!process.env.CI, 'H.264 encode not viable on CI runners');
  await page.goto('/');

  const hasWebCodecs = await page.evaluate(
    () => typeof (window as any).VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined',
  );
  test.skip(!hasWebCodecs, 'WebCodecs unavailable in this browser');

  await loadAudioIntoRole(page, 'minus', makeWavBytes(2));
  await expect
    .poll(async () => (await getAppState(page)).bufferDurationByRole.minus, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // Pick the lowest quality so the render is fast.
  await page.locator('[data-testid="btn-export"]').click();
  await page.locator('[data-testid="select-quality"]').selectOption('360p');
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator('[data-testid="btn-start-export"]').click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const bytes = readBytes(await download.path());
  // A real mp4 has an ftyp box near the start and a healthy payload.
  expect(bytes.length).toBeGreaterThan(10_000);
});
