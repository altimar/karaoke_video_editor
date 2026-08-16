/**
 * Font picker in the style panel: opens a list of AVAILABLE fonts (each
 * option typeset in its own font), picking one updates the track style and
 * the button label, the list closes.
 */
import { test, expect } from '@playwright/test';

test('font picker lists available fonts and sets the track style', async ({ page }) => {
  await page.goto('/');
  // Default font is exactly Arial (no fallback stack).
  const initial = await page.evaluate(() => {
    const p = window.__store.getProject();
    return p.tracks.find((t) => t.type === 'text')!.style.fontFamily;
  });
  expect(initial).toBe('Arial');

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

test('B / I toggles replace the weight select', async ({ page }) => {
  await page.goto('/');
  const getStyle = () =>
    page.evaluate(() => {
      const p = window.__store.getProject();
      return p.tracks.find((t) => t.type === 'text')!.style;
    });

  // The old weight dropdown is gone.
  await expect(page.getByText('Начертание')).toHaveCount(0);

  const b = page.getByTestId('btn-font-bold');
  const i = page.getByTestId('btn-font-italic');
  await expect(b).toBeVisible();
  await expect(i).toBeVisible();

  // Defaults: bold ON (700), italic OFF.
  await expect(b).toHaveClass(/active/);
  await expect(i).not.toHaveClass(/active/);
  expect((await getStyle()).fontWeight).toBe(700);
  expect((await getStyle()).italic).toBe(false);

  await b.click();
  expect((await getStyle()).fontWeight).toBe(400);
  await expect(b).not.toHaveClass(/active/);
  await b.click();
  expect((await getStyle()).fontWeight).toBe(700);
  await expect(b).toHaveClass(/active/);

  await i.click();
  expect((await getStyle()).italic).toBe(true);
  await expect(i).toHaveClass(/active/);
});

test('alignment is a one-line icon button group', async ({ page }) => {
  await page.goto('/');
  const getAlign = () =>
    page.evaluate(() => {
      const p = window.__store.getProject();
      return p.tracks.find((t) => t.type === 'text')!.style.textAlign;
    });

  // The old dropdown is gone; three icon buttons in one row with the label.
  await expect(page.getByText('Выравнивание')).toBeVisible();
  await expect(page.getByRole('option', { name: 'Слева' })).toHaveCount(0);
  const left = page.getByTestId('btn-align-left');
  const center = page.getByTestId('btn-align-center');
  const right = page.getByTestId('btn-align-right');
  await expect(left).toBeVisible();
  await expect(center).toBeVisible();
  await expect(right).toBeVisible();

  // Default is center; clicking switches the store and the active button.
  expect(await getAlign()).toBe('center');
  await expect(center).toHaveClass(/active/);
  await left.click();
  expect(await getAlign()).toBe('left');
  await expect(left).toHaveClass(/active/);
  await expect(center).not.toHaveClass(/active/);
  await right.click();
  expect(await getAlign()).toBe('right');
});
