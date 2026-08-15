/**
 * Smoke: the app boots — topbar buttons exist, timeline renders, and the
 * window.__store test hook is exposed with the default project (1 text track
 * + 4 audio role slots, zero duration).
 */
import { test, expect } from '@playwright/test';
import { getAppState, expectFullyInViewport } from './support';

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

  // Layout: every default track header — including the Фон pseudo-row at the
  // very bottom — must fit INSIDE the viewport. toBeVisible() alone doesn't
  // catch overflow-clipped rows (this exact regression shipped once: the Фон
  // row was cut off by .timeline's max-height and every click-based test
  // stayed green because click() auto-scrolls).
  await expectFullyInViewport(page, '[data-testid="track-head-minus"]');
  await expectFullyInViewport(page, '[data-testid="track-head-background"]');

  const state = await getAppState(page);
  expect(state.textTrackCount).toBe(1);
  expect(state.durationMs).toBe(0);
  expect(state.fileNameByRole.minus).toBe('');
});
