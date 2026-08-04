/**
 * Registry of all text renderers. To add a new animation mode: create a module
 * implementing `TextRenderer`, register it here, and add its id to the `Layout`
 * union in types.ts. The orchestrator and UI pick it up automatically.
 */
import { Layout } from '../../types';
import { TextRenderer, RenderSettingValue } from './types';
import { scrollerRenderer } from './scroller';
import { classicRenderer } from './classic';

export const TEXT_RENDERERS: Record<Layout, TextRenderer> = {
  scroller: scrollerRenderer,
  classic: classicRenderer,
};

/** List of renderers in display order (for the layout selector). */
export const RENDERER_LIST: TextRenderer[] = [scrollerRenderer, classicRenderer];

/** Look up a renderer by layout id (falls back to 'scroller'). */
export function getRenderer(layout: Layout): TextRenderer {
  return TEXT_RENDERERS[layout] ?? scrollerRenderer;
}

/**
 * Default settings for a renderer: each declared spec's `default`. Stored under
 * project.rendererSettings[renderer.id] and merged at render time.
 */
export function defaultSettingsFor(renderer: TextRenderer): Record<string, RenderSettingValue> {
  const out: Record<string, RenderSettingValue> = {};
  for (const s of renderer.settings) out[s.key] = s.default;
  return out;
}

/** Default settings for ALL renderers, keyed by renderer id. */
export function allDefaultSettings(): Record<string, Record<string, RenderSettingValue>> {
  const out: Record<string, Record<string, RenderSettingValue>> = {};
  for (const r of RENDERER_LIST) out[r.id] = defaultSettingsFor(r);
  return out;
}
