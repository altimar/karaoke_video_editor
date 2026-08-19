/**
 * Player transport — the control strip UNDER the preview canvas: play/pause,
 * timing-record and the playback-speed group. Icon-only buttons (player
 * convention); the topbar keeps project-level actions only.
 *
 * Speed (0.5×/0.75×/1×) helps manual timing capture on fast songs: the
 * browser preserves pitch, and stamped times are audio positions, so they
 * land correctly regardless of the rate.
 */
import { store } from '../state/store';
import { audioEngine } from '../lib/audioEngine';
import { timingCapture } from '../lib/timing';
import { getActiveTextTrack } from '../types';
import type { ToastFn } from './controls';

const SPEEDS: Array<{ rate: number; label: string; testid: string }> = [
  { rate: 0.5, label: '0.5×', testid: 'btn-speed-05' },
  { rate: 0.75, label: '0.75×', testid: 'btn-speed-075' },
  { rate: 1, label: '1×', testid: 'btn-speed-1' },
];

export function createTransport(toast: ToastFn): { root: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'player-transport';

  // --- Play / pause (icon-only) ---
  const playBtn = document.createElement('button');
  playBtn.className = 'transport-btn';
  playBtn.dataset.testid = 'btn-play';
  playBtn.addEventListener('click', () => audioEngine.toggle());
  root.appendChild(playBtn);

  // --- Record timings (icon-only; ● red while recording) ---
  const recBtn = document.createElement('button');
  recBtn.className = 'transport-btn rec';
  recBtn.dataset.testid = 'btn-record';
  recBtn.addEventListener('click', () => {
    if (timingCapture.isRecording()) {
      timingCapture.stop();
    } else if (!getActiveTextTrack(store.getProject())) {
      toast('Выберите текстовую дорожку для записи таймингов', 'err');
    } else if (
      !audioEngine.has('original') &&
      !audioEngine.has('lead') &&
      !audioEngine.has('minus') &&
      !audioEngine.has('back')
    ) {
      toast('Сначала загрузите аудио', 'err');
    } else {
      timingCapture.start();
      toast('Запись! Нажимайте Пробел на каждый слог', 'info');
    }
    refresh();
  });
  root.appendChild(recBtn);

  const sep = document.createElement('span');
  sep.className = 'topbar-sep';
  root.appendChild(sep);

  // --- Playback speed group ---
  const speedGroup = document.createElement('div');
  speedGroup.className = 'speed-group';
  for (const s of SPEEDS) {
    const btn = document.createElement('button');
    btn.className = 'speed-btn';
    btn.textContent = s.label;
    btn.title = `Скорость воспроизведения ${s.label} (тон сохраняется)`;
    btn.dataset.testid = s.testid;
    btn.addEventListener('click', () => {
      audioEngine.setPlaybackRate(s.rate);
      refresh();
    });
    speedGroup.appendChild(btn);
  }
  root.appendChild(speedGroup);

  function refresh(): void {
    playBtn.textContent = audioEngine.isPlaying ? '⏸' : '▶';
    playBtn.title = audioEngine.isPlaying ? 'Пауза' : 'Пуск';
    recBtn.textContent = timingCapture.isRecording() ? '⏹' : '●';
    recBtn.title = timingCapture.isRecording() ? 'Стоп записи' : 'Запись таймингов';
    recBtn.classList.toggle('danger', timingCapture.isRecording());
    // Recording targets the active TEXT track — disable the button when none
    // is active (the user must pick a text track first).
    recBtn.disabled = !timingCapture.isRecording() && !getActiveTextTrack(store.getProject());
    for (const btn of speedGroup.children) {
      const s = SPEEDS.find((x) => x.testid === (btn as HTMLElement).dataset.testid);
      (btn as HTMLElement).classList.toggle('active', !!s && s.rate === audioEngine.playbackRate);
    }
  }

  audioEngine.onAudioState(refresh);
  timingCapture.onState(refresh);
  // Re-evaluate the record button when the active track changes.
  store.subscribe(refresh);
  refresh();

  // Global keyboard: Space toggles play/pause when NOT recording.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if (timingCapture.isRecording()) return; // timing capture owns Space
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    audioEngine.toggle();
  });

  return { root };
}
