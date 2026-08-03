/**
 * Tests for export quality presets + resolution/bitrate logic.
 * Run: node scripts/test-export-quality.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
// Output INSIDE the project so mediabunny resolves via node_modules.
const outFile = join(root, 'scripts', '_export-bundle.mjs');

// Stub the minimal WebCodecs surface so export.ts module loads in Node.
globalThis.VideoEncoder = class {};
globalThis.AudioEncoder = class {};
globalThis.VideoFrame = class {};

await build({
  entryPoints: [join(root, 'src/lib/export.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: outFile,
  logLevel: 'silent',
  external: ['mediabunny'],
});

const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());
const { QUALITY_PRESETS, DEFAULT_QUALITY_ID, getQualityPreset, ExportCanceledError } = mod;

let failures = 0;
const assert = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ FAIL:', msg); } else console.log('  ✓', msg); };

console.log('Export quality tests\n');

assert(QUALITY_PRESETS.length === 6, '6 presets (360p..4K)');
assert(QUALITY_PRESETS[0].height === 360, 'first preset is 360p');
assert(QUALITY_PRESETS[QUALITY_PRESETS.length - 1].height === 2160, 'last preset is 4K (2160p)');
assert(DEFAULT_QUALITY_ID === '480p', 'default quality is 480p');
assert(getQualityPreset(DEFAULT_QUALITY_ID).height === 480, 'default preset resolves to 480p height');

let prevB = 0, prevH = 0;
for (const q of QUALITY_PRESETS) {
  assert(q.bitrate > 0, `${q.id} bitrate positive (${(q.bitrate / 1e6).toFixed(0)} Mbps)`);
  if (prevH > 0) assert(q.bitrate > prevB, `${q.id} bitrate scales up with height`);
  prevB = q.bitrate; prevH = q.height;
}
assert(getQualityPreset('nope').id === '480p', 'unknown id falls back to 480p');
assert(getQualityPreset('1080p').bitrate > getQualityPreset('480p').bitrate * 2, '1080p bitrate >> 480p bitrate');
assert(new ExportCanceledError('x') instanceof Error, 'ExportCanceledError is an Error');

// Resolution math sanity: 16:9 at 480p -> 854 (snapped even).
// (We replicate the width calc from exportToMp4 to assert even-pixel snapping.)
function widthFor(h, aspect = 16 / 9) {
  let w = Math.round(h * aspect);
  if (w % 2 !== 0) w += 1;
  return w;
}
assert(widthFor(480) % 2 === 0, '480p width is even (' + widthFor(480) + ')');
assert(widthFor(360) % 2 === 0, '360p width is even (' + widthFor(360) + ')');

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);

// cleanup
const fs = await import('node:fs');
fs.unlinkSync(outFile);
if (failures > 0) process.exit(1);
