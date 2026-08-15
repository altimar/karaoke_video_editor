/**
 * Smoke: the app boots — topbar buttons exist, timeline renders, and the
 * window.__store test hook is exposed with the default project (1 text track
 * + 4 audio role slots, zero duration).
 */
import { test, expect } from '@playwright/test';
import { getAppState } from './support';

test('app boots with default project', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('[data-testid="btn-play"]')).toBeVisible();
  await expect(page.locator('[data-testid="btn-record"]')).toBeVisible();
  await expect(page.locator('[data-testid="btn-open"]')).toBeVisible();
  await expect(page.locator('[data-testid="btn-export"]')).toBeVisible();
  // Timeline gutter renders the default track headers (5 slots).
  await expect(page.locator('[data-testid="track-head-minus"]')).toBeVisible();
  await expect(page.locator('[data-testid="track-head-original"]')).toBeVisible();

  const state = await getAppState(page);
  expect(state.textTrackCount).toBe(1);
  expect(state.durationMs).toBe(0);
  expect(state.fileNameByRole.minus).toBe('');
});
