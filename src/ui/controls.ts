/**
 * Transport & top-level controls: audio load, play/pause, record timings,
 * export MP4, save/load project JSON. Most actions emit toasts so the user
 * gets clear feedback.
 */
import { store } from '../state/store';
import { audioEngine } from '../lib/audioEngine';
import { timingCapture } from '../lib/timing';
import { exportToMp4, downloadBlob, canExport, ExportCanceledError } from '../lib/export';
import { exportToKfn } from '../lib/kfnExport';
import { importFromKfn } from '../lib/kfnImport';
import { openExportDialog } from './exportDialog';
import { Project } from '../types';

export type ToastFn = (msg: string, kind?: 'ok' | 'err' | 'info') => void;

export function createTopbar(toast: ToastFn): {
  root: HTMLElement;
  refreshAudioState: () => void;
} {
  const root = document.createElement('div');
  root.className = 'topbar';

  // Raw MP3 bytes kept for KFN export (KFN embeds the original audio as-is).
  let audioBytes: Uint8Array | null = null;

  const title = document.createElement('h1');
  title.textContent = '🎤 Karaoke Video Editor';
  root.appendChild(title);

  // --- Audio load ---
  const audioBtn = document.createElement('button');
  audioBtn.textContent = '🎵 Загрузить MP3';
  const audioInput = document.createElement('input');
  audioInput.type = 'file';
  audioInput.accept = 'audio/mpeg,audio/mp3,.mp3';
  audioInput.style.display = 'none';
  audioBtn.addEventListener('click', () => audioInput.click());
  audioInput.addEventListener('change', async () => {
    const f = audioInput.files?.[0];
    if (!f) return;
    try {
      await audioEngine.load(f);
      audioBytes = new Uint8Array(await f.arrayBuffer());
      store.mutate((p) => {
        p.audioFileName = f.name;
        p.durationMs = audioEngine.durationMs;
      });
      toast(`Загружено: ${f.name}`, 'ok');
      refreshAll();
    } catch {
      toast('Не удалось декодировать аудио', 'err');
    }
  });
  root.appendChild(audioBtn);
  root.appendChild(audioInput);

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
    } else if (!audioEngine.audioBuffer) {
      toast('Сначала загрузите MP3', 'err');
    } else {
      // start from beginning if no timings yet
      timingCapture.start();
      toast('Запись! Нажимайте Пробел на каждый слог', 'info');
    }
    refreshAll();
  });
  root.appendChild(recBtn);

  // --- Save / load project ---
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 Сохранить проект';
  saveBtn.addEventListener('click', () => {
    const data = JSON.stringify(store.getProject(), null, 2);
    downloadBlob(new Blob([data], { type: 'application/json' }), 'karaoke-project.json');
  });
  root.appendChild(saveBtn);

  const loadBtn = document.createElement('button');
  loadBtn.textContent = '📂 Открыть проект';
  const projInput = document.createElement('input');
  projInput.type = 'file';
  projInput.accept = '.json,application/json';
  projInput.style.display = 'none';
  loadBtn.addEventListener('click', () => projInput.click());
  projInput.addEventListener('change', async () => {
    const f = projInput.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const project = JSON.parse(text) as Project;
      store.setProject(project);
      toast('Проект загружен', 'ok');
      refreshAll();
    } catch {
      toast('Не удалось прочитать проект', 'err');
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
      // Load audio.
      await audioEngine.loadBytes(result.audioBytes, result.project.audioFileName);
      audioBytes = result.audioBytes;
      // Load lyrics + timings into the project.
      store.mutate((p) => {
        p.lines = result.project.lines;
        p.audioFileName = result.project.audioFileName;
        p.durationMs = audioEngine.durationMs;
      });
      toast(`KFN загружен: ${result.project.audioFileName}`, 'ok');
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

  // --- Export ---
  const exportBtn = document.createElement('button');
  exportBtn.className = 'primary';
  exportBtn.textContent = '⬇ Скачать MP4';
  exportBtn.addEventListener('click', () => onExport(exportBtn));
  root.appendChild(exportBtn);

  const kfnBtn = document.createElement('button');
  kfnBtn.textContent = '⬇ Скачать KFN';
  kfnBtn.title = 'Экспорт в формат KaraFun (.kfn)';
  kfnBtn.addEventListener('click', () => {
    const project = store.getProject();
    if (!audioBytes) {
      toast('Загрузите MP3 перед экспортом', 'err');
      return;
    }
    try {
      const blob = exportToKfn(project, audioBytes);
      const name = (project.audioFileName?.replace(/\.[^.]+$/, '') || 'karaoke') + '.kfn';
      downloadBlob(blob, name);
      toast('KFN скачан', 'ok');
    } catch (err) {
      console.error(err);
      toast('Ошибка экспорта KFN: ' + (err instanceof Error ? err.message : String(err)), 'err');
    }
  });
  root.appendChild(kfnBtn);

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

  // --- Export flow: quality dialog → render → download ---
  function onExport(btn: HTMLButtonElement): void {
    const buffer = audioEngine.audioBuffer;
    const project = store.getProject();
    if (!buffer) {
      toast('Загрузите MP3 перед экспортом', 'err');
      return;
    }
    if (project.durationMs <= 0) {
      store.mutate((p) => (p.durationMs = audioEngine.durationMs));
    }
    if (!canExport()) {
      toast('Экспорт недоступен — нужен Chrome/Edge (WebCodecs)', 'err');
      return;
    }

    btn.disabled = true;
    const dialog = openExportDialog();
    const abort = new AbortController();

    // If the user cancels via the dialog (X / backdrop / Cancel button / Esc),
    // trigger the export abort.
    dialog.promise.catch(() => abort.abort());

    dialog.promise
      .then(async (qualityId) => {
        const blob = await exportToMp4(
          store.getProject(),
          buffer,
          { qualityId, signal: abort.signal },
          (frac) => dialog.setProgress(frac),
        );
        dialog.close();
        const name = (project.audioFileName?.replace(/\.[^.]+$/, '') || 'karaoke') + '.mp4';
        downloadBlob(blob, name);
        toast('Готово! MP4 скачан', 'ok');
      })
      .catch((err) => {
        dialog.cancel();
        // Aborted render: abort the underlying export too.
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
