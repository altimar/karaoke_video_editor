/**
 * Timeline ACTIONS — the app-level flows reachable from the timeline UI
 * (track headers, the background pseudo-row), kept out of the orchestrator:
 *
 *  - hidden file inputs: load audio into a role, load a background image/mp4;
 *  - runSeparation: the ✨ two-phase vocal/back/minus extraction;
 *  - runAutoAlign: the ⏱ CTC forced alignment of a text track.
 *
 * The orchestrator (index.ts) owns layout/pointers/drawing and calls these;
 * main.ts reaches runAutoAlign through createTimeline's return value.
 */
import { store } from '../../state/store';
import { audioEngine } from '../../lib/audioEngine';
import { Project, AudioRole, AudioTrack, AUDIO_ROLE_NAMES, getAudioTrackByRole } from '../../types';
import {
  loadAudioIntoRole,
  loadAudioBytesIntoRole,
  getAudioBytesMap,
} from '../../lib/audioLoader';
import { separateFull, getSeparationStatus } from '../../lib/separation';
import { autoAlignTimings, getAlignmentStatus } from '../../lib/forcedAlign';
import { openVocalBindDialog } from '../vocalBindDialog';
import { openSeparationDialog } from '../separationDialog';
import type { ToastFn } from '../controls';
import { applyBgFile } from '../bgFile';

export interface TimelineActions {
  /** Hidden-input holder (display:none) — mount into the timeline root. */
  root: HTMLElement;
  /** Arm the hidden audio input with a role and open the file dialog. */
  openAudioPicker(track: AudioTrack): void;
  /** Open the background picker (image or mp4). */
  openBgPicker(): void;
  /** Run the ✨ vocal/back/minus extraction from the loaded original. */
  runSeparation(): Promise<void>;
  /** Run the ⏱ forced alignment for a text track (binds a vocal if needed). */
  runAutoAlign(trackId: string): Promise<void>;
}

export function createTimelineActions(toast: ToastFn): TimelineActions {
  const root = document.createElement('div');
  root.style.display = 'none';

  // --- Hidden file input reused for loading audio into a role. ---
  const audioInput = document.createElement('input');
  audioInput.type = 'file';
  audioInput.accept = 'audio/mpeg,audio/mp3,.mp3,audio/wav,.wav,audio/ogg,.ogg';
  audioInput.dataset.testid = 'input-audio-load';
  let pendingRole: AudioRole | null = null;
  audioInput.addEventListener('change', async () => {
    const f = audioInput.files?.[0];
    if (!f || !pendingRole) return;
    try {
      await loadAudioIntoRole(pendingRole, f);
    } catch {
      /* decode error — ignore */
    }
    audioInput.value = '';
    pendingRole = null;
  });
  root.appendChild(audioInput);

  // --- Hidden file input for the background pseudo-row (image or mp4). ---
  const bgInput = document.createElement('input');
  bgInput.type = 'file';
  bgInput.accept = 'image/*,video/mp4,.mp4';
  bgInput.dataset.testid = 'input-bg-load';
  bgInput.addEventListener('change', async () => {
    const f = bgInput.files?.[0];
    if (!f) return;
    await applyBgFile(f, toast);
    bgInput.value = '';
  });
  root.appendChild(bgInput);

  function openAudioPicker(track: AudioTrack): void {
    pendingRole = track.role;
    audioInput.click();
  }

  function openBgPicker(): void {
    bgInput.click();
  }

  /**
   * Run the vocal separation pipeline and load the stems into their roles:
   * lead vocal → 'lead', backing → 'back' (when detected), instrumental → 'minus'.
   */
  async function runSeparation(): Promise<void> {
    const original = getAudioBytesMap().get('original');
    if (!original) {
      toast('Сначала загрузите оригинал', 'err');
      return;
    }
    // Explain why the action can't run instead of failing silently mid-way.
    const status = getSeparationStatus();
    if (!status.available) {
      toast('Извлечение недоступно: ' + status.reason, 'err');
      return;
    }
    const dialog = openSeparationDialog('Извлечение вокала, минуса и бэка');
    try {
      const { lead, back, instrumental } = await separateFull(original, {
        onDownload: (loaded, total) => dialog.setDownload(total > 0 ? loaded / total : null),
        onStatus: (msg) => dialog.setStatus(msg),
        onProgress: (frac) => dialog.setProgress(frac),
      });
      // Derive sensible filenames from the original's name.
      const origName =
        getAudioTrackByRole(store.getProject(), 'original')?.audioFileName ?? 'original.mp3';
      const base = origName.replace(/\.[^.]+$/, '');
      await loadAudioBytesIntoRole('lead', lead, `${base} (лид).wav`);
      // back === null → the detector found no backing vocals (just quiet lead
      // leakage): the lead already carries the full vocal, the slot stays empty.
      if (back) await loadAudioBytesIntoRole('back', back, `${base} (бэк).wav`);
      await loadAudioBytesIntoRole('minus', instrumental, `${base} (минус).wav`);
      dialog.close();
      toast(
        back ? 'Вокал, бэк и минус извлечены и загружены' : 'Вокал и минус извлечены; бэк-вокал не обнаружен',
        'ok',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dialog.error(msg);
      toast('Не удалось извлечь вокал: ' + msg, 'err');
    }
  }

  /**
   * Run CTC forced alignment for a text track's lyrics against the vocal
   * audio (lead stem, else original, else back-vocal stem) and OVERWRITE the
   * track's syllable timings with the result.
   */
  async function runAutoAlign(trackId: string): Promise<void> {
    const proj: Project = store.getProject();
    const track = proj.tracks.find((t) => t.id === trackId);
    if (!track || track.type !== 'text') return;

    const status = getAlignmentStatus();
    if (!status.available) {
      toast('Авторасстановка недоступна: ' + status.reason, 'err');
      return;
    }

    // The lyrics are aligned against the track's BOUND vocal. Unbound → the
    // picker dialog binds one (and enforces one-text-track-per-vocal).
    let role: AudioRole | null = track.boundVocalRole;
    if (!role) {
      const dialog = openVocalBindDialog(store.getProject(), track);
      const chosen = await dialog.promise;
      if (!chosen) return;
      role = chosen;
      store.mutate((p) => {
        const t = p.tracks.find((x) => x.id === trackId);
        if (t && t.type === 'text') t.boundVocalRole = role;
      });
      toast(`Дорожка «${track.name}» привязана к «${AUDIO_ROLE_NAMES[role]}»`, 'ok');
    }

    const buffer = audioEngine.getBuffer(role);
    if (!buffer) {
      toast(`Вокальная дорожка «${AUDIO_ROLE_NAMES[role]}» пуста — загрузите или извлеките вокал`, 'err');
      return;
    }

    const dialog = openSeparationDialog('Авторасстановка таймингов');
    try {
      const starts = await autoAlignTimings(buffer, track.lines, {
        onDownload: (loaded, total) => dialog.setDownload(total > 0 ? loaded / total : null),
        onStatus: (msg) => dialog.setStatus(msg),
        onProgress: (frac) => dialog.setProgress(frac),
      });
      store.mutate((p) => {
        const t = p.tracks.find((x) => x.id === trackId);
        if (!t || t.type !== 'text') return;
        let i = 0;
        for (const line of t.lines) {
          for (const syl of line.syllables) syl.startMs = starts[i++] ?? null;
        }
      });
      dialog.close();
      toast(`Готово: расставлено ${starts.length} слогов`, 'ok');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dialog.error(msg);
      toast('Авторасстановка не удалась: ' + msg, 'err');
    }
  }

  return { root, openAudioPicker, openBgPicker, runSeparation, runAutoAlign };
}
