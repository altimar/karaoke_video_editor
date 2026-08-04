/**
 * Lyrics editor (left column).
 *
 * A textarea where the user pastes/types lyrics using '/' between syllables and
 * newlines between lines. Editing the text re-parses and rebuilds the data
 * model while PRESERVING existing timings by matching syllables by their text
 * content — so splitting a word ("Привет" → "При/вет"), adding or removing
 * syllables keeps the timings of unaffected syllables and evenly distributes
 * a split word's time slot across its pieces.
 *
 * The project may have MULTIPLE independent text tracks. A track switcher above
 * the textarea lets the user add, remove and switch between tracks. Editing,
 * auto-syllabification and timing capture all operate on the ACTIVE track.
 */
import { store } from '../state/store';
import { parseLyrics, serializeLyrics, mergeTimings } from '../lib/textParser';
import { syllabifyText } from '../lib/syllabification';
import { createTextTrack, getActiveTrack } from '../types';

export function createLyricsEditor(): { root: HTMLElement } {
  const root = document.createElement('div');

  const card = document.createElement('div');
  card.className = 'card';
  const h2 = document.createElement('h2');
  h2.textContent = 'Текст песни';
  card.appendChild(h2);

  // --- Track switcher: one tab per track + add/remove ---
  const trackBar = document.createElement('div');
  trackBar.className = 'track-bar';
  card.appendChild(trackBar);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = 'Слоги делятся по пробелам и <kbd>/</kbd>, строки — переносами. Знаки препинания и другие символы остаются при словах. Можно вставить текст целиком — слова разобьются сами. Чтобы разбить слово внутри, используйте <kbd>/</kbd>: <kbd>Ка/ра/о/ке</kbd>.';
  card.appendChild(hint);

  const ta = document.createElement('textarea');
  ta.className = 'lyrics';
  ta.spellcheck = false;
  ta.value = serializeLyrics(getActiveTrack(store.getProject()).lines);

  // Track focus so external store updates (e.g. project/track load) don't clobber typing.
  let focused = false;
  ta.addEventListener('focus', () => (focused = true));
  ta.addEventListener('blur', () => (focused = false));

  ta.addEventListener('input', () => {
    const newLines = parseLyrics(ta.value);
    store.mutate((p) => {
      const track = getActiveTrack(p);
      // Preserve existing timings by matching syllables by TEXT (not position),
      // so splitting a word ("Привет" → "При/вет") keeps timings of other
      // syllables and evenly distributes the split word's time slot.
      mergeTimings(track.lines, newLines);
      track.lines = newLines;
    });
  });
  card.appendChild(ta);

  // Auto-syllabify button: detects language and splits words into syllables
  // with '/' directly in the textarea text.
  const sylBtnRow = document.createElement('div');
  sylBtnRow.className = 'btn-row';
  sylBtnRow.style.marginTop = '8px';
  const sylBtn = document.createElement('button');
  sylBtn.textContent = '✂ Разбить на слоги';
  sylBtn.title = 'Автоматически разбить слова на слоги (по языку текста)';
  sylBtn.addEventListener('click', () => {
    const result = syllabifyText(ta.value);
    if (!result.lang) {
      // Can't syllabify — show a message via title or just do nothing.
      sylBtn.textContent = '✂ Разбить на слоги (язык не определён)';
      setTimeout(() => (sylBtn.textContent = '✂ Разбить на слоги'), 2000);
      return;
    }
    ta.value = result.text;
    // Trigger the same input handler so parseLyrics + mergeTimings run.
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    sylBtn.textContent = `✂ Разбито (${result.langLabel})`;
    setTimeout(() => (sylBtn.textContent = '✂ Разбить на слоги'), 2000);
  });
  sylBtnRow.appendChild(sylBtn);
  card.appendChild(sylBtnRow);

  root.appendChild(card);

  // --- Track switcher rendering ---
  // Rebuilt only when the set of tracks or the active id changes (NOT on every
  // text edit), so it stays cheap. Each tab shows the track name and, for the
  // active one, a delete button.
  let lastTrackSig = '';
  function renderTrackBar(): void {
    const project = store.getProject();
    const sig = project.tracks.map((t) => `${t.id}:${t.name}`).join('|') + '@' + project.activeTrackId;
    if (sig === lastTrackSig) return;
    lastTrackSig = sig;
    trackBar.innerHTML = '';
    for (const track of project.tracks) {
      const tab = document.createElement('button');
      tab.className = 'track-tab' + (track.id === project.activeTrackId ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'track-tab-name';
      label.textContent = track.name;
      tab.appendChild(label);
      tab.title = 'Сделать эту дорожку активной';
      tab.addEventListener('click', () => {
        if (track.id === store.getProject().activeTrackId) return;
        store.mutate((p) => (p.activeTrackId = track.id));
      });
      // Delete button on the active track (disabled if it's the only track).
      if (track.id === project.activeTrackId && project.tracks.length > 1) {
        const del = document.createElement('span');
        del.className = 'track-tab-del';
        del.textContent = '×';
        del.title = 'Удалить дорожку';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (project.tracks.length <= 1) return;
          store.mutate((p) => {
            const idx = p.tracks.findIndex((t) => t.id === track.id);
            if (idx < 0) return;
            p.tracks.splice(idx, 1);
            // Pick a neighbor as the new active track.
            const nextIdx = Math.min(idx, p.tracks.length - 1);
            p.activeTrackId = p.tracks[nextIdx].id;
          });
        });
        tab.appendChild(del);
      }
      trackBar.appendChild(tab);
    }
    // Add-track button.
    const addBtn = document.createElement('button');
    addBtn.className = 'track-add';
    addBtn.textContent = '+';
    addBtn.title = 'Добавить текстовую дорожку';
    addBtn.addEventListener('click', () => {
      store.mutate((p) => {
        const t = createTextTrack(`Дорожка ${p.tracks.length + 1}`);
        p.tracks.push(t);
        p.activeTrackId = t.id;
      });
    });
    trackBar.appendChild(addBtn);
  }

  // When the project/active track changes and the editor isn't focused, resync text.
  store.subscribe(() => {
    renderTrackBar();
    const activeLines = getActiveTrack(store.getProject()).lines;
    if (!focused) {
      const fresh = serializeLyrics(activeLines);
      if (fresh !== ta.value) ta.value = fresh;
    }
  });

  renderTrackBar();
  return { root };
}
