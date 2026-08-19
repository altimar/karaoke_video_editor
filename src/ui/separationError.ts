/**
 * Shared failure reporting for separation runs (timeline ✨ and the wizard):
 * a human headline (known GPU patterns → actionable advice), the raw text
 * under a collapsible, and — when the light model isn't active yet — a button
 * that switches the setting in one click.
 */
import { humanizeSeparationError } from '../lib/separation';
import { getSettings, updateSettings } from '../lib/settings';
import type { SeparationDialog } from './separationDialog';
import type { ToastFn } from './controls';

export function reportSeparationError(dialog: SeparationDialog, err: unknown, toast: ToastFn): void {
  const raw = err instanceof Error ? err.message : String(err);
  const human = humanizeSeparationError(raw);
  const firstLine = raw.split('\n')[0].slice(0, 160);
  dialog.error(human ?? firstLine, {
    detail: raw,
    action:
      human && getSettings().karaokeModel !== 'fp16'
        ? {
            label: '⚙ Переключиться на облегчённую модель',
            onClick: () => {
              updateSettings({ karaokeModel: 'fp16' });
              toast('Включена облегчённая модель — запустите извлечение снова', 'ok');
            },
          }
        : undefined,
  });
}
