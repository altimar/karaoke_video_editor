/**
 * One-off generator for the E2E background-video fixture: exports a 2-second
 * 360p MP4 through the app's OWN export pipeline (real WebCodecs encode) and
 * saves it as e2e/fixtures/bg-sample.mp4.
 *
 * Run: node e2e/make-bg-fixture.mjs   (dev server must be running on :5173)
 */
import { chromium } from '@playwright/test';
import { makeWavBytes } from './helpers.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'e2e', 'fixtures', 'bg-sample.mp4');

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/');

  // Load 2s of audio into the minus role (the export needs audio + duration).
  await page.locator('[data-testid="track-head-minus"]').click();
  await page.locator('[data-testid="input-audio-load"]').setInputFiles({
    name: 'song.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from(makeWavBytes(2)),
  });
  await page.waitForFunction(
    () => window.__audioEngine && window.__audioEngine.getBuffer('minus'),
    undefined,
    { timeout: 30_000 },
  );

  // Solid RED background — so the fixture's frames are distinguishable from
  // the app's default bg color (#0e0f1a) in pixel assertions.
  await page.evaluate(() => {
    window.__store.mutate((p) => {
      p.background.bgType = 'color';
      p.background.bgColor = '#ff0000';
    });
  });

  // Export a 360p MP4 (fast; visually irrelevant — the bg tests only decode it).
  await page.locator('[data-testid="btn-export"]').click();
  await page.locator('[data-testid="select-quality"]').selectOption('360p');
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator('[data-testid="btn-start-export"]').click();
  const download = await downloadPromise;
  await download.saveAs(outPath);
  console.log('saved:', outPath);
} finally {
  await browser.close();
}
