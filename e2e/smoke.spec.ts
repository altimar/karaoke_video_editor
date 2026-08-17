/**
 * Smoke: the app boots — topbar buttons exist, timeline renders, and the
 * window.__store test hook is exposed with the default project (1 text track
 * + 4 audio role slots, zero duration).
 */
import { test, expect } from '@playwright/test';
import { getAppState, expectFullyInViewport, expectToast } from './support';

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

  // Gutter headers must sit exactly on their canvas rows: the first header's
  // top equals the canvas top + 1px border + ruler(26) + top pad(4). A uniform
  // offset here misaligns EVERY header (regression once: 5px drift).
  const firstHeadTop = await page.evaluate(() => {
    const c = document.querySelector('.timeline-canvas')!.getBoundingClientRect().top;
    const h = document.querySelector('[data-testid="track-head-original"]')!.getBoundingClientRect().top;
    return h - c;
  });
  expect(Math.abs(firstHeadTop - 31)).toBeLessThan(0.6);

  const state = await getAppState(page);
  expect(state.textTrackCount).toBe(1);
  expect(state.durationMs).toBe(0);
  expect(state.fileNameByRole.minus).toBe('');
});

test('auto-align: bound default track; empty vocal → error toast', async ({ page }) => {
  await page.goto('/');
  // The ⏱ button lives on every text-track header.
  const btn = page.locator('[data-testid="btn-auto-align"]').first();
  await expect(btn).toBeVisible();

  // The default track is bound to the (empty) lead vocal → refusal toast.
  await btn.click();
  await expectToast(page, 'err', 'пуста');
});

test('auto-align: unbound track → vocal picker; conflict → inline error', async ({ page }) => {
  await page.goto('/');
  // Add a SECOND text track — unbound by default.
  await page.locator('.timeline-add-track').click();
  // The unbound new track renders FIRST (bound pairs sit at their vocals).
  const btn = page.locator('[data-testid="btn-auto-align"]').first();
  await expect(btn).toBeVisible();

  // ⏱ on the unbound track opens the vocal picker with flat role buttons.
  await btn.click();
  await expect(page.getByTestId('bind-vocal-lead')).toBeVisible();
  await expect(page.getByTestId('bind-vocal-back')).toBeVisible();
  await expect(page.getByTestId('bind-vocal-original')).toBeVisible();

  // The default track is already bound to lead → the conflict rule fires
  // with an inline error, the dialog stays open.
  await page.getByTestId('bind-vocal-lead').click();
  await expect(page.locator('.bind-error')).toContainText('уже привязана');

  // Cancel closes the dialog without binding.
  await page.getByTestId('bind-vocal-cancel').click();
  await expect(page.getByTestId('bind-vocal-lead')).toHaveCount(0);
});

test('background settings live behind the Фон pseudo-row', async ({ page }) => {
  await page.goto('/');
  // By default the style panel shows the active track's cards; the bg card
  // (now the Фon "track settings") is hidden.
  await expect(page.getByText('Тип фона')).toBeHidden();
  await expect(page.getByText('Шрифт')).toBeVisible();

  // Clicking the Фон header selects it: bg card appears, track cards hide.
  await page.locator('[data-testid="track-head-background"]').click();
  await expect(page.getByText('Тип фона')).toBeVisible();
  await expect(page.getByText('Шрифт')).toBeHidden();
  await expect(page.getByTestId('btn-bg-load')).toBeVisible();
  await expect(page.locator('[data-testid="track-head-background"]')).toHaveClass(/active/);

  // Clicking a track header (even the already-active one) brings the track
  // panel back and clears the Фон selection highlight.
  await page.locator('[data-testid="track-head-text"]').click();
  await expect(page.getByText('Шрифт')).toBeVisible();
  await expect(page.getByText('Тип фона')).toBeHidden();
  await expect(page.locator('[data-testid="track-head-background"]')).not.toHaveClass(/active/);
});
