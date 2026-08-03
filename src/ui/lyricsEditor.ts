/**
 * Lyrics editor (left column).
 *
 * A textarea where the user pastes/types lyrics using '/' between syllables and
 * newlines between lines. A live preview below shows the parsed syllable
 * structure. Editing the text re-parses and rebuilds the data model while
 * PRESERVING existing timings by matching syllables by their text content — so
 * splitting a word ("Привет" → "При/вет"), adding or removing syllables keeps
 * the timings of unaffected syllables and evenly distributes a split word's
 * time slot across its pieces.
 */
import { store } from '../state/store';
import { parseLyrics, serializeLyrics, mergeTimings } from '../lib/textParser';
import { syllabifyText } from '../lib/syllabification';

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
  ta.value = serializeLyrics(store.getProject().lines);

  // Track focus so external store updates (e.g. project load) don't clobber typing.
  let focused = false;
  ta.addEventListener('focus', () => (focused = true));
  ta.addEventListener('blur', () => (focused = false));

  ta.addEventListener('input', () => {
    const newLines = parseLyrics(ta.value);
    store.mutate((p) => {
      // Preserve existing timings by matching syllables by TEXT (not position),
      // so splitting a word ("Привет" → "При/вет") keeps timings of other
      // syllables and evenly distributes the split word's time slot.
      const old = p.lines;
      mergeTimings(old, newLines);
      p.lines = newLines;
    });
    drawParsed();
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

  // Parsed preview area
  const parsed = document.createElement('div');
  parsed.className = 'hint';
  parsed.style.cssText = 'margin-top:8px;max-height:120px;overflow:auto;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:6px;font-family:monospace';
  card.appendChild(parsed);

  root.appendChild(card);

  function drawParsed(): void {
    const lines = store.getProject().lines;
    parsed.innerHTML = '';
    lines.forEach((line) => {
      const row = document.createElement('div');
      row.textContent = line.syllables.map((s) => (s.startMs !== null ? `[${s.text}]` : s.text)).join(' ');
      parsed.appendChild(row);
    });
  }

  // When the project is replaced (load) and the editor isn't focused, resync text.
  store.subscribe(() => {
    if (!focused) {
      const fresh = serializeLyrics(store.getProject().lines);
      if (fresh !== ta.value) ta.value = fresh;
    }
    drawParsed();
  });

  drawParsed();
  return { root };
}
