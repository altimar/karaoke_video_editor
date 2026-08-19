/**
 * Crash-recovery autosave: project changes are snapshotted to IndexedDB with
 * a debounce; after a reload a restore bar appears; restoring brings the
 * project back; dismissing deletes the snapshot.
 */
import { test, expect } from '@playwright/test';
import { makeProjectZip } from './helpers';

const SECONDS = 30;

/** startMs list of the first text track, via the store hook. */
function startMsOf(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const store = (window as unknown as { __store: any }).__store;
    const t = store.getProject().tracks.find((x: any) => x.type === 'text');
    return t.lines.flatMap((l: any) => l.syllables.map((s: any) => s.startMs));
  });
}

test('autosave: restore bar after reload; restore works; dismiss deletes', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('test-autosave-delay-ms', '250'));
  const { bytes } = makeProjectZip(SECONDS);
  await page.goto('/');
  await page.locator('[data-testid="input-open-project"]').setInputFiles({
    name: 'fixture.karaokeproject',
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
  // Let the debounced snapshot land (decode mutations re-arm the timer).
  await page.waitForTimeout(1000);

  // "Crash": reload — the restore bar must appear.
  await page.reload();
  const bar = page.locator('[data-testid="autosave-bar"]');
  await expect(bar).toBeVisible({ timeout: 10_000 });

  // Restore: the timings come back.
  await page.locator('[data-testid="autosave-restore"]').click();
  await expect.poll(async () => (await startMsOf(page)).join(',')).toBe('500,900');

  // The snapshot survives a restore (restored-but-unedited stays recoverable)
  // and dismissing deletes it for good.
  await page.reload();
  await expect(bar).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-testid="autosave-dismiss"]').click();
  // Let the IndexedDB delete transaction commit before tearing the page down.
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-testid="autosave-bar"]')).toHaveCount(0);
});
