/**
 * Font picker in the style panel: opens a list of AVAILABLE fonts (each
 * option typeset in its own font), picking one updates the track style and
 * the button label, the list closes.
 */
import { test, expect } from '@playwright/test';

test('font picker lists available fonts and sets the track style', async ({ page }) => {
  await page.goto('/');
  const btn = page.getByTestId('font-picker');
  await expect(btn).toBeVisible();

  await btn.click();
  const list = page.getByTestId('font-list');
  await expect(list).toBeVisible();

  // Real font probing prunes the list, but generic families are always there.
  const count = await page.getByTestId('font-option').count();
  expect(count).toBeGreaterThan(5);

  // Every option renders its sample in its own font.
  const monospace = list.locator('[data-font="monospace"]');
  await expect(monospace).toBeVisible();
  await expect(monospace.locator('.font-sample')).toHaveCSS('font-family', 'monospace');

  await monospace.click();
  const fam = await page.evaluate(() => {
    const p = window.__store.getProject();
    return p.tracks.find((t) => t.type === 'text')!.style.fontFamily;
  });
  expect(fam).toBe('monospace');

  // List closed, button label follows and is typeset in the picked font.
  await expect(list).toBeHidden();
  await expect(btn).toContainText('monospace');
  const labelFf = await page.evaluate(
    () => getComputedStyle(document.querySelector('.font-picker-name')!).fontFamily,
  );
  expect(labelFf).toBe('monospace');

  // WYSIWYG: the preview canvas uses the same font string (applyFont).
  // (Indirect check: store value is what renderFrame reads.)
});
