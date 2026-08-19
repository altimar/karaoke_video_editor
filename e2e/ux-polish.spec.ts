/**
 * UX polish: timeline scrubbing drives the preview frame (marker drag / arrow
 * nudge / Tab walk set the scrub time), and the zoom "fit" affordances (⤢
 * button + clickable 100% label) reset the view to the whole song.
 */
import { test, expect } from '@playwright/test';
import { makeProjectZip } from './helpers';

const SECONDS = 30;
const SYLS: Array<[string, number]> = [
  ['ла', 500],
  ['ла', 900],
  ['ла', 1300],
];

test('dragging/nudging a syllable scrubs the preview time', async ({ page }) => {
  const { bytes } = makeProjectZip(SECONDS, SYLS);
  await page.goto('/');
  await page.locator('[data-testid="input-open-project"]').setInputFiles({
    name: 'fixture.karaokeproject',
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
  await page.waitForSelector('.timeline-canvas');
  const syllables = () =>
    page.evaluate(() => {
      const store = (window as unknown as { __store: any }).__store;
      const t = store.getProject().tracks.find((x: any) => x.type === 'text');
      return t.lines.flatMap((l: any) => l.syllables.map((s: any) => s.startMs));
    });
  await expect.poll(async () => (await syllables()).length, { timeout: 10_000 }).toBe(SYLS.length);

  const canvas = await page.locator('.timeline-canvas').boundingBox();
  const textHead = await page.locator('[data-testid="track-head-text"]').first().boundingBox();
  expect(canvas && textHead).toBeTruthy();
  const rowTop = textHead!.y + 6;
  const lane1Y = rowTop + 18 + 9;
  const xAt = (ms: number) => canvas!.x + (ms / (SECONDS * 1000)) * canvas!.width;
  const scrub = () => page.evaluate(() => (window as unknown as { __scrub: () => number | null }).__scrub());

  // Arrow nudge: select the 2nd syllable (900) → +50 ms → scrub follows.
  await page.mouse.click(xAt(900) + 10, lane1Y);
  await page.keyboard.press('ArrowRight');
  expect(await scrub()).toBe(950);

  // Tab to the 3rd syllable (1300) → scrub lands on it.
  await page.keyboard.press('Tab');
  expect(await scrub()).toBe(1300);

  // Marker drag by +100px → scrub follows the dragged position.
  const msPerPx = (SECONDS * 1000) / canvas!.width;
  await page.mouse.move(xAt(1300) + 10, rowTop + 2 * 18 + 9);
  await page.mouse.down();
  await page.mouse.move(xAt(1300) + 110, rowTop + 2 * 18 + 9, { steps: 6 });
  await page.mouse.up();
  const scrubNow = (await scrub()) as number;
  expect(Math.abs(scrubNow - (1300 + 100 * msPerPx))).toBeLessThan(120);

  // Scrub auto-expires (~1.5 s after the last interaction) — pause wins.
  await page.waitForTimeout(2200);
  expect(await scrub()).toBeNull();
});

test('zoom fit: ⤢ button and the clickable label reset to 100% (whole song)', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.timeline-canvas');
  const label = page.locator('.tl-zoom-label');

  // Zoom in with Shift+wheel, expect the label to leave 100%.
  const canvas = await page.locator('.timeline-canvas').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 2);
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Shift');
  await expect(label).not.toHaveText('100%');

  // ⤢ resets to the whole-song view.
  await page.locator('[data-testid="tl-zoom-fit"]').click();
  await expect(label).toHaveText('100%');

  // Zoom in again — clicking the LABEL also fits.
  await page.keyboard.down('Shift');
  await page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 2);
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Shift');
  await expect(label).not.toHaveText('100%');
  await label.click();
  await expect(label).toHaveText('100%');
});

test('selecting a marker parks the lyrics textarea caret at that syllable', async ({ page }) => {
  const { bytes } = makeProjectZip(SECONDS, [['ла', 500], ['ла', 900]]);
  await page.goto('/');
  await page.locator('[data-testid="input-open-project"]').setInputFiles({
    name: 'fixture.karaokeproject',
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
  await page.waitForSelector('.timeline-canvas');
  const waitLoaded = (n: number) =>
    expect
      .poll(
        () =>
          page.evaluate(() => {
            const store = (window as unknown as { __store: any }).__store;
            const t = store.getProject().tracks.find((x: any) => x.type === 'text');
            return t.lines.flatMap((l: any) => l.syllables.map((s: any) => s.startMs));
          }),
        { timeout: 10_000 },
      )
      .toHaveLength(n);
  await waitLoaded(2);

  const canvas = await page.locator('.timeline-canvas').boundingBox();
  const textHead = await page.locator('[data-testid="track-head-text"]').first().boundingBox();
  const rowTop = textHead!.y + 6;
  const xAt = (ms: number) => canvas!.x + (ms / (SECONDS * 1000)) * canvas!.width;

  const caret = () =>
    page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea.lyrics')!;
      return { start: ta.selectionStart, end: ta.selectionEnd, scrollTop: ta.scrollTop };
    });

  // Serialized text: "ла ла" — the 2nd syllable is SELECTED at [3, 5).
  await page.mouse.click(xAt(900) + 10, rowTop + 18 + 9);
  const sel = await caret();
  expect(sel.start).toBe(3);
  expect(sel.end).toBe(5);
  // And the VISIBLE highlight layer draws a box for it (no focus needed).
  const boxes = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="lyrics-highlight"]')!;
    return [...layer.children].map((d) => (d as HTMLElement).getBoundingClientRect().width);
  });
  expect(boxes.length).toBeGreaterThanOrEqual(1);
  expect(boxes[0]).toBeGreaterThan(4); // a real box, not a sliver

  // A long multi-line lyric: clicking a marker far down scrolls the textarea.
  await page.evaluate(() => {
    const store = (window as unknown as { __store: any }).__store;
    const p = store.getProject();
    const t = p.tracks.find((x: any) => x.type === 'text');
    t.lines = Array.from({ length: 40 }, (_, i) => ({
      syllables: [{ text: `строка${i}`, startMs: 300 + i * 700, sep: '' }],
    }));
    store.setProject(p);
  });
  await waitLoaded(40);
  await page.mouse.click(xAt(20000) + 6, rowTop + 9);
  const c = await caret();
  expect(c.start).toBeGreaterThan(60); // a far-down line
  expect(c.scrollTop).toBeGreaterThan(40); // the textarea scrolled there
});

test('player transport: speed buttons change the engine rate', async ({ page }) => {
  await page.goto('/');
  // The transport lives under the preview now (moved from the topbar).
  await expect(page.locator('.player-transport [data-testid="btn-play"]')).toBeVisible();
  await expect(page.locator('.player-transport [data-testid="btn-record"]')).toBeVisible();

  const rate = () => page.evaluate(() => (window as unknown as { __audioEngine: any }).__audioEngine.playbackRate);
  expect(await rate()).toBe(1);
  await page.locator('[data-testid="btn-speed-05"]').click();
  expect(await rate()).toBe(0.5);
  await page.locator('[data-testid="btn-speed-075"]').click();
  expect(await rate()).toBe(0.75);
  await page.locator('[data-testid="btn-speed-1"]').click();
  expect(await rate()).toBe(1);
});
