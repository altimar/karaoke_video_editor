/**
 * Driver for the buffer-limit probe (eval/karaoke-frames-entry.ts): loads the
 * app page, injects the probe, and runs the karaoke model on a real Kiri vocal
 * chunk at several window sizes — smallest first, so a failing size can't
 * poison the session for the rest. Usage: node eval/run-karaoke-frames-probe.mjs
 * (needs `npm run dev` on :5173 and public/local-models/karaoke-fp32.onnx).
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

execSync(
  'npx esbuild eval/karaoke-frames-entry.ts --bundle --format=iife --outfile=eval/_karaoke-frames-bundle.mjs',
  { stdio: 'inherit' },
);
const bundle = readFileSync('eval/_karaoke-frames-bundle.mjs', 'utf8');

const MODEL = 'http://localhost:5173/local-models/karaoke-fp32.onnx';
const VOCAL = 'eval/fixtures/kiri/vocal.mp3';
/** Smallest first: a failed CreateBuffer must not affect the sizes that fit. */
const FRAME_COUNTS = [747, 900, 1056, 1101];

const browser = await chromium.launch({
  headless: process.env.HEADLESS === '1',
  args: ['--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 400)));
  page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: bundle });

  const mp3 = readFileSync(VOCAL);
  console.log(`Probing ${FRAME_COUNTS} frames on ${VOCAL} @ 60s…`);
  const res = await page.evaluate(
    ([url, b64, start, frames]) =>
      (window).__framesProbe(url, b64, start, frames),
    [MODEL, mp3.toString('base64'), 60, FRAME_COUNTS],
  );

  console.log('\n=== adapter ===');
  console.log(JSON.stringify(res.adapter, null, 2));
  console.log(`production resolveFrames() would pick: T=${res.productionFrames}`);
  console.log('\n=== runs ===');
  for (const r of res.runs) {
    const size = (r.attentionBytes / 2 ** 30).toFixed(2);
    if (r.ok) {
      console.log(
        `T=${r.frames} (${size} GiB attention): ok, ${r.ms.toFixed(0)}ms, out=${JSON.stringify(r.outShape)}, maskRMS=${r.maskRms.toFixed(4)}, nans=${r.nans}`,
      );
    } else {
      console.log(`T=${r.frames} (${size} GiB attention): FAILED — ${r.error}`);
    }
  }
} finally {
  await browser.close();
}
