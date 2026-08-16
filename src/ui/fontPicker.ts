/**
 * Font picker for the style panel.
 *
 * Replaces the free-text font input: the user can't know which fonts exist on
 * the machine or what they look like. The picker is a button (label rendered
 * IN the current font) that opens a dropdown listing the fonts actually
 * AVAILABLE in this browser (probed via `document.fonts.check`), each row
 * typeset in its own font with a Cyrillic+digit sample — the app is a karaoke
 * editor for Russian lyrics, so showing how «Аа Яя» renders matters as much
 * as the name.
 *
 `buildFontList` is pure (takes the probe as a predicate) and unit-tested;
 the DOM half follows the panel's build-once / update-in-place field pattern
 (Field: root + set(v) that never fires the change handler).
 */

/** Curated cross-platform candidates, pruned at runtime by availability. */
const FONT_CANDIDATES: string[] = [
  // web-core, present virtually everywhere
  'Arial', 'Arial Black', 'Arial Narrow', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Times New Roman', 'Georgia', 'Garamond', 'Palatino', 'Courier New', 'Impact',
  'Comic Sans MS', 'Brush Script MT', 'Lucida Console',
  // Windows
  'Segoe UI', 'Calibri', 'Cambria', 'Candara', 'Corbel', 'Constantia', 'Consolas',
  'Franklin Gothic Medium', 'Century Gothic', 'Rockwell', 'Copperplate', 'Papyrus',
  // macOS
  'Helvetica', 'Helvetica Neue', 'Menlo', 'Monaco', 'Optima', 'Futura', 'Gill Sans',
  'Baskerville', 'Didot', 'American Typewriter', 'Andale Mono', 'Bradley Hand',
  'Cochin', 'Hoefler Text', 'Marker Felt', 'Zapfino',
  // generic families — always kept (they resolve everywhere)
  'system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
];

/** Generic families never go through the probe. */
const ALWAYS_AVAILABLE = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy']);

/** Sample shown next to the name — Cyrillic pairs + digits. */
const SAMPLE = 'Аа Яя 123';

/**
 * Build the list of font names available in this environment.
 * Pure: the availability probe is injected, so tests can pass a fake.
 * The CURRENT font (whatever the user/project had) is kept on top even if the
 * probe says no — it may be a deliberate custom stack we shouldn't hide.
 */
export function buildFontList(
  current: string,
  isAvailable: (font: string) => boolean,
  candidates: string[] = FONT_CANDIDATES,
): string[] {
  const list: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push(name);
  };
  // Split multi-font stacks ("Custom, serif") and keep each named part.
  for (const part of current.split(',')) push(part.trim().replace(/^["']|["']$/g, ''));
  for (const name of candidates) {
    if (!ALWAYS_AVAILABLE.has(name) && isAvailable(name)) push(name);
  }
  // Generic families resolve on every platform — always offered last.
  for (const g of ALWAYS_AVAILABLE) push(g);
  return list;
}

/** Probe a font via the browser's own availability check. */
export function probeFont(font: string): boolean {
  try {
    return document.fonts.check(`16px "${font}"`);
  } catch {
    return false;
  }
}

/** Field-compatible font picker (root + set), like the other panel fields. */
export interface FontPickerField {
  root: HTMLElement;
  set: (v: string) => void;
}

export function createFontPicker(
  current: string,
  onPick: (font: string) => void,
): FontPickerField {
  const root = document.createElement('div');
  root.className = 'font-picker';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'font-picker-btn';
  btn.dataset.testid = 'font-picker';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'font-picker-name';
  const chevron = document.createElement('span');
  chevron.className = 'font-picker-chevron';
  chevron.textContent = '▾';
  btn.appendChild(nameSpan);
  btn.appendChild(chevron);

  const list = document.createElement('div');
  list.className = 'font-list';
  list.dataset.testid = 'font-list';
  list.style.display = 'none';

  root.appendChild(btn);
  root.appendChild(list);

  let value = current;
  let open = false;

  const renderValue = (): void => {
    nameSpan.textContent = value || '(шрифт не задан)';
    nameSpan.style.fontFamily = value;
  };

  const closeList = (): void => {
    open = false;
    list.style.display = 'none';
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeList();
  };

  const openList = (): void => {
    if (open) return;
    open = true;
    list.textContent = '';
    for (const font of buildFontList(value, probeFont)) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'font-option' + (font === value ? ' selected' : '');
      opt.dataset.testid = 'font-option';
      opt.dataset.font = font;
      const sample = document.createElement('span');
      sample.className = 'font-sample';
      sample.style.fontFamily = font;
      sample.textContent = SAMPLE;
      const label = document.createElement('span');
      label.className = 'font-option-name';
      label.style.fontFamily = font;
      label.textContent = font;
      opt.appendChild(sample);
      opt.appendChild(label);
      opt.addEventListener('click', () => {
        value = font;
        renderValue();
        closeList();
        onPick(font);
      });
      list.appendChild(opt);
    }
    list.style.display = '';
    list.scrollTop = 0;
    // scroll the selected row into view
    const sel = list.querySelector('.font-option.selected');
    if (sel instanceof HTMLElement) sel.scrollIntoView({ block: 'center' });
    window.addEventListener('keydown', onKey);
  };

  btn.addEventListener('click', () => (open ? closeList() : openList()));
  // Outside click closes (without stealing the click from other controls).
  document.addEventListener('click', (e) => {
    if (open && !root.contains(e.target as Node)) closeList();
  });

  renderValue();
  return {
    root,
    set: (v: string) => {
      value = v;
      renderValue();
    },
  };
}
