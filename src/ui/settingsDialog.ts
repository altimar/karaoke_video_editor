/**
 * App settings modal (the ⚙ topbar button). Global, browser-persisted
 * settings (lib/settings.ts, localStorage) — they apply to ALL projects.
 *
 * Currently one setting: the phase-2 (lead/back) separation model variant
 * (fp32 original vs the fp16 "light" one). Changes apply to the NEXT
 * separation run (models are cached per variant).
 */
import { AppSettings, getSettings, updateSettings } from '../lib/settings';

export function openSettingsDialog(): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.dataset.testid = 'settings-dialog';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = '⚙ Настройки';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Закрыть';
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'modal-body';

  const label = document.createElement('div');
  label.className = 'progress-label';
  label.textContent = 'Модель разделения «лид/бэк» (вторая фаза ✨)';
  body.appendChild(label);

  // Two-option toggle (radio pair) for the karaoke model variant.
  const row = document.createElement('div');
  row.className = 'settings-option-row';
  const makeOption = (value: AppSettings['karaokeModel'], name: string, hint: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.className = 'settings-option';
    btn.dataset.testid = `setting-karaoke-${value}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'settings-option-name';
    titleEl.textContent = name;
    const hintEl = document.createElement('div');
    hintEl.className = 'settings-option-hint';
    hintEl.textContent = hint;
    btn.appendChild(titleEl);
    btn.appendChild(hintEl);
    btn.addEventListener('click', () => {
      updateSettings({ karaokeModel: value });
      sync();
    });
    return btn;
  };
  const fp32Btn = makeOption('fp32', 'Стандартная', 'Точный оригинал, ~876 МБ');
  const fp16Btn = makeOption('fp16', 'Облегчённая (fp16)', '~440 МБ — для слабых GPU, качество почти то же');
  row.appendChild(fp32Btn);
  row.appendChild(fp16Btn);
  body.appendChild(row);

  const note = document.createElement('div');
  note.className = 'hint';
  note.style.marginTop = '8px';
  note.textContent = 'Применяется при следующем извлечении (✨). Настройки общие для всех проектов и хранятся в браузере.';
  body.appendChild(note);

  modal.appendChild(body);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  function sync(): void {
    const v = getSettings().karaokeModel;
    fp32Btn.classList.toggle('active', v === 'fp32');
    fp16Btn.classList.toggle('active', v === 'fp16');
  }
  sync();

  const close = (): void => {
    window.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  window.addEventListener('keydown', onKey);
}
