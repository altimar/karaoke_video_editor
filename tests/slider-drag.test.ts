// @vitest-environment jsdom
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
 * Runs the REAL stylePanel + store modules in jsdom.
 */
import { test } from 'vitest';
import { createStylePanel } from '../src/ui/stylePanel';
import { store } from '../src/state/store';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

/** Read the active track's text style (fontSize/stroke live there now). */
function activeStyle(): any {
  const p = store.getProject() as any;
  return p.tracks.find((t: any) => t.id === p.activeTrackId) ?? p.tracks[0];
}

test('slider drag: DOM node preserved and value writes through to the store', () => {
  // Build the panel into the document.
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = createStylePanel();
  container.appendChild(panel.root);

  const findSlider = (labelText: string): HTMLInputElement | undefined =>
    Array.from(container.querySelectorAll<HTMLInputElement>('input[type=range]')).find((s) => {
      const lbl = s.closest('label');
      return lbl && lbl.textContent!.includes(labelText);
    });

  const sizeSlider = findSlider('Размер');
  assert(!!sizeSlider, 'fontSize slider exists');

  const before = (store.getProject() as any).tracks[0].style.fontSize;
  assert(before === 64, `initial fontSize is 64 (got ${before})`);

  // Record the DOM node identity — the crux of the fix.
  const originalNode = sizeSlider;

  // Simulate a drag: several `input` events with increasing values on the SAME node.
  const steps = [80, 100, 120, 140, 150];
  for (const v of steps) {
    sizeSlider!.value = String(v);
    sizeSlider!.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const after = activeStyle().style.fontSize;
  assert(after === 150, `fontSize reached 150 after the drag (got ${after})`);

  // THE key assertion: the slider element is still the SAME node after all the
  // store updates triggered during the drag. If the panel had rebuilt the DOM on
  // each change, this would be a different node and a real browser drag would break.
  const sizeSliderAfter = findSlider('Размер');
  assert(sizeSliderAfter === originalNode, 'slider DOM node preserved across store updates (drag would not break)');

  // Value label next to the slider reflects the latest value. It's the LAST span
  // in the label (the first span holds the field name).
  const spans = sizeSliderAfter!.closest('label')!.querySelectorAll('span');
  const valSpan = spans[spans.length - 1];
  assert(valSpan.textContent === '150', `value label shows 150 (got "${valSpan.textContent}")`);

  // Also confirm a DIFFERENT slider (e.g. "Обводка") still works and is preserved.
  const strokeSlider = findSlider('Обводка');
  assert(!!strokeSlider, 'stroke slider exists');
  const strokeOrig = strokeSlider;
  strokeSlider!.value = '10';
  strokeSlider!.dispatchEvent(new Event('input', { bubbles: true }));
  assert(activeStyle().style.strokeWidth === 10, 'stroke slider writes through to store');
  assert(findSlider('Обводка') === strokeOrig, 'stroke slider DOM node preserved');
});
