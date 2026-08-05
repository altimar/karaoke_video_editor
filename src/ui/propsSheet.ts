/**
 * Properties sheet (modal) for the mobile layout.
 *
 * On narrow screens the lyrics editor and the style/effects panel are NOT shown
 * inline (there's no room beside the preview). Instead they are stashed inside
 * this bottom-sheet modal and reached via the floating "✏️ Свойства" button. It
 * exposes them as two tabs — "Текст" (lyrics) and "Стиль" (style panel) — so the
 * user can edit whichever aspect of the active track they need without leaving
 * the preview+timeline view.
 *
 * The lyric/style ROOT nodes are created once (by their factories) and MOVED
 * into this sheet; moving a DOM node preserves its listeners and state, so the
 * same component works whether it lives in a desktop column or in this modal.
 *
 * On desktop (≥900px) the nodes live in their columns and this sheet is simply
 * never opened — but it's always present in the DOM (hidden), holding the nodes
 * ready to be swapped back into the columns when the viewport widens.
 */
export interface PropsSheet {
  root: HTMLElement;
  /** The panel element meant to host the lyrics editor root. */
  lyricsPanel: HTMLElement;
  /** The panel element meant to host the style panel root. */
  stylePanel: HTMLElement;
  open: () => void;
  close: () => void;
}

/**
 * Build the (initially empty) properties sheet. The lyric/style component roots
 * are NOT attached here — the caller mounts them into `lyricsPanel`/`stylePanel`
 * (mobile) or into the desktop columns (desktop) via its own layout logic. This
 * keeps a single owner of node placement and avoids ordering ambiguity.
 */
export function createPropsSheet(): PropsSheet {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop props-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'modal props-sheet';

  // Header with tabs + close button.
  const header = document.createElement('div');
  header.className = 'modal-header props-tabs';
  const lyricsTab = document.createElement('button');
  lyricsTab.className = 'export-tab active';
  lyricsTab.textContent = 'Текст';
  const styleTab = document.createElement('button');
  styleTab.className = 'export-tab';
  styleTab.textContent = 'Стиль';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Закрыть';
  header.appendChild(lyricsTab);
  header.appendChild(styleTab);
  header.appendChild(closeBtn);
  sheet.appendChild(header);

  // Body: two panels, one per tab. The component roots are mounted into these by
  // the caller (main.ts) depending on the layout — not here.
  const body = document.createElement('div');
  body.className = 'modal-body props-body';
  const lyricsPanel = document.createElement('div');
  lyricsPanel.className = 'props-panel';
  const stylePanel = document.createElement('div');
  stylePanel.className = 'props-panel';
  stylePanel.hidden = true;
  body.appendChild(lyricsPanel);
  body.appendChild(stylePanel);
  sheet.appendChild(body);

  backdrop.appendChild(sheet);

  const switchTab = (which: 'lyrics' | 'style'): void => {
    lyricsTab.classList.toggle('active', which === 'lyrics');
    styleTab.classList.toggle('active', which === 'style');
    lyricsPanel.hidden = which !== 'lyrics';
    stylePanel.hidden = which !== 'style';
  };

  const open = (): void => {
    backdrop.classList.add('open');
    switchTab('lyrics');
  };
  const close = (): void => {
    backdrop.classList.remove('open');
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) {
      e.preventDefault();
      close();
    }
  };

  lyricsTab.addEventListener('click', () => switchTab('lyrics'));
  styleTab.addEventListener('click', () => switchTab('style'));
  closeBtn.addEventListener('click', close);
  // Click on the backdrop (outside the sheet) closes.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  window.addEventListener('keydown', onKey);

  return { root: backdrop, lyricsPanel, stylePanel, open, close };
}
