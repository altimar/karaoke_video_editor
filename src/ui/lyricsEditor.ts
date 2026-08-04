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
import { getActiveTextTrack } from '../types';

export function createLyricsEditor(): { root: HTMLElement } {
  const root = document.createElement('div');

  const card = document.createElement('div');
  card.className = 'card';
  const h2 = document.createElement('h2');
  h2.textContent = 'Текст песни';
  card.appendChild(h2);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = 'Слоги делятся по пробелам и <kbd>/</kbd>, строки — переносами. Знаки препинания и другие символы остаются при словах. Можно вставить текст целиком — слова разобьются сами. Чтобы разбить слово внутри, используйте <kbd>/</kbd>: <kbd>Ка/ра/о/ке</kbd>.';
  card.appendChild(hint);

  const ta = document.createElement('textarea');
  ta.className = 'lyrics';
  ta.spellcheck = false;
  ta.value = (() => {
    const t = getActiveTextTrack(store.getProject());
    return t ? serializeLyrics(t.lines) : '';
  })();

  // Track focus so external store updates (e.g. project/track load) don't clobber typing.
  let focused = false;
  ta.addEventListener('focus', () => (focused = true));
  ta.addEventListener('blur', () => (focused = false));

  ta.addEventListener('input', () => {
    const newLines = parseLyrics(ta.value);
    store.mutate((p) => {
      const track = getActiveTextTrack(p);
      if (!track) return; // only text tracks are edited here
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

  // When the project/active track changes and the editor isn't focused, resync
  // text, and show/hide the text body depending on the active track's type
  // (audio tracks have no lyrics to edit). Track switching / adding / deleting
  // lives in the timeline gutter now, not here.
  store.subscribe(() => {
    const proj = store.getProject();
    const activeText = getActiveTextTrack(proj);
    const isText = !!activeText;
    ta.hidden = !isText;
    sylBtnRow.hidden = !isText;
    if (!isText) return;
    if (!focused) {
      const fresh = serializeLyrics(activeText!.lines);
      if (fresh !== ta.value) ta.value = fresh;
    }
  });

  return { root };
}
