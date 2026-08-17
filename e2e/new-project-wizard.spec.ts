/**
 * New-project wizard: two steps, file picking, lyrics, and the finish phase.
 * The heavy model phases (separation, auto-align) are skipped via the
 * localStorage test seam — their downloads are too large for CI.
 */
import { test, expect } from '@playwright/test';
import { makeWavBytes } from './helpers';
import { getAppState } from './support';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('test-skip-models', '1'));
});

test('wizard: original + stems + lyrics builds a fresh karaoke project', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('btn-new-project').click();

  // Step 1: no audio → Далее disabled.
  const next = page.getByTestId('btn-wizard-next');
  await expect(next).toBeVisible();
  await expect(next).toBeDisabled();

  // Load the original AND a lead stem (user stems may coexist with original).
  await page.getByTestId('input-wizard-original').setInputFiles({
    name: 'song.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from(makeWavBytes(3)),
  });
  await page.getByTestId('input-wizard-lead').setInputFiles({
    name: 'lead.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from(makeWavBytes(2)),
  });
  await expect(page.locator('.wizard-file-status.loaded').first()).toContainText('song.mp3');
  await expect(next).toBeEnabled();
  await next.click();

  // Step 2: lyrics textarea; finish disabled until text present.
  const ta = page.getByTestId('wizard-lyrics');
  await expect(ta).toBeVisible();
  const finish = page.getByTestId('btn-wizard-finish');
  await expect(finish).toBeDisabled();
  await ta.fill('ла ла ла\nлу лу лу');
  await expect(finish).toBeEnabled();
  await finish.click();

  // Wizard closed; the project is rebuilt with audio in the right roles.
  await expect(page.getByTestId('wizard-lyrics')).toHaveCount(0);
  await expect
    .poll(async () => (await getAppState(page)).bufferDurationByRole.original, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const state = await getAppState(page);
  expect(state.bufferDurationByRole.lead).toBeGreaterThan(0);

  // The text track carries the syllabified lyrics (no timings yet — align skipped).
  const t = await page.evaluate(() => {
    const p = window.__store.getProject();
    const tt = p.tracks.find((x) => x.type === 'text')!;
    return {
      lines: tt.lines.length,
      syllables: tt.lines.reduce((n, l) => n + l.syllables.length, 0),
      allUntimed: tt.lines.every((l) => l.syllables.every((s) => s.startMs === null)),
    };
  });
  expect(t.lines).toBeGreaterThan(0);
  expect(t.syllables).toBeGreaterThan(0);
  expect(t.allUntimed).toBe(true);
});

test('wizard: cancel does nothing to the current project', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('btn-new-project').click();
  await page.getByTestId('btn-wizard-cancel').click();
  await expect(page.getByTestId('wizard-lyrics')).toHaveCount(0);
});
