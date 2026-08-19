/**
 * Separation progress modal.
 *
 * Opens BEFORE the separation run starts and reports progress through two
 * phases: model download (first run only) and inference (per chunk). The
 * separation pipeline exposes NO cancellation, so this dialog is intentionally
 * non-dismissable while a run is in progress — the close button, backdrop click
 * and Escape are all ignored until the run resolves/rejects and the caller
 * invokes `close()`/`error()`.
 *
 * Lifecycle: caller opens the dialog, drives the run, and on completion calls
 * either `close()` (success) or `error()` (failure, which shows the message).
 */
export interface SeparationDialog {
  /** Show the model-download phase (first run only). fraction 0..1, or null if size unknown. */
  setDownload: (fraction: number | null) => void;
  /** Switch to the inference phase and set its progress bar (0..1). */
  setProgress: (fraction: number) => void;
  /** Update the human-readable status line under the title. */
  setStatus: (message: string) => void;
  /** Close the dialog on success. */
  close: () => void;
  /**
   * Show a failure: a human-readable headline, the raw technical text under a
   * collapsible «Подробности», and an optional action button (e.g. «switch to
   * the light model and retry»).
   */
  error: (message: string, opts?: { detail?: string; action?: { label: string; onClick: () => void } }) => void;
}

export function openSeparationDialog(titleText = 'Извлечение минуса'): SeparationDialog {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  // Header.
  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = titleText;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Закрыть';
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body: status line + progress bar.
  const body = document.createElement('div');
  body.className = 'modal-body';

  const status = document.createElement('div');
  status.className = 'separation-status';
  status.textContent = 'Подготовка…';
  body.appendChild(status);

  // Two bars: download (hidden until used) + inference.
  const downloadWrap = document.createElement('div');
  downloadWrap.className = 'modal-progress';
  downloadWrap.hidden = true;
  const downloadLabel = document.createElement('div');
  downloadLabel.className = 'progress-label';
  downloadLabel.textContent = 'Загрузка модели (до ~1 ГБ суммарно, только первый раз)';
  const downloadBar = document.createElement('div');
  downloadBar.className = 'bar';
  const downloadFill = document.createElement('div');
  downloadBar.appendChild(downloadFill);
  const downloadPct = document.createElement('div');
  downloadPct.className = 'progress-pct';
  downloadPct.textContent = '0%';
  downloadWrap.appendChild(downloadLabel);
  downloadWrap.appendChild(downloadBar);
  downloadWrap.appendChild(downloadPct);
  body.appendChild(downloadWrap);

  const progressWrap = document.createElement('div');
  progressWrap.className = 'modal-progress';
  progressWrap.hidden = true;
  const progressLabel = document.createElement('div');
  progressLabel.className = 'progress-label';
  progressLabel.textContent = 'Разделение';
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  bar.appendChild(fill);
  const pct = document.createElement('div');
  pct.className = 'progress-pct';
  pct.textContent = '0%';
  progressWrap.appendChild(progressLabel);
  progressWrap.appendChild(bar);
  progressWrap.appendChild(pct);
  body.appendChild(progressWrap);

  modal.appendChild(body);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  let closed = false;
  let done = false; // run resolved/rejected — controls whether close is allowed.

  const remove = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey);
    backdrop.remove();
  };

  // While a run is in progress, ignore attempts to dismiss (no real cancel).
  const tryClose = (): void => {
    if (done) remove();
  };
  closeBtn.addEventListener('click', tryClose);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) tryClose();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      tryClose();
    }
  };
  window.addEventListener('keydown', onKey);

  const setDownload = (fraction: number | null): void => {
    downloadWrap.hidden = false;
    if (fraction === null) {
      downloadFill.style.width = '100%';
      downloadPct.textContent = '…';
      return;
    }
    const f = Math.max(0, Math.min(1, fraction));
    downloadFill.style.width = `${Math.round(f * 100)}%`;
    downloadPct.textContent = `${Math.round(f * 100)}%`;
  };

  const setProgress = (fraction: number): void => {
    // Once inference starts, the download phase is done — collapse it.
    downloadWrap.hidden = true;
    progressWrap.hidden = false;
    const f = Math.max(0, Math.min(1, fraction));
    fill.style.width = `${Math.round(f * 100)}%`;
    pct.textContent = `${Math.round(f * 100)}%`;
  };

  const setStatus = (message: string): void => {
    status.textContent = message;
  };

  const close = (): void => {
    done = true;
    remove();
  };

  const error = (
    message: string,
    opts?: { detail?: string; action?: { label: string; onClick: () => void } },
  ): void => {
    done = true;
    status.textContent = 'Ошибка: ' + message;
    status.style.color = 'var(--danger)';
    downloadWrap.hidden = true;
    progressWrap.hidden = true;
    closeBtn.title = 'Закрыть';
    // The raw technical text, collapsed by default — enough for a bug report,
    // not in the way of the human explanation.
    if (opts?.detail && opts.detail !== message) {
      const details = document.createElement('details');
      details.className = 'error-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Подробности';
      const pre = document.createElement('pre');
      pre.textContent = opts.detail;
      details.appendChild(summary);
      details.appendChild(pre);
      body.appendChild(details);
    }
    if (opts?.action) {
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.style.marginTop = '10px';
      btn.textContent = opts.action.label;
      btn.addEventListener('click', () => {
        remove();
        opts.action!.onClick();
      });
      body.appendChild(btn);
    }
  };

  return { setDownload, setProgress, setStatus, close, error };
}
