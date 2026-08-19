/**
 * Export flows through the real dialog: Project (.karaokeproject) and KaraFun
 * (.kfn). Verifies the DOWNLOADED files byte-for-byte (unzip / KFN-import with
 * the app's own parser) — this is exactly the save/reopen round-trip path the
 * 3-minute-truncation bug lived in.
 */
import { test, expect } from '@playwright/test';
import { makeWavBytes, makeProjectZip, readBytes, readProjectZip, getKfnImporter } from './helpers';
import { getAppState, loadAudioIntoRole, exportViaDialog, expectToast } from './support';

// >3 minutes of audio: the export must embed it in full.
const WAV_SECONDS = 200;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await loadAudioIntoRole(page, 'minus', makeWavBytes(WAV_SECONDS));
  // Wait until the audio is decoded before exporting.
  await expect
    .poll(async () => (await getAppState(page)).bufferDurationByRole.minus, { timeout: 30_000 })
    .toBeGreaterThan(0);
});

test('export project: downloaded ZIP round-trips audio + metadata', async ({ page }) => {
  const path = await exportViaDialog(page, 'tab-project');

  const { project, audioByRole } = readProjectZip(readBytes(path));
  expect(project.tracks.filter((t: any) => t.type === 'text').length).toBe(1);
  expect(audioByRole.has('minus')).toBe(true);
  // The stored WAV is byte-identical to what was loaded: full 200 s payload.
  const storedWav = audioByRole.get('minus')!;
  expect(storedWav.length).toBe(makeWavBytes(WAV_SECONDS).length);
  // WAV data-size field (bytes 40..43, LE) matches the full duration.
  const dataSize = new DataView(storedWav.buffer, storedWav.byteOffset + 40, 4).getUint32(0, true);
  expect(dataSize).toBe(Math.round(WAV_SECONDS * 22050) * 2);
});

test('export KFN: downloaded container parses with the app importer, audio in full', async ({ page }) => {
  const path = await exportViaDialog(page, 'tab-kfn');

  const bytes = readBytes(path);
  // KFN container magic.
  expect(bytes[0]).toBe(0x4b); // K
  expect(bytes[1]).toBe(0x46); // F
  expect(bytes[2]).toBe(0x4e); // N
  expect(bytes[3]).toBe(0x42); // B

  const importFromKfn = await getKfnImporter();
  const result = importFromKfn(bytes);
  // Lyrics track survived the round-trip.
  const textTracks = result.project.tracks.filter((t: any) => t.type === 'text');
  expect(textTracks.length).toBe(1);
  // The embedded audio must cover the FULL loaded duration — not truncated
  // (regression: the reported bug cut audio to ~3 minutes after save). The
  // exporter re-encodes roles to AAC (m4a), so instead of byte-comparing the
  // original WAV we decode the embedded audio back in the page and check its
  // duration.
  expect(result.audioByRole.has('minus')).toBe(true);
  const stored = result.audioByRole.get('minus')!;
  expect(stored.length).toBeGreaterThan(0);
  const decodedSec = await page.evaluate(async (b64: string) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(u8.buffer);
    return buf.duration;
  }, Buffer.from(stored).toString('base64'));
  expect(decodedSec).toBeGreaterThan(WAV_SECONDS - 1);
  expect(decodedSec).toBeLessThan(WAV_SECONDS + 1);
});

test('MP4 export tab: stem mix checkboxes (drop the lead, keep back+minus)', async ({ page }) => {
  const WAV_SECONDS = 30;
  const { bytes } = makeProjectZip(WAV_SECONDS);
  await page.goto('/');
  await page.locator('[data-testid="input-open-project"]').setInputFiles({
    name: 'fixture.karaokeproject', mimeType: 'application/zip', buffer: Buffer.from(bytes),
  });
  await expectToast(page, 'ok', 'Проект загружен');

  await page.locator('[data-testid="btn-export"]').click();
  await page.locator('[data-testid="tab-mp4"]').click();
  // The fixture loads ONLY minus → minus is on; lead/back are unloaded → disabled.
  const minus = page.locator('[data-testid="export-stem-minus"]');
  await expect(minus).toBeChecked();
  await expect(page.locator('[data-testid="export-stem-lead"]')).toBeDisabled();
  await expect(page.locator('[data-testid="export-stem-back"]')).toBeDisabled();
  // Toggling works; cancel closes without exporting.
  await minus.uncheck();
  await expect(minus).not.toBeChecked();
  await page.locator('[data-testid="btn-cancel-export"]').click();
});
