/**
 * Stem editing (timeline edit tool): a phrase wrongly living in one stem can
 * be dragged onto another audio track — the chunk is cut out of the source
 * role and mixed into the target role at the same time position.
 *
 * Fixtures: two 20 s WAVs with distinct tone bursts — lead has a phrase at
 * 1–2 s, back has phrases at 4–6 s and 9–10 s. The drag moves the back's first
 * phrase (4–6 s) into the lead, verified through the audio engine's decoded
 * buffers (RMS per range).
 */
import { test, expect } from '@playwright/test';
import { loadAudioIntoRole } from './support';

/** Mono 16-bit PCM WAV (44-byte header): 440 Hz tone at 0.4 amplitude inside
 *  the given [start,end) second ranges, digital silence elsewhere. */
function makeBurstWav(seconds: number, bursts: Array<[number, number]>, sampleRate = 22050): Uint8Array {
  const numFrames = Math.round(seconds * sampleRate);
  const dataSize = numFrames * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const wstr = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, dataSize, true);
  const loud = new Set<number>();
  for (const [s, e] of bursts) {
    for (let i = Math.round(s * sampleRate); i < Math.round(e * sampleRate); i++) loud.add(i);
  }
  for (let i = 0; i < numFrames; i++) {
    dv.setInt16(44 + i * 2, loud.has(i) ? Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 13100) : 0, true);
  }
  return new Uint8Array(buf);
}

/** RMS (0..1) of a role's decoded audio over [startS, endS), -1 if not loaded. */
function rmsInRange(page: import('@playwright/test').Page, role: string, startS: number, endS: number) {
  return page.evaluate(
    ({ role, startS, endS }) => {
      const engine = (window as unknown as { __audioEngine: any }).__audioEngine;
      const buf = engine.getBuffer(role);
      if (!buf) return -1;
      const data = buf.getChannelData(0);
      const from = Math.floor(startS * buf.sampleRate);
      const to = Math.min(data.length, Math.ceil(endS * buf.sampleRate));
      let acc = 0;
      let n = 0;
      for (let i = from; i < to; i++) {
        acc += data[i] * data[i];
        n++;
      }
      return Math.sqrt(acc / Math.max(1, n));
    },
    { role, startS, endS },
  );
}

test('edit tool: dragging a phrase chunk moves it between audio tracks', async ({ page }) => {
  const SECONDS = 20;
  await page.goto('/');
  // Load lead first, back last — the last header click makes BACK the active track.
  await loadAudioIntoRole(page, 'lead', makeBurstWav(SECONDS, [[1, 2]]), 'lead.wav');
  await loadAudioIntoRole(page, 'back', makeBurstWav(SECONDS, [[4, 6], [9, 10]]), 'back.wav');
  await expect
    .poll(async () => rmsInRange(page, 'back', 4, 6), { timeout: 30_000 })
    .toBeGreaterThan(0.1);

  // Switch the timeline to the edit tool.
  await page.locator('[data-testid="tl-tool-edit"]').click();

  // Drag the back phrase at 4–6 s (its center, 5 s) onto the lead row.
  const canvas = await page.locator('.timeline-canvas').boundingBox();
  const backHead = await page.locator('[data-testid="track-head-back"]').boundingBox();
  const leadHead = await page.locator('[data-testid="track-head-lead"]').boundingBox();
  expect(canvas && backHead && leadHead).toBeTruthy();
  const x = canvas!.x + (5 / SECONDS) * canvas!.width;
  const yBack = backHead!.y + backHead!.height / 2;
  const yLead = leadHead!.y + leadHead!.height / 2;

  // A chunk is grabbable ONLY by its rectangle: clicks at the chunk's x on the
  // ruler (and on silence gaps of the active row) must still SEEK.
  const timeMs = () => page.evaluate(() => (window as unknown as { __audioEngine: any }).__audioEngine.currentTimeMs);
  await page.mouse.click(x, canvas!.y + 13); // mid-ruler, chunk's x
  let t = await timeMs();
  expect(t).toBeGreaterThan(4500);
  expect(t).toBeLessThan(5500);
  await page.mouse.click(canvas!.x + (7.5 / SECONDS) * canvas!.width, yBack); // silence gap
  t = await timeMs();
  expect(t).toBeGreaterThan(7000);
  expect(t).toBeLessThan(8000);

  await page.mouse.move(x, yBack);
  await page.mouse.down();
  await page.mouse.move(x, yLead, { steps: 12 });
  await page.mouse.up();

  // The phrase is cut out of back (silence at 4–6 s, the 9–10 s phrase kept)
  // and mixed into lead at the same position (its own 1–2 s phrase intact).
  await expect
    .poll(async () => rmsInRange(page, 'back', 4, 6), { timeout: 30_000 })
    .toBeLessThan(0.005);
  expect(await rmsInRange(page, 'back', 9, 10)).toBeGreaterThan(0.1);
  await expect
    .poll(async () => rmsInRange(page, 'lead', 4, 6), { timeout: 30_000 })
    .toBeGreaterThan(0.1);
  expect(await rmsInRange(page, 'lead', 1, 2)).toBeGreaterThan(0.1);
});
