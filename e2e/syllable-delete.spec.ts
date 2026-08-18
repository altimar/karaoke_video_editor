/**
 * Syllable deletion on the timeline: clicking a marker selects it (highlight),
 * Del removes the syllable TOGETHER with its timing — the neighboring
 * timings are not re-flowed. Esc just deselects.
 *
 * Fixture (makeProjectZip): active text track, one line, two timed syllables
 * 'ла'@500ms (lane 0) and 'ла'@900ms (lane 1 of the active 3-lane row).
 */
import { test, expect } from '@playwright/test';
import { makeProjectZip } from './helpers';

/** Flat [{text, startMs}] of the first text track, via the store hook. */
function flatSyllablesOf(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const store = (window as unknown as { __store: any }).__store;
    const t = store.getProject().tracks.find((x: any) => x.type === 'text');
    return t.lines.flatMap((l: any) => l.syllables.map((s: any) => ({ text: s.text, startMs: s.startMs })));
  });
}

test('click a marker + Del deletes that syllable without shifting the others', async ({ page }) => {
  const SECONDS = 30;
  const { bytes } = makeProjectZip(SECONDS);
  await page.goto('/');
  await page.locator('[data-testid="input-open-project"]').setInputFiles({
    name: 'fixture.karaokeproject',
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
  await page.waitForSelector('.timeline-canvas');
  await expect
    .poll(async () => (await flatSyllablesOf(page)).length, { timeout: 10_000 })
    .toBe(2);

  const canvas = await page.locator('.timeline-canvas').boundingBox();
  const textHead = await page.locator('[data-testid="track-head-text"]').first().boundingBox();
  expect(canvas && textHead).toBeTruthy();
  // The card spans [rowTop - TRACK_PAD, rowTop + rowH] → rowTop = cardTop + 6;
  // the 2nd timed syllable lives in lane 1 of the active 3-lane row.
  const rowTop = textHead!.y + 6;
  const lane1Y = rowTop + 18 + 9;
  const x900 = canvas!.x + (900 / (SECONDS * 1000)) * canvas!.width;

  // Click the second marker (selection), delete it.
  await page.mouse.click(x900, lane1Y);
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await flatSyllablesOf(page)).length, { timeout: 5_000 })
    .toBe(1);
  const after = await flatSyllablesOf(page);
  expect(after[0].text).toBe('ла');
  expect(after[0].startMs).toBe(500); // the FIRST syllable kept its exact timing

  // Esc deselects: a following Delete must do nothing.
  const x500 = canvas!.x + (500 / (SECONDS * 1000)) * canvas!.width;
  const lane0Y = rowTop + 9;
  await page.mouse.click(x500, lane0Y);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  expect(await flatSyllablesOf(page)).toHaveLength(1); // still there
});
