/**
 * Test that the style-panel slider keeps working while being dragged.
 *
 * Root cause of the original bug: the panel rebuilt its entire DOM on every
 * store change, so each `input` event during a drag destroyed the slider element
 * under the pointer and broke the drag. The fix keeps the DOM stable and only
 * updates `.value` in place. This test reproduces a drag as a sequence of `input`
 * events on the SAME element and asserts the element identity is preserved
 * across the store updates those events trigger.
 *
 * Uses jsdom to host the DOM, and exercises the REAL stylePanel + store modules
 * via a tiny esbuild entry that re-exports both.
 *
 * Run: node scripts/test-slider-drag.mjs
 */
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// --- jsdom setup so the bundled UI module can use document/window ---
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Some Node versions make `navigator` read-only; stylePanel doesn't need it.
try { globalThis.navigator = dom.window.navigator; } catch { /* ignore */ }
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.FileReader = dom.window.FileReader;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// --- Tiny entry that re-exports the modules under test, then bundle it ---
const entryFile = join(__dirname, '_slider-entry.ts');
writeFileSync(
  entryFile,
  `export { createStylePanel } from '${root.replace(/\\/g, '/')}/src/ui/stylePanel';\n` +
    `export { store } from '${root.replace(/\\/g, '/')}/src/state/store';\n`,
);
const outFile = join(__dirname, '_slider-bundle.mjs');
await build({
  entryPoints: [entryFile],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: outFile,
  logLevel: 'silent',
  external: ['mediabunny'],
});
const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());
const { createStylePanel, store } = mod;

// Build the panel into the document.
const container = document.createElement('div');
document.body.appendChild(container);
const panel = createStylePanel();
container.appendChild(panel.root);

let failures = 0;
const assert = (c, m) => { if (!c) { failures++; console.error('  ✗ FAIL:', m); } else console.log('  ✓', m); };

console.log('Style panel slider-drag tests\n');

const findSlider = (labelText) =>
  Array.from(container.querySelectorAll('input[type=range]')).find((s) => {
    const lbl = s.closest('label');
    return lbl && lbl.textContent.includes(labelText);
  });

const sizeSlider = findSlider('Размер');
assert(!!sizeSlider, 'fontSize slider exists');

const before = store.getProject().style.fontSize;
assert(before === 64, `initial fontSize is 64 (got ${before})`);

// Record the DOM node identity — the crux of the fix.
const originalNode = sizeSlider;

// Simulate a drag: several `input` events with increasing values on the SAME node.
const steps = [80, 100, 120, 140, 150];
for (const v of steps) {
  sizeSlider.value = String(v);
  sizeSlider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

const after = store.getProject().style.fontSize;
assert(after === 150, `fontSize reached 150 after the drag (got ${after})`);

// THE key assertion: the slider element is still the SAME node after all the
// store updates triggered during the drag. If the panel had rebuilt the DOM on
// each change, this would be a different node and a real browser drag would break.
const sizeSliderAfter = findSlider('Размер');
assert(sizeSliderAfter === originalNode, 'slider DOM node preserved across store updates (drag would not break)');

// Value label next to the slider reflects the latest value. It's the LAST span
// in the label (the first span holds the field name).
const spans = sizeSliderAfter.closest('label').querySelectorAll('span');
const valSpan = spans[spans.length - 1];
assert(valSpan.textContent === '150', `value label shows 150 (got "${valSpan.textContent}")`);

// Also confirm a DIFFERENT slider (e.g. "Обводка") still works and is preserved.
const strokeSlider = findSlider('Обводка');
assert(!!strokeSlider, 'stroke slider exists');
const strokeOrig = strokeSlider;
strokeSlider.value = '10';
strokeSlider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
assert(store.getProject().style.strokeWidth === 10, 'stroke slider writes through to store');
assert(findSlider('Обводка') === strokeOrig, 'stroke slider DOM node preserved');

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
unlinkSync(outFile);
unlinkSync(entryFile);
if (failures > 0) process.exit(1);
