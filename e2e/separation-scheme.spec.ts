/**
 * Separation scheme picker: the ✨ button first opens the pre-start chooser
 * (quality / fast / single), the choice persists across dialog openings, and
 * cancelling runs nothing. The heavy model run itself is NOT exercised here.
 */
import { test, expect } from '@playwright/test';
import { loadAudioIntoRole } from './support';
import { makeWavBytes } from './helpers';

test('scheme picker: options, selection, persistence, cancel', async ({ page }) => {
  await page.goto('/');
  await loadAudioIntoRole(page, 'original', makeWavBytes(2));
  await page
    .waitForFunction(() => window.__audioEngine && window.__audioEngine.getBuffer('original'))
    .catch(() => {});

  await page.locator('.timeline-track-extract').first().click();
  await expect(page.getByTestId('scheme-opt-quality')).toBeVisible();
  await expect(page.getByTestId('scheme-opt-fast')).toBeVisible();
  await expect(page.getByTestId('scheme-opt-single')).toBeVisible();
  // Default is quality.
  await expect(page.getByTestId('scheme-opt-quality')).toHaveClass(/selected/);

  // Pick 'fast', start → the progress dialog appears with the right title,
  // then close it via Escape is impossible (running) — instead cancel BEFORE
  // starting on a second open and verify persistence.
  await page.getByTestId('scheme-opt-fast').click();
  await expect(page.getByTestId('scheme-opt-fast')).toHaveClass(/selected/);
  await expect(page.getByTestId('scheme-opt-quality')).not.toHaveClass(/selected/);
  await page.getByTestId('btn-separate-cancel').click();
  await expect(page.getByTestId('scheme-opt-fast')).toHaveCount(0);

  // Re-open: the choice persisted.
  await page.locator('.timeline-track-extract').first().click();
  await expect(page.getByTestId('scheme-opt-fast')).toHaveClass(/selected/);
  await page.getByTestId('btn-separate-cancel').click();
});
