/**
 * Export dialog (modal) with format tabs.
 *
 * A single "Export" entry point: the user picks a format tab — **Video** (MP4)
 * or **KaraFun** (.kfn) — reviews that tab's options/warnings, then clicks
 * "Экспорт". The promise resolves with the chosen format (+ quality id for MP4);
 * the owner runs the export, reporting progress via `setProgress`. Closing via
 * X / backdrop / Esc / "Отмена" rejects with ExportCanceledError.
 *
 * Two states:
 *  1. Selection — tabs + per-format options (MP4 quality selector, KFN warnings).
 *  2. Rendering — once `setProgress` is first called, the dialog locks into a
 *     progress bar + "Отменить". The owner calls `close()` on success.
 */
import { QUALITY_PRESETS, DEFAULT_QUALITY_ID } from '../lib/export';
import { ExportCanceledError } from '../lib/exportErrors';

export interface ExportChoice {
  format: 'mp4' | 'project' | 'kfn';
  /** MP4 quality preset id (only meaningful when format is 'mp4'). */
  qualityId: string;
  /** MP4 frame rate (only meaningful when format is 'mp4'). */
  fps: number;
}

export interface ExportDialog {
  /** Resolves with the chosen format + quality once the user confirms; rejects on cancel. */
  promise: Promise<ExportChoice>;
  /** Switch to rendering state and set the progress bar (fraction 0..1). */
  setProgress: (fraction: number) => void;
  /** Close the dialog on success (does NOT reject the promise). */
  close: () => void;
  /** Abort: reject the promise (if pending) and close. */
  cancel: () => void;
}

/**
 * Open the export dialog. `kfnWarnings` are shown in the KaraFun tab so the user
 * sees compatibility issues (too many tracks, clamped stroke, …) before export.
 * `initialFps` preselects the FPS dropdown in the Video tab.
 */
export function openExportDialog(kfnWarnings: string[], initialFps: number): ExportDialog {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  // Header
  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Экспорт';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Отмена';
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // --- Format tabs ---
  const tabBar = document.createElement('div');
  tabBar.className = 'export-tabs';
  const mp4Tab = document.createElement('button');
  mp4Tab.className = 'export-tab active';
  mp4Tab.textContent = 'Видео (MP4)';
  mp4Tab.dataset.testid = 'tab-mp4';
  const projectTab = document.createElement('button');
  projectTab.className = 'export-tab';
  projectTab.textContent = 'Проект (.karaokeproject)';
  projectTab.dataset.testid = 'tab-project';
  const kfnTab = document.createElement('button');
  kfnTab.className = 'export-tab';
  kfnTab.textContent = 'KaraFun (.kfn)';
  kfnTab.dataset.testid = 'tab-kfn';
  tabBar.appendChild(mp4Tab);
  tabBar.appendChild(projectTab);
  tabBar.appendChild(kfnTab);
  modal.appendChild(tabBar);

  // --- Tab bodies ---
  const body = document.createElement('div');
  body.className = 'modal-body';

  // MP4 body: quality selector.
  const mp4Body = document.createElement('div');
  const field = document.createElement('label');
  field.className = 'field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Качество видео';
  field.appendChild(fieldLabel);
  const qualitySelect = document.createElement('select');
  qualitySelect.dataset.testid = 'select-quality';
  for (const q of QUALITY_PRESETS) {
    const opt = document.createElement('option');
    opt.value = q.id;
    opt.textContent = q.label;
    if (q.id === DEFAULT_QUALITY_ID) opt.selected = true;
    qualitySelect.appendChild(opt);
  }
  field.appendChild(qualitySelect);
  mp4Body.appendChild(field);

  // FPS selector.
  const fpsField = document.createElement('label');
  fpsField.className = 'field';
  const fpsLabel = document.createElement('span');
  fpsLabel.textContent = 'Кадры в секунду';
  fpsField.appendChild(fpsLabel);
  const fpsSelect = document.createElement('select');
  const FPS_OPTIONS = [24, 30, 60];
  for (const v of FPS_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = String(v);
    if (v === initialFps) opt.selected = true;
    fpsSelect.appendChild(opt);
  }
  // If the project's fps isn't one of the standard values, add it as an extra
  // option so the current value is still represented rather than silently lost.
  if (!FPS_OPTIONS.includes(initialFps)) {
    const opt = document.createElement('option');
    opt.value = String(initialFps);
    opt.textContent = String(initialFps);
    opt.selected = true;
    fpsSelect.appendChild(opt);
  }
  fpsField.appendChild(fpsSelect);
  mp4Body.appendChild(fpsField);

  const mp4Hint = document.createElement('div');
  mp4Hint.className = 'hint';
  mp4Hint.textContent = 'Чем выше качество — тем больше файл и дольше рендер.';
  mp4Body.appendChild(mp4Hint);
  body.appendChild(mp4Body);

  // Project body: save the editable project file (no rendering options).
  const projectBody = document.createElement('div');
  projectBody.hidden = true;
  const projectHint = document.createElement('div');
  projectHint.className = 'hint';
  projectHint.textContent =
    'Сохраняет проект, аудио и фон в файл .karaokeproject для последующего открытия в редакторе.';
  projectBody.appendChild(projectHint);
  body.appendChild(projectBody);

  // KFN body: warnings (if any) + format hint.
  const kfnBody = document.createElement('div');
  kfnBody.hidden = true;
  if (kfnWarnings.length > 0) {
    const warnBox = document.createElement('div');
    warnBox.className = 'export-warnings';
    const warnTitle = document.createElement('div');
    warnTitle.className = 'export-warnings-title';
    warnTitle.textContent = 'Предупреждения:';
    warnBox.appendChild(warnTitle);
    for (const w of kfnWarnings) {
      const item = document.createElement('div');
      item.className = 'export-warning';
      item.textContent = '⚠ ' + w;
      warnBox.appendChild(item);
    }
    kfnBody.appendChild(warnBox);
  } else {
    const okNote = document.createElement('div');
    okNote.className = 'hint';
    okNote.textContent = 'Все настройки проекта совместимы с KaraFun.';
    kfnBody.appendChild(okNote);
  }
  const kfnHint = document.createElement('div');
  kfnHint.className = 'hint';
  kfnHint.style.marginTop = '8px';
  kfnHint.textContent = 'Файл .kfn для KaraFun Player/Studio. Текст, тайминги, стили и фон сохраняются.';
  kfnBody.appendChild(kfnHint);
  body.appendChild(kfnBody);

  // Progress area (hidden until rendering starts).
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
  cancelBtn.dataset.testid = 'btn-cancel-export';
  const startBtn = document.createElement('button');
  startBtn.className = 'primary';
  startBtn.textContent = 'Экспорт';
  startBtn.dataset.testid = 'btn-start-export';
  footer.appendChild(cancelBtn);
  footer.appendChild(startBtn);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  let resolveChoice: ((c: ExportChoice) => void) | null = null;
  let rejectDialog: ((e: Error) => void) | null = null;
  const promise = new Promise<ExportChoice>((resolve, reject) => {
    resolveChoice = resolve;
    rejectDialog = reject;
  });

  let closed = false;
  let rendering = false;
  let format: 'mp4' | 'project' | 'kfn' = 'mp4';

  const switchTab = (which: 'mp4' | 'project' | 'kfn'): void => {
    if (rendering) return;
    format = which;
    mp4Tab.classList.toggle('active', which === 'mp4');
    projectTab.classList.toggle('active', which === 'project');
    kfnTab.classList.toggle('active', which === 'kfn');
    mp4Body.hidden = which !== 'mp4';
    projectBody.hidden = which !== 'project';
    kfnBody.hidden = which !== 'kfn';
  };

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
    mp4Tab.disabled = true;
    projectTab.disabled = true;
    kfnTab.disabled = true;
    qualitySelect.disabled = true;
    fpsSelect.disabled = true;
    tabBar.style.opacity = '0.5';
    mp4Body.hidden = true;
    projectBody.hidden = true;
    kfnBody.hidden = true;
    startBtn.hidden = true;
    progressWrap.hidden = false;
    cancelBtn.textContent = 'Отменить';
    title.textContent =
      format === 'mp4' ? 'Рендеринг видео…' : format === 'kfn' ? 'Сборка KaraFun…' : 'Сохранение проекта…';
    if (resolveChoice) resolveChoice({ format, qualityId: qualitySelect.value, fps: parseInt(fpsSelect.value, 10) });
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

  mp4Tab.addEventListener('click', () => switchTab('mp4'));
  projectTab.addEventListener('click', () => switchTab('project'));
  kfnTab.addEventListener('click', () => switchTab('kfn'));
  startBtn.addEventListener('click', start);
  cancelBtn.addEventListener('click', cancel);
  closeBtn.addEventListener('click', cancel);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) cancel();
  });
  window.addEventListener('keydown', onKey);

  return { promise, setProgress, close, cancel };
}
