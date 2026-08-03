/**
 * Export dialog (modal).
 *
 * Opens when the user clicks "Скачать MP4". Two states:
 *  1. Selection — the user picks a video quality (360p … 4K, default 480p) and
 *     either confirms (resolves the promise with the quality id) or cancels
 *     (rejects with ExportCanceledError). Closing via X / backdrop / Esc cancels.
 *  2. Rendering — once `setProgress` is first called, the dialog locks and shows
 *     a progress bar + "Отменить рендер". The owner calls `close()` on success,
 *     or `cancel()` (also rejecting) to abort.
 */
import { QUALITY_PRESETS, DEFAULT_QUALITY_ID, ExportCanceledError } from '../lib/export';

export interface ExportDialog {
  /** Resolves with the chosen quality id once the user confirms; rejects on cancel. */
  promise: Promise<string>;
  /** Switch to rendering state and set the progress bar (fraction 0..1). */
  setProgress: (fraction: number) => void;
  /** Close the dialog on success (does NOT reject the promise). */
  close: () => void;
  /** Abort: reject the promise (if pending) and close. */
  cancel: () => void;
}

export function openExportDialog(): ExportDialog {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  // Header
  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Скачать MP4';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Отмена';
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body: quality selector
  const body = document.createElement('div');
  body.className = 'modal-body';
  const field = document.createElement('label');
  field.className = 'field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Качество видео';
  field.appendChild(fieldLabel);
  const select = document.createElement('select');
  for (const q of QUALITY_PRESETS) {
    const opt = document.createElement('option');
    opt.value = q.id;
    opt.textContent = q.label;
    if (q.id === DEFAULT_QUALITY_ID) opt.selected = true;
    select.appendChild(opt);
  }
  field.appendChild(select);
  body.appendChild(field);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Чем выше качество — тем больше файл и дольше рендер.';
  body.appendChild(hint);

  // Progress area (hidden until rendering starts)
  const progressWrap = document.createElement('div');
  progressWrap.className = 'modal-progress';
  progressWrap.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  bar.appendChild(fill);
  const pct = document.createElement('div');
  pct.className = 'progress-pct';
  pct.textContent = '0%';
  progressWrap.appendChild(bar);
  progressWrap.appendChild(pct);
  body.appendChild(progressWrap);
  modal.appendChild(body);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Отмена';
  const startBtn = document.createElement('button');
  startBtn.className = 'primary';
  startBtn.textContent = 'Начать рендер';
  footer.appendChild(cancelBtn);
  footer.appendChild(startBtn);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  let resolveQuality: ((q: string) => void) | null = null;
  let rejectDialog: ((e: Error) => void) | null = null;
  const promise = new Promise<string>((resolve, reject) => {
    resolveQuality = resolve;
    rejectDialog = reject;
  });

  let closed = false;
  let rendering = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey);
    backdrop.remove();
  };

  const cancel = (): void => {
    if (closed) return;
    if (rejectDialog) rejectDialog(new ExportCanceledError('Экспорт отменён'));
    close();
  };

  const start = (): void => {
    if (rendering) return;
    rendering = true;
    // Lock into rendering state.
    select.disabled = true;
    startBtn.hidden = true;
    progressWrap.hidden = false;
    cancelBtn.textContent = 'Отменить рендер';
    title.textContent = 'Рендеринг MP4…';
    if (resolveQuality) resolveQuality(select.value);
  };

  const setProgress = (fraction: number): void => {
    if (!rendering) start(); // first progress tick flips into rendering state
    const f = Math.max(0, Math.min(1, fraction));
    fill.style.width = `${Math.round(f * 100)}%`;
    pct.textContent = `${Math.round(f * 100)}%`;
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  startBtn.addEventListener('click', start);
  cancelBtn.addEventListener('click', cancel);
  closeBtn.addEventListener('click', cancel);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) cancel();
  });
  window.addEventListener('keydown', onKey);

  return { promise, setProgress, close, cancel };
}
