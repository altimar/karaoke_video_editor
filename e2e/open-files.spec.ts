/**
 * Opening files through the real UI path (hidden file input + extension
 * auto-detect): a real .kfn sample from the repo and a generated
 * .karaokeproject. Asserts on the project state via the store hook.
 */
import { test, expect } from '@playwright/test';
import { makeProjectZip, makeKfnBytes, sampleKfnPath } from './helpers';
import { expectToast, getAppState } from './support';

test('open .kfn: text tracks + audio land in the project', async ({ page }) => {
  // Prefer the repo's real sample (gitignored, local-only); fall back to a
  // container generated with the app's own exporter (CI).
  const sample = sampleKfnPath();
  const fixture = sample
    ? ({ filePath: sample } as const)
    : ({ name: 'fixture.kfn', mimeType: 'application/octet-stream', buffer: Buffer.from(await makeKfnBytes(30)) } as const);

  await page.goto('/');
  if ('filePath' in fixture) {
    await page.locator('[data-testid="input-open-project"]').setInputFiles(fixture.filePath);
  } else {
    await page.locator('[data-testid="input-open-project"]').setInputFiles(fixture);
  }
  await expectToast(page, 'ok', 'KFN загружен');

  const state = await getAppState(page);
  // The sample has lyrics in at least one text effect + embedded audio.
  expect(state.textTrackCount).toBeGreaterThanOrEqual(1);
  expect(state.durationMs).toBeGreaterThan(0);
  expect(state.engineDurationMs).toBeGreaterThan(0);
  // KFN's [General] Source becomes the minus role, with the original filename.
  expect(state.fileNameByRole.minus.length).toBeGreaterThan(0);
  // The embedded audio decoded fully (buffer present).
  expect(state.bufferDurationByRole.minus).toBeGreaterThan(0);
});

test('open .karaokeproject: tracks, audio and duration restored', async ({ page }) => {
  const WAV_SECONDS = 30;
  const { bytes } = makeProjectZip(WAV_SECONDS);
  await page.goto('/');

  await page.locator('[data-testid="input-open-project"]').setInputFiles({
    name: 'fixture.karaokeproject',
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
  await expectToast(page, 'ok', 'Проект загружен');

  const state = await getAppState(page);
  expect(state.textTrackCount).toBe(1);
  expect(state.fileNameByRole.minus).toBe('song.wav');
  // Duration comes from the embedded audio, not the JSON — the engine decoded
  // the full WAV (~30 s, allow 1 s slack for WAV frame accounting).
  expect(state.bufferDurationByRole.minus).toBeGreaterThan(WAV_SECONDS - 1);
  expect(state.durationMs).toBeGreaterThan((WAV_SECONDS - 1) * 1000);
});
