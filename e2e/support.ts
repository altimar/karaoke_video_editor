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
