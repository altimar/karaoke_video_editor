/**
 * App settings (⚙ topbar button): global, browser-persisted. The karaoke
 * model variant must survive a page reload.
 */
import { test, expect } from '@playwright/test';

test('settings dialog switches the model variant and persists it', async ({ page }) => {
  // NOTE: no addInitScript wiping storage — it would re-run on page.reload()
  // and erase the very persistence this test checks. A fresh context starts
  // with empty localStorage anyway.
  await page.goto('/');

  await page.locator('[data-testid="btn-settings"]').click();
  const dialog = page.locator('[data-testid="settings-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-testid="setting-karaoke-fp32"]')).toHaveClass(/active/);

  await page.locator('[data-testid="setting-karaoke-fp16"]').click();
  await expect(page.locator('[data-testid="setting-karaoke-fp16"]')).toHaveClass(/active/);
  const stored = await page.evaluate(() => localStorage.getItem('app-settings'));
  expect(stored).toContain('"karaokeModel":"fp16"');

  // Survives a reload (global, not per-tab).
  await page.reload();
  await page.locator('[data-testid="btn-settings"]').click();
  await expect(page.locator('[data-testid="setting-karaoke-fp16"]')).toHaveClass(/active/);
});
