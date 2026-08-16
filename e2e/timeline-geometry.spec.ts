/**
 * Timeline geometry — cross-MEDIUM pixel alignment.
 *
 * The gutter is HTML (cards with borders) and the rows are drawn on a canvas
 * (separators as pixels). Neither side can be checked against itself: the
 * header-card heights and the canvas row math share the same constants, so a
 * DOM-vs-math check is consistent with its own bug (this exact regression
 * shipped: card height was rowHeight + TRACK_PAD, so every card's bottom
 * border hung 6px below its row's separator, and every math-level check
 * stayed green). The only check that sees this class of bug compares the two
 * MEDIA against each other: each card's border-box bottom must coincide with
 * an actual separator PIXEL on the canvas, in one coordinate space.
 *
 * Separator color = #2a2e42 = var(--border) — deliberately the same color the
 * canvas rows and the card borders use; that identity is what makes the
 * gutter/canvas junction read as one continuous grid.
 */
import { test, expect } from '@playwright/test';

/** Scan the timeline in-page: card border boxes + canvas separator pixels. */
function readTimelineGeometry(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.timeline-canvas')!;
    const cs = getComputedStyle(canvas);
    const border = parseFloat(cs.borderTopWidth) || 0;
    const cRect = canvas.getBoundingClientRect();
    // Content-space origin: canvas box top + top border (canvas is content-box).
    const origin = cRect.top + border;
    const dpr = window.devicePixelRatio || 1;

    // Pixel scan: horizontal separator lines in one column, below the ruler
    // (rows start at y=30; scanning from there skips the ruler's vertical
    // ticks). Column x=60 is left of the centered "загрузите аудио" hints.
    const ctx = canvas.getContext('2d')!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const px = (x: number, yd: number) => {
      const i = (yd * canvas.width + x) * 4;
      return [img[i], img[i + 1], img[i + 2]] as const;
    };
    const col = Math.round(60 * dpr);
    const seps: number[] = [];
    let prev = false;
    for (let yd = Math.round(30 * dpr); yd < canvas.height; yd++) {
      const [r, g, b] = px(col, yd);
      const is = Math.abs(r - 42) < 8 && Math.abs(g - 46) < 8 && Math.abs(b - 66) < 8;
      if (is && !prev) seps.push(yd / dpr); // top edge of each 1px line, CSS px
      prev = is;
    }

    const cards = [...document.querySelectorAll('.timeline-gutter .timeline-track-head')].map(
      (h) => {
        const r = h.getBoundingClientRect();
        return {
          testid: h.dataset.testid ?? '',
          top: r.top - origin,
          bottom: r.bottom - origin,
          // pair-top: card whose bottom is MERGED with its vocal (no line there)
          pair: h.classList.contains('pair-top'),
        };
      },
    );

    const panel = document.querySelector('.timeline')!.getBoundingClientRect();
    const gutter = document.querySelector('.timeline-gutter')!.getBoundingClientRect();
    return {
      seps,
      cards,
      cssH: parseFloat(cs.height),
      canvasBoxBottomVsPanel: panel.bottom - cRect.bottom,
      gutterBottomVsCanvasBox: gutter.bottom - cRect.bottom,
    };
  });
}

test('header card borders coincide with canvas row separator pixels', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.timeline-canvas');
  const geo = await readTimelineGeometry(page);

  // Every card EXCEPT a pair-top (merged with its vocal): its bottom border
  // must be the same pixel row as the row's canvas separator (bottom - 1) —
  // the lines meet flush across the gutter/canvas junction. A pair-top's
  // bottom must have NO separator (the pair is one frame, no line inside).
  expect(geo.cards.length).toBeGreaterThanOrEqual(6);
  for (const card of geo.cards) {
    const sep = geo.seps.find((s) => Math.abs(s - (card.bottom - 1)) < 0.5);
    if (card.pair) {
      expect(
        sep,
        `${card.testid}: merged pair junction must have NO separator (found one at ${sep?.toFixed(1)})`,
      ).toBeUndefined();
    } else {
      expect(
        sep,
        `${card.testid}: card bottom ${card.bottom.toFixed(1)} must sit on a canvas separator (expected at ${(card.bottom - 1).toFixed(1)}, found [${geo.seps.map((s) => s.toFixed(1)).join(', ')}])`,
      ).toBeDefined();
    }
  }

  // The Фон card: bottom flush with the canvas content bottom — no dead space
  // below the last row (regression: trailing TRACK_PAD + 4px of empty canvas).
  const bg = geo.cards.find((c) => c.testid === 'track-head-background');
  expect(bg).toBeDefined();
  expect(Math.abs(geo.cssH - bg!.bottom)).toBeLessThan(0.5);

  // No stray separators: every drawn line belongs to a non-merged card bottom.
  const expectedSepCount = geo.cards.filter((c) => !c.pair).length;
  expect(geo.seps.length, `separators [${geo.seps.map((s) => s.toFixed(1)).join(', ')}]`).toBe(
    expectedSepCount,
  );

  // Cards stack CONTIGUOUSLY — no air between them (each card fills the gap
  // above its row; regression: exact-row-height cards left 6px gaps).
  const sorted = [...geo.cards].sort((a, b) => a.top - b.top);
  expect(Math.abs(sorted[0].top - 30)).toBeLessThan(0.5); // flush under the ruler spacer
  for (let i = 1; i < sorted.length; i++) {
    expect(
      Math.abs(sorted[i].top - sorted[i - 1].bottom),
      `${sorted[i].testid} must start exactly where ${sorted[i - 1].testid} ends`,
    ).toBeLessThan(0.5);
  }
});

test('timeline panel hugs its content — no stretched dead space (mobile)', async ({ page }) => {
  // Regression class: the mobile grid gave the timeline row `1fr`, so the
  // panel stretched to the window bottom and showed dead space under Фон
  // even with pixel-perfect rows. The canvas must end within the panel's own
  // padding + border of the panel's bottom edge, and the gutter must not be
  // stretched past the canvas.
  await page.setViewportSize({ width: 417, height: 646 });
  await page.goto('/');
  await page.waitForSelector('.timeline-canvas');
  const geo = await readTimelineGeometry(page);
  // panel padding-bottom (8 desktop / 6 mobile) + 1px canvas border, + slack.
  expect(geo.canvasBoxBottomVsPanel).toBeLessThan(10);
  expect(Math.abs(geo.gutterBottomVsCanvasBox)).toBeLessThan(1.5);
});
