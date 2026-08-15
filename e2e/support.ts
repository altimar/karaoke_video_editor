/**
 * Shared helpers for the E2E specs: waiting for toasts and reading the app's
 * project state via the window.__store / window.__audioEngine test hooks
 * (exposed in src/main.ts).
 */
import type { Page } from '@playwright/test';

/** Snapshot of the app state exposed through the test hooks. */
export interface AppState {
  durationMs: number;
  textTrackCount: number;
  activeTrackId: string;
  /** audioFileName per role ('' when the slot is empty) */
  fileNameByRole: Record<string, string>;
  /** engine: decoded buffer duration per role (seconds, -1 when not loaded) */
  bufferDurationByRole: Record<string, number>;
  engineDurationMs: number;
  /** background: type + video filename */
  bgType: string;
  bgVideoFileName: string | null;
}

export async function getAppState(page: Page): Promise<AppState> {
  return page.evaluate(() => {
    const store = (window as unknown as { __store: any }).__store;
    const engine = (window as unknown as { __audioEngine: any }).__audioEngine;
    const p = store.getProject();
    const fileNameByRole: Record<string, string> = {};
    const bufferDurationByRole: Record<string, number> = {};
    for (const t of p.tracks) {
      if (t.type !== 'audio') continue;
      fileNameByRole[t.role] = t.audioFileName;
      const buf = engine.getBuffer(t.role);
      bufferDurationByRole[t.role] = buf ? buf.duration : -1;
    }
    return {
      durationMs: p.durationMs,
      textTrackCount: p.tracks.filter((t: any) => t.type === 'text').length,
      activeTrackId: p.activeTrackId,
      fileNameByRole,
      bufferDurationByRole,
      engineDurationMs: engine.durationMs,
      bgType: p.background.bgType,
      bgVideoFileName: p.background.bgVideoFileName ?? null,
    };
  });
}

/** Wait for a toast with the given class ('ok' | 'err') and text. */
export async function expectToast(page: Page, kind: 'ok' | 'err' | 'info', text: string): Promise<void> {
  const cls = kind === 'info' ? '.toast' : `.toast.${kind}`;
  const { expect } = await import('@playwright/test');
  await expect(page.locator(cls, { hasText: text })).toBeVisible({ timeout: 10_000 });
}

/**
 * Assert that a locator is fully inside the viewport.
 *
 * Playwright's `toBeVisible()` only checks a non-empty bounding box — an
 * element clipped away by an `overflow: hidden` container still "passes", and
 * `click()` auto-scrolls to it, so a layout regression (e.g. the Фон row cut
 * off below the screen) would go unnoticed. This helper catches exactly that.
 */
export async function expectFullyInViewport(page: Page, selector: string): Promise<void> {
  const { expect } = await import('@playwright/test');
  await expect(async () => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`${selector}: no bounding box (not rendered)`);
    const vp = page.viewportSize()!;
    const overshoot = Math.max(0, box.y + box.height - vp.height);
    if (box.y < 0 || box.y + box.height > vp.height) {
      throw new Error(
        `${selector}: outside the viewport (y=${box.y.toFixed(0)}, bottom=${(box.y + box.height).toFixed(0)}, viewport=${vp.height}, overshoot=${overshoot.toFixed(0)}px)`,
      );
    }
  }).toPass({ timeout: 5_000 });
}

/**
 * Load a WAV buffer into an audio role through the real UI path: click the
 * track header (which arms the hidden input with the role) then set the file.
 */
export async function loadAudioIntoRole(
  page: Page,
  role: string,
  wav: Uint8Array,
  fileName = 'song.wav',
): Promise<void> {
  await page.locator(`[data-testid="track-head-${role}"]`).click();
  await page.locator('[data-testid="input-audio-load"]').setInputFiles({
    name: fileName,
    mimeType: 'audio/wav',
    buffer: Buffer.from(wav),
  });
}

/** Click through the export dialog for a given tab testid and wait for the download. */
export async function exportViaDialog(page: Page, tabTestId: string): Promise<string> {
  await page.locator('[data-testid="btn-export"]').click();
  await page.locator(`[data-testid="${tabTestId}"]`).click();
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 });
  await page.locator('[data-testid="btn-start-export"]').click();
  const download = await downloadPromise;
  return download.path() as Promise<string>;
}
