/**
 * Transport & top-level controls: audio load, play/pause, record timings,
 * export, save/load project (.karaokeproject). Most actions emit toasts so the
 * user gets clear feedback.
 */
import { store } from '../state/store';
import { audioEngine } from '../lib/audioEngine';
import { timingCapture } from '../lib/timing';
import { exportToMp4, downloadBlob, canExport, ExportCanceledError } from '../lib/export';
import { invalidateBgImageCache } from '../lib/render';
import { exportToKfn, collectKfnWarnings } from '../lib/kfnExport';
import { importFromKfn } from '../lib/kfnImport';
import { saveProject, loadProject } from '../lib/projectFile';
import { getAudioBytesMap, setAudioBytesMap } from '../lib/audioLoader';
import { openExportDialog } from './exportDialog';
import { AudioRole, getAudioTrackByRole } from '../types';

export type ToastFn = (msg: string, kind?: 'ok' | 'err' | 'info') => void;

export function createTopbar(toast: ToastFn): {
  root: HTMLElement;
  refreshAudioState: () => void;
} {
  const root = document.createElement('div');
  root.className = 'topbar';

  const title = document.createElement('h1');
  title.textContent = '🎤 Karaoke Video Editor';
  root.appendChild(title);

  // --- Play / pause ---
  const playBtn = document.createElement('button');
  playBtn.textContent = '▶ Пуск';
  playBtn.addEventListener('click', () => audioEngine.toggle());
  root.appendChild(playBtn);

  // --- Record timings ---
  const recBtn = document.createElement('button');
  recBtn.className = 'primary';
  recBtn.textContent = '● Запись таймингов';
  recBtn.title = 'Включите воспроизведение и нажимайте Пробел на каждый слог';
  recBtn.addEventListener('click', () => {
    if (timingCapture.isRecording()) {
      timingCapture.stop();
    } else if (!audioEngine.has('original') && !audioEngine.has('minus') && !audioEngine.has('back')) {
      toast('Сначала загрузите аудио', 'err');
    } else {
      // start from beginning if no timings yet
      timingCapture.start();
      toast('Запись! Нажимайте Пробел на каждый слог', 'info');
    }
    refreshAll();
  });
  root.appendChild(recBtn);

  // --- Save / load project (.karaokeproject — a ZIP container) ---
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 Сохранить проект';
  saveBtn.addEventListener('click', () => {
    try {
      const { blob, filename } = saveProject(store.getProject(), getAudioBytesMap());
      downloadBlob(blob, filename);
      toast('Проект сохранён', 'ok');
    } catch (err) {
      console.error(err);
      toast('Ошибка сохранения: ' + (err instanceof Error ? err.message : String(err)), 'err');
    }
  });
  root.appendChild(saveBtn);

  const loadBtn = document.createElement('button');
  loadBtn.textContent = '📂 Открыть проект';
  const projInput = document.createElement('input');
  projInput.type = 'file';
  projInput.accept = '.karaokeproject';
  projInput.style.display = 'none';
  loadBtn.addEventListener('click', () => projInput.click());
  projInput.addEventListener('change', async () => {
    const f = projInput.files?.[0];
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const result = loadProject(bytes);
      // Load each role's audio into the engine + register bytes for export.
      for (const [role, data] of result.audioByRole) {
        await audioEngine.loadBytes(role, data, role);
      }
      setAudioBytesMap(result.audioByRole);
      store.setProject(result.project);
      invalidateBgImageCache();
      toast('Проект загружен', 'ok');
      refreshAll();
    } catch (err) {
      console.error(err);
      toast('Не удалось прочитать проект: ' + (err instanceof Error ? err.message : String(err)), 'err');
    }
  });
  root.appendChild(loadBtn);
  root.appendChild(projInput);

  // --- Load KFN ---
  const kfnLoadBtn = document.createElement('button');
  kfnLoadBtn.textContent = '📂 Открыть KFN';
  kfnLoadBtn.title = 'Импорт караоке из файла KaraFun (.kfn)';
  const kfnInput = document.createElement('input');
  kfnInput.type = 'file';
  kfnInput.accept = '.kfn';
  kfnInput.style.display = 'none';
  kfnLoadBtn.addEventListener('click', () => kfnInput.click());
  kfnInput.addEventListener('change', async () => {
    const f = kfnInput.files?.[0];
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const result = importFromKfn(bytes);
      // Load each role's audio into the engine + register bytes for export.
      for (const [role, data] of result.audioByRole) {
        await audioEngine.loadBytes(role, data, role);
      }
      setAudioBytesMap(result.audioByRole);
      // Replace the project's tracks + background.
      store.mutate((p) => {
        p.tracks = result.project.tracks;
        p.activeTrackId = result.project.tracks[0].id;
        p.durationMs = audioEngine.durationMs;
        p.background = result.project.background;
      });
      invalidateBgImageCache();
      const n = result.project.tracks.filter((t) => t.type === 'text').length;
      toast(`KFN загружен (${n} ${pluralTracks(n)})`, 'ok');
      refreshAll();
    } catch (err) {
      console.error(err);
      toast('Ошибка импорта KFN: ' + (err instanceof Error ? err.message : String(err)), 'err');
    }
  });
  root.appendChild(kfnLoadBtn);
  root.appendChild(kfnInput);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  root.appendChild(spacer);

  // --- Export (single button → tabbed dialog: Video / KaraFun) ---
  const exportBtn = document.createElement('button');
  exportBtn.className = 'primary';
  exportBtn.textContent = '⬇ Экспорт';
  exportBtn.addEventListener('click', () => onExport(exportBtn));
  root.appendChild(exportBtn);

  function refreshAll(): void {
    playBtn.textContent = audioEngine.isPlaying ? '⏸ Пауза' : '▶ Пуск';
    recBtn.textContent = timingCapture.isRecording() ? '⏹ Стоп записи' : '● Запись таймингов';
    recBtn.classList.toggle('danger', timingCapture.isRecording());
  }

  function refreshAudioState(): void {
    refreshAll();
  }

  audioEngine.onAudioState(refreshAll);
  timingCapture.onState(refreshAll);

  // Global keyboard: Space toggles play/pause when NOT recording.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if (timingCapture.isRecording()) return; // timing capture owns Space
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    audioEngine.toggle();
  });

  // --- Export flow: tabbed dialog (Video / KaraFun) → render/build → download ---
  function onExport(btn: HTMLButtonElement): void {
    const project = store.getProject();
    const audioBytesMap = getAudioBytesMap();
    const hasExportAudio = audioBytesMap.size > 0;
    if (!hasExportAudio) {
      toast('Загрузите аудио (минус/бэк) перед экспортом', 'err');
      return;
    }
    // Snapshot of the per-role audio bytes for the async export closure.
    const audioMap = new Map(audioBytesMap);
    if (project.durationMs <= 0) {
      store.mutate((p) => (p.durationMs = audioEngine.durationMs));
    }
    // Warn early if the browser can't do WebCodecs — the user can still pick KFN.
    if (!canExport()) {
      toast('Экспорт видео недоступен — нужен Chrome/Edge (WebCodecs). Доступен только KaraFun.', 'err');
    }

    btn.disabled = true;
    // Preview KFN compatibility issues in the dialog's KaraFun tab.
    const kfnWarnings = collectKfnWarnings(project);
    const dialog = openExportDialog(kfnWarnings);
    const abort = new AbortController();

    // If the user cancels via the dialog (X / backdrop / Cancel / Esc), abort.
    dialog.promise.catch(() => abort.abort());

    dialog.promise
      .then(async (choice) => {
        // Output filename: prefer minus, else back, else original.
        const srcName =
          getAudioTrackByRole(store.getProject(), 'minus')?.audioFileName ||
          getAudioTrackByRole(store.getProject(), 'back')?.audioFileName ||
          getAudioTrackByRole(store.getProject(), 'original')?.audioFileName ||
          'karaoke';
        const baseName = srcName.replace(/\.[^.]+$/, '');
        if (choice.format === 'mp4') {
          if (!canExport()) {
            throw new Error('Экспорт видео недоступен — нужен Chrome/Edge (WebCodecs)');
          }
          // Gather decoded buffers per role from the engine for the mix.
          const bufByRole = new Map<AudioRole, AudioBuffer>();
          for (const role of ['minus', 'back'] as AudioRole[]) {
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

  refreshAll();
  return { root, refreshAudioState };
}

/** Russian pluralization for "дорожка": 1 → "дорожка", 2-4 → "дорожки", 5+ → "дорожек". */
function pluralTracks(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'дорожка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дорожки';
  return 'дорожек';
}
