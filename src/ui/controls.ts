/**
 * Transport & top-level controls: audio load, play/pause, record timings,
 * export, save/load project (.karaokeproject). Most actions emit toasts so the
 * user gets clear feedback.
 */
import { store } from '../state/store';
import { audioEngine } from '../lib/audioEngine';
import { exportToMp4, downloadBlob, canExport, ExportCanceledError } from '../lib/export';
import { invalidateBgImageCache } from '../lib/render';
import { exportToKfn, collectKfnWarnings } from '../lib/kfnExport';
import { importFromKfn } from '../lib/kfnImport';
import { saveProject, loadProject } from '../lib/projectFile';
import { getAudioBytesMap, setAudioBytesMap } from '../lib/audioLoader';
import { loadBgVideo, clearBgVideo, getBgVideoBytes } from '../lib/backgroundVideo';
import { openExportDialog } from './exportDialog';
import { openMetadataDialog } from './metadataDialog';
import { openSettingsDialog } from './settingsDialog';
import { songBaseName } from '../lib/songTitle';
import { AudioRole, getAudioTrackByRole, isRoleAudible, ProjectMetadata } from '../types';

export type ToastFn = (msg: string, kind?: 'ok' | 'err' | 'info') => void;

export function createTopbar(toast: ToastFn, onNewProject?: () => void): { root: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'topbar';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'topbar-title';
  const logo = document.createElement('span');
  logo.className = 'topbar-logo';
  logo.textContent = '🎤';
  const titleText = document.createElement('span');
  titleText.className = 'topbar-text';
  titleText.textContent = 'Karaoke Video Editor';
  titleWrap.appendChild(logo);
  titleWrap.appendChild(titleText);
  root.appendChild(titleWrap);

  // Visual grouping: transport | project | output.
  root.appendChild(topbarSep());

  // --- Open (single button, auto-detect format by extension) ---
  // One file picker accepts both .karaokeproject and .kfn; the handler tells
  // them apart by extension and routes to the right importer.
  const openBtn = document.createElement('button');
  setTopbarButton(openBtn, '📂', 'Открыть');
  openBtn.title = 'Открыть проект (.karaokeproject) или KaraFun (.kfn)';
  openBtn.dataset.testid = 'btn-open';
  const openInput = document.createElement('input');
  openInput.type = 'file';
  openInput.accept = '.karaokeproject,.kfn';
  openInput.style.display = 'none';
  openInput.dataset.testid = 'input-open-project';
  openBtn.addEventListener('click', () => openInput.click());
  openInput.addEventListener('change', async () => {
    const f = openInput.files?.[0];
    if (!f) return;
    await openProjectFile(f);
    // Reset so picking the same file again re-fires change.
    openInput.value = '';
  });
  root.appendChild(openBtn);
  root.appendChild(openInput);

  /** Load a .karaokeproject or .kfn file, auto-detected by extension. */
  async function openProjectFile(f: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const isKfn = f.name.toLowerCase().endsWith('.kfn');
      if (isKfn) {
        const result = importFromKfn(bytes);
        for (const [role, data] of result.audioByRole) {
          await audioEngine.loadBytes(role, data, role);
        }
        setAudioBytesMap(result.audioByRole);
        // KFN never carries an MP4 background video (KaraFun uses WMV — we
        // don't import it), so reset any previously loaded one.
        clearBgVideo();
        store.mutate((p) => {
          p.tracks = result.project.tracks;
          p.activeTrackId = result.project.tracks[0].id;
          p.durationMs = audioEngine.durationMs;
          p.background = result.project.background;
          p.metadata = result.project.metadata;
        });
        invalidateBgImageCache();
        const n = result.project.tracks.filter((t) => t.type === 'text').length;
        toast(`KFN загружен (${n} ${pluralTracks(n)})`, 'ok');
      } else {
        const result = loadProject(bytes);
        for (const [role, data] of result.audioByRole) {
          await audioEngine.loadBytes(role, data, role);
        }
        setAudioBytesMap(result.audioByRole);
        if (result.bgVideoBytes) await loadBgVideo(result.bgVideoBytes);
        else clearBgVideo();
        store.setProject(result.project);
        invalidateBgImageCache();
        toast('Проект загружен', 'ok');
      }
    } catch (err) {
      console.error(err);
      toast('Не удалось открыть файл: ' + (err instanceof Error ? err.message : String(err)), 'err');
    }
  }

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  root.appendChild(spacer);

  // --- Song metadata (artist/title/… → export file name + KFN [General]) ---
  const metaBtn = document.createElement('button');
  setTopbarButton(metaBtn, '𝄞', 'Свойства');
  metaBtn.title = 'Свойства песни: группа, название, год…';
  metaBtn.dataset.testid = 'btn-metadata';
  metaBtn.addEventListener('click', () => {
    openMetadataDialog(store.getProject(), (m: ProjectMetadata) => {
      store.mutate((p) => (p.metadata = m));
      toast('Метаданные сохранены', 'ok');
    });
  });
  root.appendChild(metaBtn);

  // --- App settings (global, browser-persisted: separation model variant…) ---
  const settingsBtn = document.createElement('button');
  setTopbarButton(settingsBtn, '⚙', 'Настройки');
  settingsBtn.title = 'Настройки приложения (общие для всех проектов)';
  settingsBtn.dataset.testid = 'btn-settings';
  settingsBtn.addEventListener('click', () => openSettingsDialog());
  root.appendChild(settingsBtn);

  // --- New project (wizard: audio → lyrics → auto separation + align) ---
  if (onNewProject) {
    const newBtn = document.createElement('button');
    newBtn.className = 'primary';
    setTopbarButton(newBtn, '✨', 'Новый проект');
    newBtn.title = 'Мастер: аудио → лирика → готовое караоке';
    newBtn.dataset.testid = 'btn-new-project';
    newBtn.addEventListener('click', onNewProject);
    root.appendChild(newBtn);
  }

  // --- Export (single button → tabbed dialog: Video / Project / KaraFun) ---
  const exportBtn = document.createElement('button');
  exportBtn.className = 'primary';
  root.appendChild(topbarSep());
  setTopbarButton(exportBtn, '⬇', 'Экспорт');
  exportBtn.title = 'Экспорт: видео (MP4) / проект / KaraFun (.kfn)';
  exportBtn.dataset.testid = 'btn-export';
  exportBtn.addEventListener('click', () => onExport(exportBtn));
  root.appendChild(exportBtn);

  // --- Export flow: tabbed dialog (Video / Project / KaraFun) → build → download ---
  function onExport(btn: HTMLButtonElement): void {
    const project = store.getProject();
    const audioBytesMap = getAudioBytesMap();
    // Snapshot of the per-role audio bytes for the async export closure.
    const audioMap = new Map(audioBytesMap);
    if (project.durationMs <= 0) {
      store.mutate((p) => (p.durationMs = audioEngine.durationMs));
    }
    // Warn early if the browser can't do WebCodecs — the user can still pick
    // Project or KaraFun.
    if (!canExport()) {
      toast('Экспорт видео недоступен — нужен Chrome/Edge (WebCodecs). Доступны Проект и KaraFun.', 'err');
    }

    btn.disabled = true;
    // Preview KFN compatibility issues in the dialog's KaraFun tab.
    const kfnWarnings = collectKfnWarnings(project);
    const dialog = openExportDialog(kfnWarnings, project.fps);
    const abort = new AbortController();

    // If the user cancels via the dialog (X / backdrop / Cancel / Esc), abort.
    dialog.promise.catch(() => abort.abort());

    dialog.promise
      .then(async (choice) => {
        // Output filename: song metadata («Группа - Название») when filled,
        // else the loaded audio's name (minus → back → original).
        const srcName =
          getAudioTrackByRole(store.getProject(), 'minus')?.audioFileName ||
          getAudioTrackByRole(store.getProject(), 'back')?.audioFileName ||
          getAudioTrackByRole(store.getProject(), 'original')?.audioFileName ||
          'karaoke';
        const baseName = songBaseName(store.getProject(), srcName.replace(/\.[^.]+$/, ''));

        if (choice.format === 'project') {
          // Save the editable project file — no audio required.
          const { blob, filename } = saveProject(store.getProject(), getAudioBytesMap(), getBgVideoBytes());
          dialog.close();
          downloadBlob(blob, filename);
          toast('Проект сохранён', 'ok');
          return;
        }

        // mp4 & kfn both need audio (a render target).
        if (audioMap.size === 0) {
          throw new Error('Загрузите аудио (минус/бэк) перед экспортом');
        }

        if (choice.format === 'mp4') {
          if (!canExport()) {
            throw new Error('Экспорт видео недоступен — нужен Chrome/Edge (WebCodecs)');
          }
          // Apply the FPS chosen in the dialog (exportToMp4 reads project.fps).
          store.mutate((p) => (p.fps = choice.fps));
          // Gather decoded buffers per audible role (lead/minus/back) for the mix,
          // respecting mute/solo. 'original' is always excluded from the export.
          const proj = store.getProject();
          const bufByRole = new Map<AudioRole, AudioBuffer>();
          for (const role of ['lead', 'minus', 'back'] as AudioRole[]) {
            if (!isRoleAudible(proj, role)) continue;
            const buf = audioEngine.getBuffer(role);
            if (buf) bufByRole.set(role, buf);
          }
          const blob = await exportToMp4(
            store.getProject(),
            bufByRole,
            { qualityId: choice.qualityId, signal: abort.signal },
            (frac) => dialog.setProgress(frac),
          );
          dialog.close();
          downloadBlob(blob, baseName + '.mp4');
          toast('Готово! MP4 скачан', 'ok');
        } else {
          const result = await exportToKfn(store.getProject(), audioMap, {
            signal: abort.signal,
            onProgress: (frac) => dialog.setProgress(frac),
            bgVideoBytes: getBgVideoBytes(),
          });
          dialog.close();
          downloadBlob(result.blob, baseName + '.kfn');
          if (result.warnings.length > 0) {
            toast(result.warnings.join(' '), 'err');
          } else {
            toast('KFN скачан', 'ok');
          }
        }
      })
      .catch((err) => {
        dialog.cancel();
        abort.abort();
        if (err instanceof ExportCanceledError) {
          toast('Экспорт отменён', 'info');
        } else {
          console.error(err);
          toast('Ошибка экспорта: ' + (err?.message ?? err), 'err');
        }
      })
      .finally(() => {
        btn.disabled = false;
      });
  }

  return { root };
}

/**
 * Build a topbar button's content: icon (plain text) + a labeled span.
 * The label span is hidden on mobile (CSS `.topbar-btn-label`), so the button
 * collapses to just its icon there. The icon keeps a trailing space as a
 * separator on desktop; it collapses (trailing whitespace) when the label is
 * hidden, so the icon stays snug.
 */
/** Thin vertical separator between topbar button groups. */
function topbarSep(): HTMLElement {
  const sep = document.createElement('span');
  sep.className = 'topbar-sep';
  return sep;
}

function setTopbarButton(btn: HTMLButtonElement, icon: string, label: string): void {
  const lbl = document.createElement('span');
  lbl.className = 'topbar-btn-label';
  lbl.textContent = label;
  btn.replaceChildren(icon + ' ', lbl);
}

/** Russian pluralization for "дорожка": 1 → "дорожка", 2-4 → "дорожки", 5+ → "дорожек". */
function pluralTracks(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'дорожка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дорожки';
  return 'дорожек';
}
