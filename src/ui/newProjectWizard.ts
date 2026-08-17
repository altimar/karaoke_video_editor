/**
 * "New project" wizard — a two-step companion for starting from scratch:
 *
 *   step 1  audio: drop/pick the ORIGINAL (vocals/minus/backing are then
 *           extracted automatically) and/or any separate stems (lead / minus /
 *           back). At least one file is required.
 *   step 2  lyrics: paste the raw text and press «Сделать караоке».
 *
 * The finish phase orchestrates the heavy lifting with the SAME pieces the
 * manual flow uses: fresh project → load audio → separation (only when an
 * original was given; user stems override the extracted ones) → syllabify +
 * parse the lyrics into the text track → auto-align timings against the vocal.
 * The wizard closes and the editor holds a ready-to-polish karaoke.
 *
 * Test seam: localStorage 'test-skip-models' = '1' skips the separation and
 * auto-align phases (browser-model downloads are too heavy for e2e; the UI
 * flow itself is what the tests cover).
 */
import { store } from '../state/store';
import { audioEngine } from '../lib/audioEngine';
import {
  loadAudioBytesIntoRole,
  clearAudioRole,
  setAudioBytesMap,
} from '../lib/audioLoader';
import { createDefaultProject, AudioRole, AUDIO_ROLE_NAMES } from '../types';
import { parseLyrics } from '../lib/textParser';
import { syllabifyText } from '../lib/syllabification';
import { separateFull, getSeparationStatus } from '../lib/separation';
import { clearBgVideo } from '../lib/backgroundVideo';
import { invalidateBgImageCache } from '../lib/render';
import { openSeparationDialog } from './separationDialog';
import type { ToastFn } from './controls';

/** Stems a user may provide directly (the original is handled separately). */
const STEM_ROLES: AudioRole[] = ['lead', 'minus', 'back'];

const STEM_HINTS: Record<AudioRole, string> = {
  original: '',
  lead: 'Вокальная дорожка (лид)',
  minus: 'Инструментал без вокала',
  back: 'Бэк-вокалы',
};

interface Loaded {
  name: string;
  bytes: Uint8Array;
}

export interface NewProjectWizardDeps {
  toast: ToastFn;
  /** Timeline's auto-align runner (bound vocal → CTC timings). */
  runAutoAlign: (trackId: string) => Promise<void>;
}

/** One "pick or drop a file" row. Returns its root plus a status refresher. */
function makeFileRow(
  label: string,
  hint: string,
  testid: string,
  onFile: (f: File) => void,
): { root: HTMLElement; setLoaded: (name: string | null) => void } {
  const row = document.createElement('div');
  row.className = 'wizard-file';

  const info = document.createElement('div');
  info.className = 'wizard-file-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'wizard-file-name';
  nameEl.textContent = label;
  const hintEl = document.createElement('div');
  hintEl.className = 'wizard-file-hint';
  hintEl.textContent = hint;
  info.appendChild(nameEl);
  info.appendChild(hintEl);
  row.appendChild(info);

  const status = document.createElement('div');
  status.className = 'wizard-file-status';
  row.appendChild(status);

  const pick = document.createElement('button');
  pick.type = 'button';
  pick.textContent = 'Выбрать файл';
  row.appendChild(pick);

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.style.display = 'none';
  input.dataset.testid = testid;
  row.appendChild(input);

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) onFile(f);
    input.value = '';
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    row.classList.add('drop');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop');
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });

  return {
    root: row,
    setLoaded: (name) => {
      status.textContent = name ? `✓ ${name}` : '';
      status.classList.toggle('loaded', !!name);
      pick.textContent = name ? 'Заменить' : 'Выбрать файл';
    },
  };
}

export function openNewProjectWizard(deps: NewProjectWizardDeps): void {
  const skipModels = localStorage.getItem('test-skip-models') === '1';
  const toast = deps.toast;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Новый проект';
  header.appendChild(title);
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'modal-body';
  modal.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const close = (): void => {
    window.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  window.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  // --- file state ---
  let original: Loaded | null = null;
  const stems = new Map<AudioRole, Loaded>();

  const step1 = document.createElement('div');
  const step1Title = document.createElement('div');
  step1Title.className = 'wizard-step-title';
  step1Title.textContent = 'Шаг 1 из 2 — аудио';
  step1.appendChild(step1Title);

  const origRow = makeFileRow(
    '🎵 Оригинал',
    'Вокал, минус и бэки извлекутся автоматически',
    'input-wizard-original',
    (f) => {
      f.arrayBuffer().then((buf) => {
        original = { name: f.name, bytes: new Uint8Array(buf) };
        origRow.setLoaded(f.name);
        refreshNext();
      });
    },
  );
  step1.appendChild(origRow.root);

  const stemsTitle = document.createElement('div');
  stemsTitle.className = 'wizard-step-title';
  stemsTitle.style.marginTop = '12px';
  stemsTitle.textContent = 'И/или раздельные дорожки';
  step1.appendChild(stemsTitle);

  for (const role of STEM_ROLES) {
    const row = makeFileRow(
      `🎶 ${AUDIO_ROLE_NAMES[role]}`,
      STEM_HINTS[role],
      `input-wizard-${role}`,
      (f) => {
        f.arrayBuffer().then((buf) => {
          stems.set(role, { name: f.name, bytes: new Uint8Array(buf) });
          row.setLoaded(f.name);
          refreshNext();
        });
      },
    );
    step1.appendChild(row.root);
  }
  body.appendChild(step1);

  // --- step 2: lyrics ---
  const step2 = document.createElement('div');
  step2.style.display = 'none';
  const step2Title = document.createElement('div');
  step2Title.className = 'wizard-step-title';
  step2Title.textContent = 'Шаг 2 из 2 — лирика';
  step2.appendChild(step2Title);
  const ta = document.createElement('textarea');
  ta.className = 'wizard-lyrics';
  ta.dataset.testid = 'wizard-lyrics';
  ta.placeholder = 'Вставьте текст песни…';
  ta.rows = 8;
  step2.appendChild(ta);
  const step2Hint = document.createElement('div');
  step2Hint.className = 'wizard-file-hint';
  step2Hint.textContent = 'Слоги и тайминги расставятся автоматически по вокалу.';
  step2.appendChild(step2Hint);
  body.appendChild(step2);

  // --- footer ---
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Отмена';
  cancelBtn.dataset.testid = 'btn-wizard-cancel';
  const backBtn = document.createElement('button');
  backBtn.textContent = 'Назад';
  backBtn.style.display = 'none';
  const nextBtn = document.createElement('button');
  nextBtn.className = 'primary';
  nextBtn.textContent = 'Далее';
  nextBtn.dataset.testid = 'btn-wizard-next';
  const finishBtn = document.createElement('button');
  finishBtn.className = 'primary';
  finishBtn.textContent = 'Сделать караоке';
  finishBtn.dataset.testid = 'btn-wizard-finish';
  finishBtn.style.display = 'none';
  finishBtn.disabled = true;
  footer.appendChild(cancelBtn);
  footer.appendChild(backBtn);
  footer.appendChild(nextBtn);
  footer.appendChild(finishBtn);

  const refreshNext = (): void => {
    nextBtn.disabled = original === null && stems.size === 0;
  };
  refreshNext();

  nextBtn.addEventListener('click', () => {
    step1.style.display = 'none';
    step2.style.display = '';
    nextBtn.style.display = 'none';
    backBtn.style.display = '';
    finishBtn.style.display = '';
    ta.focus();
  });
  backBtn.addEventListener('click', () => {
    step2.style.display = 'none';
    step1.style.display = '';
    backBtn.style.display = 'none';
    finishBtn.style.display = 'none';
    nextBtn.style.display = '';
  });
  cancelBtn.addEventListener('click', close);
  ta.addEventListener('input', () => {
    finishBtn.disabled = !ta.value.trim();
  });

  finishBtn.addEventListener('click', async () => {
    finishBtn.disabled = true;
    // Close the wizard — progress continues in the dedicated dialogs.
    close();
    try {
      await buildKaraoke(deps, { original, stems, lyrics: ta.value, skipModels });
    } catch (err) {
      toast('Мастер не завершился: ' + (err instanceof Error ? err.message : String(err)), 'err');
    }
  });
}

/** The finish phase — resets the project and runs the full preparation. */
async function buildKaraoke(
  deps: NewProjectWizardDeps,
  payload: { original: Loaded | null; stems: Map<AudioRole, Loaded>; lyrics: string; skipModels: boolean },
): Promise<void> {
  const { toast } = deps;

  // 1. Fresh project + clean audio/background state.
  for (const role of ['original', ...STEM_ROLES] as AudioRole[]) clearAudioRole(role);
  clearBgVideo();
  setAudioBytesMap(new Map());
  store.setProject(createDefaultProject());
  invalidateBgImageCache();

  // 2. The original drives duration (+ separation below).
  if (payload.original) {
    await loadAudioBytesIntoRole('original', payload.original.bytes, payload.original.name);
  }

  // 3. Separation from the original fills lead/minus/back.
  if (payload.original && !payload.skipModels) {
    const status = getSeparationStatus();
    if (status.available) {
      const dialog = openSeparationDialog('Извлечение вокала, минуса и бэка');
      try {
        const { lead, back, instrumental } = await separateFull(payload.original.bytes, {
          onDownload: (loaded, total) => dialog.setDownload(total > 0 ? loaded / total : null),
          onStatus: (msg) => dialog.setStatus(msg),
          onProgress: (frac) => dialog.setProgress(frac),
        });
        const base = payload.original.name.replace(/\.[^.]+$/, '');
        await loadAudioBytesIntoRole('lead', lead, `${base} (лид).wav`);
        await loadAudioBytesIntoRole('back', back, `${base} (бэк).wav`);
        await loadAudioBytesIntoRole('minus', instrumental, `${base} (минус).wav`);
        dialog.close();
      } catch (err) {
        dialog.error(err instanceof Error ? err.message : String(err));
        return;
      }
    } else {
      toast('Разделение недоступно: ' + status.reason, 'err');
    }
  }

  // 4. User-provided stems win over the extracted ones.
  for (const [role, file] of payload.stems) {
    await loadAudioBytesIntoRole(role, file.bytes, file.name);
  }

  // 5. Lyrics: syllabify + parse into the (default) text track.
  const syll = syllabifyText(payload.lyrics);
  const lines = parseLyrics(syll.text);
  const project = store.getProject();
  const textTrack = project.tracks.find((t) => t.type === 'text');
  if (!textTrack) return;
  store.mutate((p) => {
    const t = p.tracks.find((x) => x.id === textTrack.id);
    if (t && t.type === 'text') t.lines = lines;
    p.durationMs = audioEngine.durationMs;
  });

  // 6. Auto-align the syllable timings against the bound vocal.
  if (payload.skipModels) return;
  const vocalRole = textTrack.boundVocalRole;
  if (!vocalRole || !audioEngine.getBuffer(vocalRole)) {
    toast('Вокал не загружен — авторасстановка пропущена (тайминги: вручную или ⏱)', 'err');
    return;
  }
  await deps.runAutoAlign(textTrack.id);
  toast('Караоке готово — поправьте тайминги по вкусу', 'ok');
}
