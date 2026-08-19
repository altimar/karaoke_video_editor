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
import { parseLyrics, serializeLyrics, mergeTimings, syllableCharOffset } from '../lib/textParser';
import { onSyllableFocus } from '../lib/syllableFocus';
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
  // The textarea paints its selection ONLY while focused — for the parked
  // marker selection we draw our own highlight layer over it (positioned by
  // measuring the text in a mirror div, see highlightSyllable below).
  const taWrap = document.createElement('div');
  taWrap.className = 'lyrics-wrap';
  const hlLayer = document.createElement('div');
  hlLayer.className = 'lyrics-hl';
  hlLayer.dataset.testid = 'lyrics-highlight';
  taWrap.appendChild(ta);
  taWrap.appendChild(hlLayer);
  card.appendChild(taWrap);

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

  // Timeline → editor: selecting a syllable marker highlights that syllable's
  // text and scrolls it into view (only when the selected track IS the one
  // this textarea edits — the ACTIVE text track). No focus stealing: the
  // timeline keeps its keyboard (arrows/Del/Tab); the parked selection waits
  // for the user to click into the editor (typing then replaces the syllable).
  onSyllableFocus((f) => {
    const activeText = getActiveTextTrack(store.getProject());
    if (!activeText || activeText.id !== f.trackId) return;
    const off = syllableCharOffset(activeText.lines, f.lineIndex, f.sylIndex);
    const syl = activeText.lines[f.lineIndex]?.syllables[f.sylIndex];
    if (!syl || off > ta.value.length) return;
    ta.setSelectionRange(off, off + syl.text.length);
    // Center the caret's logical line (soft wrap makes this approximate —
    // good enough for lyrics-sized lines).
    const line = ta.value.slice(0, off).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 16;
    ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 2);
    drawHighlight(off, off + syl.text.length);
  });

  // --- The visible-without-focus highlight layer ---
  // A hidden mirror div with the textarea's exact typography renders the
  // text; a <span> at [off, end) yields client rects which we replay as
  // absolutely-positioned boxes over the textarea (scroll-compensated).
  const mirror = document.createElement('div');
  mirror.style.visibility = 'hidden';
  mirror.style.position = 'absolute';
  mirror.style.zIndex = '-1';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  let baseRects: DOMRect[] = [];

  function drawHighlight(off: number, end: number): void {
    const cs = getComputedStyle(ta);
    for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing', 'tabSize'] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mirror.style as any)[prop] = (cs as any)[prop];
    }
    mirror.style.width = `${ta.clientWidth}px`;
    mirror.textContent = '';
    mirror.append(ta.value.slice(0, off));
    const span = document.createElement('span');
    span.textContent = ta.value.slice(off, end);
    mirror.append(span);
    mirror.append(ta.value.slice(end));
    document.body.appendChild(mirror);
    try {
      const mRect = mirror.getBoundingClientRect();
      const tRect = ta.getBoundingClientRect(); // styling parity only
      void tRect;
      // Offsets within the mirror's border box == offsets within the
      // textarea's border box (identical box styles); stored UNscrolled.
      baseRects = [...span.getClientRects()].map(
        (r) => new DOMRect(r.left - mRect.left, r.top - mRect.top, r.width, r.height),
      );
    } finally {
      mirror.remove();
    }
    renderRects();
  }

  function renderRects(): void {
    hlLayer.innerHTML = '';
    for (const r of baseRects) {
      const box = document.createElement('div');
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top - ta.scrollTop}px`;
      box.style.width = `${Math.max(2, r.width)}px`;
      box.style.height = `${r.height}px`;
      hlLayer.appendChild(box);
    }
  }

  function clearHighlight(): void {
    baseRects = [];
    hlLayer.innerHTML = '';
  }

  // Keep the layer honest: follow the textarea's scroll, drop on edits.
  ta.addEventListener('scroll', renderRects);
  ta.addEventListener('input', clearHighlight);
  window.addEventListener('resize', () => (baseRects.length ? renderRects() : undefined));

  return { root };
}
