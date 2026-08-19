/**
 * Timeline syllable-marker interactions: selection (single + Shift+click
 * range), Del removing the TIMING (the text stays; the tail's timings pull
 * back — the "extra Space during recording" repair), arrows nudge, Tab walk,
 * block drag of a range, and the grab-point-preserving drag.
 *
 * Fixtures (makeProjectZip): active text track with timed syllables
 * 'ла'@500/900/1300 in one line (lanes 0/1/2 of the active 3-lane row).
 */
import { test, expect } from '@playwright/test';
import { makeProjectZip } from './helpers';

const SECONDS = 30;
const SYLS: Array<[string, number]> = [
  ['ла', 500],
  ['ла', 900],
  ['ла', 1300],
];

/** Flat [{text, startMs}] of the first text track, via the store hook. */
function flatSyllablesOf(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const store = (window as unknown as { __store: any }).__store;
    const t = store.getProject().tracks.find((x: any) => x.type === 'text');
    return t.lines.flatMap((l: any) => l.syllables.map((s: any) => ({ text: s.text, startMs: s.startMs })));
  });
}

/** Open a fresh page with the fixture project; returns click geometry. */
async function openFixture(page: import('@playwright/test').Page) {
  const { bytes } = makeProjectZip(SECONDS, SYLS);
  await page.goto('/');
  await page.locator('[data-testid="input-open-project"]').setInputFiles({
    name: 'fixture.karaokeproject',
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
  await page.waitForSelector('.timeline-canvas');
  await expect
    .poll(async () => (await flatSyllablesOf(page)).length, { timeout: 10_000 })
    .toBe(SYLS.length);
  const canvas = await page.locator('.timeline-canvas').boundingBox();
  const textHead = await page.locator('[data-testid="track-head-text"]').first().boundingBox();
  expect(canvas && textHead).toBeTruthy();
  const rowTop = textHead!.y + 6; // the card covers TRACK_PAD above its row
  const laneY = (lane: number) => rowTop + lane * 18 + 9; // ROW_H = 18
  const xAt = (ms: number) => canvas!.x + (ms / (SECONDS * 1000)) * canvas!.width;
  return { canvas: canvas!, laneY, xAt };
}

test('click a marker + Del removes the timing and pulls the tail back (text intact)', async ({ page }) => {
  const { laneY, xAt } = await openFixture(page);

  // Clicking LEFT of the marker line must NOT grab the syllable — it seeks.
  await page.mouse.click(xAt(900) - 10, laneY(1));
  const t = await page.evaluate(() => (window as unknown as { __audioEngine: any }).__audioEngine.currentTimeMs);
  expect(t).toBeGreaterThan(500);
  await page.keyboard.press('Delete');
  expect((await flatSyllablesOf(page)).map((s) => s.startMs)).toEqual([500, 900, 1300]); // nothing selected

  // Del on the 2nd marker: its timing disappears, the 3rd pulls back, the
  // last becomes untimed — the TEXT still has all three syllables.
  await page.mouse.click(xAt(900) + 10, laneY(1));
  await page.keyboard.press('Delete');
  const after = await flatSyllablesOf(page);
  expect(after.map((s) => s.text)).toEqual(['ла', 'ла', 'ла']); // text untouched
  expect(after.map((s) => s.startMs)).toEqual([500, 1300, null]); // tail pulled back

  // Esc deselects: a following Del must change nothing.
  await page.mouse.click(xAt(500) + 10, laneY(0));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  expect((await flatSyllablesOf(page)).map((s) => s.startMs)).toEqual([500, 1300, null]);
});

test('dragging keeps the grab point (no cursor-snap when grabbed by the letters)', async ({ page }) => {
  const { laneY, xAt } = await openFixture(page);
  // Drag the LAST syllable (no right neighbor — the clamp window is open).
  const grabPx = 14;
  const deltaPx = 200;
  await page.mouse.move(xAt(1300) + grabPx, laneY(2));
  await page.mouse.down();
  await page.mouse.move(xAt(1300) + grabPx + deltaPx, laneY(2), { steps: 8 });
  await page.mouse.up();
  const realMsPerPx = (SECONDS * 1000) / ((await page.locator('.timeline-canvas').boundingBox())!.width);
  const dragged = (await flatSyllablesOf(page))[2];
  expect(Math.abs(dragged.startMs - (1300 + deltaPx * realMsPerPx))).toBeLessThan(120);
  expect(dragged.startMs).toBeLessThan(1300 + (deltaPx + grabPx / 2) * realMsPerPx);
});

test('arrows nudge the selected syllable (±50 ms, Shift = ±10 ms)', async ({ page }) => {
  const { laneY, xAt } = await openFixture(page);
  await page.mouse.click(xAt(900) + 10, laneY(1)); // select the 2nd
  await page.keyboard.press('ArrowRight');
  expect(((await flatSyllablesOf(page))[1]).startMs).toBe(950);
  await page.keyboard.press('Shift+ArrowRight');
  expect(((await flatSyllablesOf(page))[1]).startMs).toBe(960);
  await page.keyboard.press('ArrowLeft');
  expect(((await flatSyllablesOf(page))[1]).startMs).toBe(910); // never crosses the 1st (500)
});

test('Tab walks to the next timed syllable; Del removes the walked-to timing', async ({ page }) => {
  const { laneY, xAt } = await openFixture(page);
  await page.mouse.click(xAt(500) + 10, laneY(0)); // select the 1st
  await page.keyboard.press('Tab'); // walk to the 2nd
  await page.keyboard.press('Delete');
  expect((await flatSyllablesOf(page)).map((s) => s.startMs)).toEqual([500, 1300, null]);
});

test('Shift+click selects a range; arrows and drag move the whole block', async ({ page }) => {
  const { canvas, laneY, xAt } = await openFixture(page);

  // Range over the LAST TWO syllables (right neighbor free for a block move).
  await page.mouse.click(xAt(900) + 10, laneY(1));
  await page.keyboard.down('Shift');
  await page.mouse.click(xAt(1300) + 10, laneY(2));
  await page.keyboard.up('Shift');

  await page.keyboard.press('ArrowRight');
  expect((await flatSyllablesOf(page)).map((s) => s.startMs)).toEqual([500, 950, 1350]);

  // Dragging either marker of the range shifts the block by the pointer delta.
  const msPerPx = (SECONDS * 1000) / canvas.width;
  const d = 150 * msPerPx;
  await page.mouse.move(xAt(1350) + 10, laneY(2));
  await page.mouse.down();
  await page.mouse.move(xAt(1350) + 160, laneY(2), { steps: 8 });
  await page.mouse.up();
  const syl = await flatSyllablesOf(page);
  expect(Math.abs(syl[2].startMs - (1350 + d))).toBeLessThan(120);
  expect(Math.abs(syl[1].startMs - (950 + d))).toBeLessThan(120); // moved TOGETHER
});
