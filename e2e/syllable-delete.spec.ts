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
  const lane0Y = rowTop + 9;
  const xAt = (ms: number) => canvas!.x + (ms / (SECONDS * 1000)) * canvas!.width;

  // Clicking LEFT of the marker line (old fixed ±8px zone) must NOT grab the
  // syllable — it falls through to a seek.
  await page.mouse.click(xAt(900) - 10, lane1Y);
  let t = await page.evaluate(() => (window as unknown as { __audioEngine: any }).__audioEngine.currentTimeMs);
  expect(t).toBeGreaterThan(500);
  await page.keyboard.press('Delete');
  expect(await flatSyllablesOf(page)).toHaveLength(2); // nothing was selected

  // Click the second marker's LABEL (letters, right of the line), delete it.
  await page.mouse.click(xAt(900) + 10, lane1Y);
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await flatSyllablesOf(page)).length, { timeout: 5_000 })
    .toBe(1);
  const after = await flatSyllablesOf(page);
  expect(after[0].text).toBe('ла');
  expect(after[0].startMs).toBe(500); // the FIRST syllable kept its exact timing

  // Esc deselects: a following Delete must do nothing.
  await page.mouse.click(xAt(500) + 10, lane0Y);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  expect(await flatSyllablesOf(page)).toHaveLength(1); // still there

  // Dragging keeps the grab point: grab the LABEL (+14px) and move +200px —
  // the marker shifts by exactly the pointer delta, it does not snap its line
  // to the cursor (which would land grabPx further right).
  const syl = await flatSyllablesOf(page);
  expect(syl[0].startMs).toBe(500);
  const grabPx = 14;
  const deltaPx = 200;
  await page.mouse.move(xAt(500) + grabPx, lane0Y);
  await page.mouse.down();
  await page.mouse.move(xAt(500) + grabPx + deltaPx, lane0Y, { steps: 8 });
  await page.mouse.up();
  const msPerPx = (SECONDS * 1000) / canvas!.width;
  const dragged = (await flatSyllablesOf(page))[0];
  expect(Math.abs(dragged.startMs - (500 + deltaPx * msPerPx))).toBeLessThan(120);
  expect(dragged.startMs).toBeLessThan(500 + (deltaPx + grabPx / 2) * msPerPx); // no cursor-snap
});
