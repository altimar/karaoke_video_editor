/**
 * Timeline GUTTER — the fixed left column of track-header cards (HTML, not
 * canvas). Extracted from the orchestrator: it is a self-contained renderer
 * with its own rebuild signature, needing only the display track order, the
 * shell callbacks (background/track selection) and the timeline actions
 * (pickers + runners) for its buttons.
 *
 * Cards are rebuilt ONLY when the set of tracks, their types/names/flags or
 * the active id changes — NOT on every frame (see the signature check).
 */
import { store } from '../../state/store';
import { Track, AudioTrack, TextTrack, createTextTrack } from '../../types';
import { clearAudioRole, getAudioBytesMap } from '../../lib/audioLoader';
import { clearBgVideo } from '../../lib/backgroundVideo';
import { invalidateBgImageCache } from '../../lib/render';
import { rowHeight, TRACK_PAD, BG_ROW_H } from './coords';
import type { TimelineActions } from './actions';

/** Shell callbacks for selection-driven panel switching (main.ts wires these). */
export interface GutterCallbacks {
  /** The Фон header was clicked — show the background settings panel. */
  onBackgroundSelected?: () => void;
  /** Any real track header was clicked — bring the track panel back. */
  onTrackSelected?: () => void;
}

/**
 * Create a gutter renderer bound to `gutterEl`. The returned function takes
 * the DISPLAY-ordered tracks (the orchestrator owns that ordering) and
 * rebuilds the cards when their signature changes.
 */
export function createGutterRenderer(
  gutterEl: HTMLElement,
  cb: GutterCallbacks,
  actions: TimelineActions,
): (displayTracks: Track[]) => void {
  let lastSig = '';

  return function renderGutter(disp: Track[]): void {
    const project = store.getProject();
    const sig =
      project.tracks.map((t) =>
        `${t.id}:${t.type}:${t.name}:${t.type === 'audio' ? `${t.audioFileName}:${(t as AudioTrack).muted ? 'M' : ''}:${(t as AudioTrack).solo ? 'S' : ''}` : ''}`,
      ).join('|') +
      '@' + project.activeTrackId +
      '@bg:' + project.background.bgType + ':' + (project.background.bgVideoFileName ?? '') + ':' + (project.background.bgImageDataUrl ? '1' : '') +
      '@bind:' + project.tracks.filter((t) => t.type === 'text').map((t) => `${t.id}=${(t as TextTrack).boundVocalRole ?? ''}`).join(',');
    if (sig === lastSig) return;
    lastSig = sig;
    gutterEl.innerHTML = '';

    const rulerSpacer = document.createElement('div');
    rulerSpacer.className = 'timeline-gutter-ruler';
    // "Add text track" button, aligned with the ruler row so it sits above the
    // track headers (where the tabs used to live in the lyrics editor).
    const addBtn = document.createElement('button');
    addBtn.className = 'timeline-add-track';
    addBtn.textContent = '+ Текстовая дорожка';
    addBtn.title = 'Добавить текстовую дорожку';
    addBtn.addEventListener('click', () => {
      store.mutate((p) => {
        const t = createTextTrack(`Дорожка ${p.tracks.length + 1}`);
        p.tracks.push(t);
        p.activeTrackId = t.id;
      });
    });
    rulerSpacer.appendChild(addBtn);
    gutterEl.appendChild(rulerSpacer);

    for (const track of disp) {
      const th = document.createElement('div');
      // A text track bound to a vocal renders as ONE frame with its vocal
      // card (pair-top / pair-bottom): no border, no rounding and no canvas
      // separator at the junction — the pairing is visible without a badge.
      const pairTop =
        track.type === 'text' && (track as TextTrack).boundVocalRole !== null;
      const pairBottom =
        track.type === 'audio' &&
        project.tracks.some(
          (t) => t.type === 'text' && t.boundVocalRole === (track as AudioTrack).role,
        );
      th.className =
        'timeline-track-head' +
        (track.id === project.activeTrackId ? ' active' : '') +
        (track.type === 'audio' ? ' audio' : '') +
        (pairTop ? ' pair-top' : '') +
        (pairBottom ? ' pair-bottom' : '');
      // Card spans [previous row's separator, own row's separator] — i.e. the
      // row plus the gap ABOVE it — so cards stack contiguously with no air
      // between them and every card border lands on a canvas line. The card's
      // BOTTOM border coincides with the row's separator (bottom = row
      // bottom); the label/buttons center in the WHOLE card (align-items:
      // center, no extra padding).
      th.style.height = rowHeight(track, project.activeTrackId) + TRACK_PAD + 'px';
      th.title = 'Сделать эту дорожку активной';
      // Stable selector anchors for E2E: role for audio tracks, id for text.
      th.dataset.testid = track.type === 'audio' ? `track-head-${track.role}` : 'track-head-text';
      th.dataset.trackId = track.id;

      const name = document.createElement('span');
      name.className = 'timeline-track-name';
      if (track.type === 'audio') {
        name.textContent = '🎵 ' + track.name;
      } else {
        name.textContent = '🎤 ' + track.name;
      }
      th.appendChild(name);

      // "Extract" action: run Mel-RoFormer on the loaded original and fill the
      // lead-vocal and instrumental (minus) slots from a single run. Shown on
      // either empty 'lead' or 'minus' role when an original is loaded. If the
      // browser can't run the model, the click explains why.
      if (
        track.type === 'audio' &&
        (track.role === 'lead' || track.role === 'minus') &&
        !track.audioFileName &&
        getAudioBytesMap().has('original')
      ) {
        const extractBtn = document.createElement('span');
        extractBtn.className = 'timeline-track-extract';
        extractBtn.textContent = '✨';
        extractBtn.title = 'Извлечь вокал и минус из оригинала';
        extractBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void actions.runSeparation();
        });
        th.appendChild(extractBtn);
      }

      // Mute / Solo buttons (audio roles only). M = gain 0; S = isolate.
      if (track.type === 'audio') {
        const at = track as AudioTrack;
        const muteBtn = document.createElement('span');
        muteBtn.className = 'timeline-track-ms mute' + (at.muted ? ' active' : '');
        muteBtn.textContent = 'M';
        muteBtn.title = at.muted ? 'Включить звук' : 'Заглушить';
        muteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          store.mutate((p) => {
            const t = p.tracks.find((x) => x.id === at.id);
            if (t && t.type === 'audio') t.muted = !t.muted;
          });
        });
        th.appendChild(muteBtn);

        const soloBtn = document.createElement('span');
        soloBtn.className = 'timeline-track-ms solo' + (at.solo ? ' active' : '');
        soloBtn.textContent = 'S';
        soloBtn.title = at.solo ? 'Снять соль' : 'Соль';
        soloBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          store.mutate((p) => {
            const t = p.tracks.find((x) => x.id === at.id);
            if (t && t.type === 'audio') t.solo = !t.solo;
          });
        });
        th.appendChild(soloBtn);
      }

      // Click on the header body: activate the track; for an empty audio role,
      // also open the load-audio dialog.
      th.addEventListener('click', (e) => {
        // Let inner buttons (extract / align / mute / solo / delete) handle their own clicks.
        if ((e.target as HTMLElement).closest('.timeline-track-del')) return;
        if ((e.target as HTMLElement).closest('.timeline-track-extract')) return;
        if ((e.target as HTMLElement).closest('.timeline-track-align')) return;
        if ((e.target as HTMLElement).closest('.timeline-track-ms')) return;
        store.mutate((p) => (p.activeTrackId = track.id));
        // Even when the active track doesn't change (same id), the panel must
        // leave background mode — the user explicitly picked a track.
        gutterEl.querySelector('.timeline-track-head.bg')?.classList.remove('active');
        cb.onTrackSelected?.();
        if (track.type === 'audio' && !track.audioFileName) {
          actions.openAudioPicker(track);
        }
      });

      // Auto-timing button (text tracks): CTC forced alignment of the lyrics
      // against the vocal audio. Uses the separated lead, else the original,
      // else the backing-vocal stem. Resets the track's existing timings.
      if (track.type === 'text') {
        const alignBtn = document.createElement('span');
        alignBtn.className = 'timeline-track-align';
        alignBtn.textContent = '⏱';
        alignBtn.title = 'Авторасстановка таймингов по вокалу';
        alignBtn.dataset.testid = 'btn-auto-align';
        alignBtn.dataset.trackId = track.id;
        alignBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void actions.runAutoAlign(track.id);
        });
        th.appendChild(alignBtn);
      }

      // Delete / clear button.
      const del = document.createElement('span');
      del.className = 'timeline-track-del';
      del.textContent = '×';
      if (track.type === 'audio') {
        // Audio: clear the audio (slot stays). Only show if audio is loaded.
        del.title = 'Очистить аудио';
        del.style.display = track.audioFileName ? '' : 'none';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Очистить аудио в дорожке «${track.name}»?`)) return;
          clearAudioRole(track.role);
        });
      } else {
        // Text: delete the track (needs at least one text track to remain).
        del.title = 'Удалить дорожку';
        const proj = store.getProject();
        del.style.display = proj.tracks.filter((t) => t.type === 'text').length > 1 ? '' : 'none';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Удалить дорожку «${track.name}»?`)) return;
          store.mutate((p) => {
            const idx = p.tracks.findIndex((t) => t.id === track.id);
            if (idx < 0) return;
            p.tracks.splice(idx, 1);
            // Pick a neighbor as the new active track.
            const nextIdx = Math.min(idx, p.tracks.length - 1);
            p.activeTrackId = p.tracks[nextIdx].id;
          });
        });
      }
      th.appendChild(del);

      gutterEl.appendChild(th);
    }

    // Background pseudo-row header: click loads an image or an mp4; × resets
    // to the color background (color/gradient themselves live in the style panel).
    const bg = project.background;
    const bgHead = document.createElement('div');
    bgHead.className = 'timeline-track-head bg';
    bgHead.style.height = BG_ROW_H + TRACK_PAD + 'px';
    bgHead.title = 'Загрузить фон: картинку или MP4-видео';
    bgHead.dataset.testid = 'track-head-background';
    const bgName = document.createElement('span');
    bgName.className = 'timeline-track-name';
    bgName.textContent = '🖼 Фон';
    bgHead.appendChild(bgName);
    if (bg.bgType === 'image' || bg.bgType === 'video') {
      const bgDel = document.createElement('span');
      bgDel.className = 'timeline-track-del';
      bgDel.textContent = '×';
      bgDel.title = 'Сбросить фон до цвета';
      bgDel.addEventListener('click', (e) => {
        e.stopPropagation();
        if (bg.bgType === 'video') clearBgVideo();
        store.mutate((p) => {
          p.background.bgType = 'color';
          p.background.bgImageDataUrl = null;
          p.background.bgVideoFileName = null;
        });
        invalidateBgImageCache();
      });
      bgHead.appendChild(bgDel);
    }
    // Header click SELECTS the Фон pseudo-row: its "track settings" are the
    // shared background card in the style panel. Quick-load stays on the
    // canvas row (click there opens the file picker directly).
    bgHead.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.timeline-track-del')) return;
      bgHead.classList.add('active');
      cb.onBackgroundSelected?.();
    });
    gutterEl.appendChild(bgHead);
  };
}
