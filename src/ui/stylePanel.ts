/**
 * Style & effects panel.
 *
 * Settings are split into two groups:
 *  - PER-TRACK (font, colors, stroke/glow, layout + renderer settings): these
 *    belong to the ACTIVE track and are rebuilt when the active track changes.
 *  - PROJECT-LEVEL (background, resolution, FPS, waveform): shared across all
 *    tracks, rebuilt only when their own condition (bg type) flips.
 *
 * IMPORTANT: each card is built ONCE, and individual controls are updated in
 * place when the store changes (via setter callbacks). We must NOT rebuild the
 * DOM on every store change, because doing so while the user is dragging a
 * range slider would destroy the element under the pointer and break the drag —
 * which was the original bug ("sliders only work on click, not drag").
 *
 * Per-track cards are rebuilt only when `activeTrackId` changes (not on every
 * value tweak), so switching tracks rebinds the fields without disturbing drags
 * within a track.
 *
 * Each field builder returns its root element plus a `set(v)` function that
 * pushes a new value into the control WITHOUT firing its change handler (so we
 * don't create feedback loops).
 */
import { store } from '../state/store';
import { BgType, Background, Project, TextTrack, TextStyle, getActiveTrack, getActiveTextTrack } from '../types';
import { invalidateBgImageCache } from '../lib/render';
import { getRenderer, RENDERER_LIST } from '../lib/text_renderers/registry';
import { RenderSettingSpec } from '../lib/text_renderers/types';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts.className) e.className = opts.className;
  if (opts.text !== undefined) e.textContent = opts.text;
  return e;
}

/** A field exposes its root element and a way to update its value from outside. */
interface Field<T> {
  root: HTMLElement;
  set: (v: T) => void;
}

/**
 * Numeric slider field. On `input` it writes through to the store; the panel's
 * store-subscription calls `set()` to reflect external changes. Because we only
 * ever set `.value` (never recreate the node), dragging the thumb keeps working.
 */
function numberField(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): Field<number> {
  const lab = el('label', { className: 'field' });
  lab.appendChild(el('span', { text: label }));
  const input = el('input') as HTMLInputElement;
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const val = el('span', { text: String(value) });
  val.style.cssText = 'float:right;font-size:11px;color:var(--text-dim)';
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = String(v);
    onChange(v);
  });
  lab.appendChild(val);
  lab.appendChild(input);
  return {
    root: lab,
    set: (v) => {
      // Only touch the control if the value actually differs, to avoid
      // disturbing an in-progress drag.
      if (parseFloat(input.value) !== v) {
        input.value = String(v);
        val.textContent = String(v);
      }
    },
  };
}

function colorField(label: string, value: string, onChange: (v: string) => void): Field<string> {
  const lab = el('label', { className: 'field' });
  lab.appendChild(el('span', { text: label }));
  const input = el('input') as HTMLInputElement;
  input.type = 'color';
  input.value = toHex(value);
  input.addEventListener('input', () => onChange(input.value));
  lab.appendChild(input);
  return {
    root: lab,
    set: (v) => {
      const hex = toHex(v);
      if (input.value !== hex) input.value = hex;
    },
  };
}

function toHex(c: string): string {
  if (c.startsWith('#')) return c.slice(0, 7);
  const m = c.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    return '#' + [m[1], m[2], m[3]].map((n) => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
  }
  return '#ffffff';
}

/** Split a CSS color string into an rgb hex (`#rrggbb`) and an alpha (0..1). */
function parseColorAlpha(c: string): { rgb: string; alpha: number } {
  c = (c ?? '').trim();
  const rgba = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,]+([\d.]+))?\s*\)/i.exec(c);
  if (rgba) {
    const r = parseInt(rgba[1], 10);
    const g = parseInt(rgba[2], 10);
    const b = parseInt(rgba[3], 10);
    const a = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
    const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return { rgb: `#${hex(r)}${hex(g)}${hex(b)}`, alpha: Math.max(0, Math.min(1, a)) };
  }
  if (c.startsWith('#')) {
    let h = c.slice(1);
    let a = 1;
    if (h.length === 8) {
      a = parseInt(h.slice(6, 8), 16) / 255;
      h = h.slice(0, 6);
    } else if (h.length === 4) {
      a = parseInt(h[3] + h[3], 16) / 255;
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    } else if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    return { rgb: '#' + h.slice(0, 6), alpha: a };
  }
  return { rgb: '#ffffff', alpha: 1 };
}

/** Reassemble rgb hex + alpha into an `rgba(r,g,b,a)` string. */
function joinColorAlpha(rgb: string, alpha: number): string {
  const h = rgb.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Compact color field on a single row: label · swatch (opens native picker) ·
 * alpha slider. The value is a CSS color string (rgb hex or rgba()); alpha is
 * stored within the string, so changing either control reassembles the value.
 */
function colorAlphaField(label: string, value: string, onChange: (v: string) => void): Field<string> {
  const row = el('div', { className: 'color-row' });
  row.appendChild(el('span', { text: label, className: 'color-label' }));

  // Swatch: a button showing the color; a hidden native color input opens on click.
  const swatch = el('button', { className: 'color-swatch' });
  const picker = el('input') as HTMLInputElement;
  picker.type = 'color';
  picker.className = 'color-picker-hidden';

  // Alpha slider.
  const alpha = el('input') as HTMLInputElement;
  alpha.type = 'range';
  alpha.className = 'color-alpha';
  alpha.min = '0';
  alpha.max = '1';
  alpha.step = '0.01';

  // Current state (so we reassemble correctly from either control).
  let cur = parseColorAlpha(value);
  const renderSwatch = (): void => {
    swatch.style.background = joinColorAlpha(cur.rgb, cur.alpha);
  };
  const emit = (): void => onChange(joinColorAlpha(cur.rgb, cur.alpha));

  picker.value = cur.rgb;
  alpha.value = String(cur.alpha);
  renderSwatch();

  swatch.addEventListener('click', () => picker.click());
  picker.addEventListener('input', () => {
    cur = { ...cur, rgb: picker.value };
    renderSwatch();
    emit();
  });
  alpha.addEventListener('input', () => {
    cur = { ...cur, alpha: parseFloat(alpha.value) };
    renderSwatch();
    emit();
  });

  row.appendChild(swatch);
  row.appendChild(picker);
  row.appendChild(alpha);
  return {
    root: row,
    set: (v) => {
      const parsed = parseColorAlpha(v);
      cur = parsed;
      if (picker.value !== parsed.rgb) picker.value = parsed.rgb;
      if (parseFloat(alpha.value) !== parsed.alpha) alpha.value = String(parsed.alpha);
      renderSwatch();
    },
  };
}

function selectField(
  label: string,
  options: [string, string][],
  value: string,
  onChange: (v: string) => void,
): Field<string> {
  const lab = el('label', { className: 'field' });
  lab.appendChild(el('span', { text: label }));
  const sel = el('select');
  for (const [v, t] of options) {
    const o = el('option', { text: t });
    o.setAttribute('value', v);
    if (v === value) o.setAttribute('selected', 'selected');
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onChange((sel as HTMLSelectElement).value));
  lab.appendChild(sel);
  return {
    root: lab,
    set: (v) => {
      if ((sel as HTMLSelectElement).value !== v) (sel as HTMLSelectElement).value = v;
    },
  };
}

export function createStylePanel(): { root: HTMLElement } {
  const root = el('div');

  // Card containers. Per-track cards live in a host that we repopulate on track
  // switch; project-level cards (bg, layout/export) are stable.
  const trackHost = el('div');
  const bgCardEl = el('div', { className: 'card' });
  const layoutCardEl = el('div', { className: 'card' });

  // Per-track field references. Re-collected each time the active track changes.
  let trackFields: Array<{ get: (s: TextStyle, t: TextTrack) => string | number | boolean; field: Field<unknown> }> = [];
  // Project-level field references (resolution/fps/waveform + bg). Stable across
  // track switches; cleared & repopulated only when their own card rebuilds.
  const projFields: Array<{ get: (p: Project) => string | number | boolean; field: Field<unknown> }> = [];

  // Track the last-seen condition values for conditional blocks, so we only
  // rebuild them when the condition actually flips.
  let lastBgType: string | null = null;
  let lastActiveTrackId: string | null = null;
  let lastLayout: string | null = null;

  /** Mutate the active text track's style. No-op when an audio track is active. */
  function mutateStyle(fn: (s: TextStyle) => void): void {
    store.mutate((p) => {
      const t = getActiveTextTrack(p);
      if (t) fn(t.style);
    });
  }
  /** Mutate the shared background. */
  function mutateBg(fn: (b: Background) => void): void {
    store.mutate((p) => fn(p.background));
  }

  /**
   * Build a control for one renderer setting, wired to the active track's
   * rendererSettings. Number specs → slider; boolean specs → checkbox.
   */
  function buildRendererSettingControl(rendererId: string, spec: RenderSettingSpec, track: TextTrack): Field<unknown> {
    const read = (): number | boolean => {
      const v = track.rendererSettings?.[rendererId]?.[spec.key];
      return v !== undefined ? v : spec.default;
    };
    if (spec.kind === 'boolean') {
      const lab = el('label', { className: 'field' });
      lab.appendChild(el('span', { text: spec.label }));
      const cb = el('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = Boolean(read());
      cb.addEventListener('change', () => store.mutate((pr) => setSetting(getActiveTrack(pr), rendererId, spec.key, cb.checked)));
      lab.appendChild(cb);
      trackFields.push({
        get: (_st, t) => {
          const v = t.rendererSettings?.[rendererId]?.[spec.key];
          return v !== undefined ? v : spec.default;
        },
        field: {
          root: lab,
          set: (v) => {
            if (cb.checked !== Boolean(v)) cb.checked = Boolean(v);
          },
        },
      });
      return { root: lab, set: () => {} };
    }
    // number → slider
    const min = spec.min ?? 0;
    const max = spec.max ?? 100;
    const step = spec.step ?? 1;
    const f = numberField(spec.label, Number(read()), min, max, step, (v) =>
      store.mutate((pr) => setSetting(getActiveTrack(pr), rendererId, spec.key, v)),
    );
    trackFields.push({
      get: (_st, t) => {
        const v = t.rendererSettings?.[rendererId]?.[spec.key];
        return v !== undefined ? v : spec.default;
      },
      field: f as Field<unknown>,
    });
    return f as Field<unknown>;
  }

  /** Ensure the settings object exists on the track, then set one key. */
  function setSetting(track: { type: string; rendererSettings?: Record<string, Record<string, number | boolean>> }, rendererId: string, key: string, value: number | boolean): void {
    if (track.type !== 'text') return;
    if (!track.rendererSettings) track.rendererSettings = {};
    if (!track.rendererSettings[rendererId]) track.rendererSettings[rendererId] = {};
    track.rendererSettings[rendererId][key] = value;
  }

  // ---------- PER-TRACK CARDS ----------

  function buildBase(s: TextStyle): HTMLElement {
    const card = el('div', { className: 'card' });

    const ffLab = el('label', { className: 'field' });
    ffLab.appendChild(el('span', { text: 'Шрифт' }));
    const ff = el('input') as HTMLInputElement;
    ff.value = s.fontFamily;
    let focused = false;
    ff.addEventListener('focus', () => (focused = true));
    ff.addEventListener('blur', () => (focused = false));
    ff.addEventListener('input', () => mutateStyle((x) => (x.fontFamily = ff.value)));
    ffLab.appendChild(ff);
    trackFields.push({
      get: (st) => st.fontFamily,
      field: {
        root: ffLab,
        set: (v) => {
          if (!focused && ff.value !== v) ff.value = String(v);
        },
      },
    });
    card.appendChild(ffLab);

    const addNum = (label: string, min: number, max: number, step: number, get: (s: TextStyle) => number, set: (s: TextStyle, v: number) => void): void => {
      const f = numberField(label, get(s), min, max, step, (v) => mutateStyle((x) => set(x, v)));
      trackFields.push({ get: (st) => get(st), field: f as Field<unknown> });
      card.appendChild(f.root);
    };
    addNum('Размер', 16, 200, 1, (st) => st.fontSize, (st, v) => (st.fontSize = v));
    addNum('Межстрочный', 0.8, 3, 0.05, (st) => st.lineHeight, (st, v) => (st.lineHeight = v));

    const align = selectField('Выравнивание', [['left', 'Слева'], ['center', 'Центр'], ['right', 'Справа']], s.textAlign, (v) => mutateStyle((x) => (x.textAlign = v as TextStyle['textAlign'])));
    trackFields.push({ get: (st) => st.textAlign, field: align as Field<unknown> });
    card.appendChild(align.root);

    const cb = colorAlphaField('Заливка неакт.', s.colorBase, (v) => mutateStyle((x) => (x.colorBase = v)));
    const ch = colorAlphaField('Заливка актив.', s.colorHighlight, (v) => mutateStyle((x) => (x.colorHighlight = v)));
    trackFields.push({ get: (st) => st.colorBase, field: cb as Field<unknown> });
    trackFields.push({ get: (st) => st.colorHighlight, field: ch as Field<unknown> });
    card.appendChild(cb.root);
    card.appendChild(ch.root);

    const weights = el('div', { className: 'row2' });
    const wf = selectField('Начертание', [['400', 'Обычный'], ['600', 'Полужирный'], ['700', 'Жирный'], ['900', 'Чёрный']], String(s.fontWeight), (v) => mutateStyle((x) => (x.fontWeight = parseInt(v, 10))));
    trackFields.push({ get: (st) => String(st.fontWeight), field: wf as Field<unknown> });
    weights.appendChild(wf.root);
    card.appendChild(weights);

    return card;
  }

  function buildStroke(s: TextStyle): HTMLElement {
    const card = el('div', { className: 'card' });
    card.appendChild(el('h2', { text: 'Обводка и свечение' }));
    const sw = numberField('Обводка', s.strokeWidth, 0, 20, 0.5, (v) => mutateStyle((x) => (x.strokeWidth = v)));
    trackFields.push({ get: (st) => st.strokeWidth, field: sw as Field<unknown> });
    card.appendChild(sw.root);
    const sca = colorAlphaField('Граница актив.', s.strokeColorActive, (v) => mutateStyle((x) => (x.strokeColorActive = v)));
    const sci = colorAlphaField('Граница неакт.', s.strokeColorInactive, (v) => mutateStyle((x) => (x.strokeColorInactive = v)));
    trackFields.push({ get: (st) => st.strokeColorActive, field: sca as Field<unknown> });
    trackFields.push({ get: (st) => st.strokeColorInactive, field: sci as Field<unknown> });
    card.appendChild(sca.root);
    card.appendChild(sci.root);
    const gb = numberField('Свечение', s.glowBlur, 0, 80, 1, (v) => mutateStyle((x) => (x.glowBlur = v)));
    trackFields.push({ get: (st) => st.glowBlur, field: gb as Field<unknown> });
    card.appendChild(gb.root);
    const gc = colorAlphaField('Цвет свечения', s.glowColor, (v) => mutateStyle((x) => (x.glowColor = v)));
    trackFields.push({ get: (st) => st.glowColor, field: gc as Field<unknown> });
    card.appendChild(gc.root);
    return card;
  }

  function buildLayout(track: TextTrack): HTMLElement {
    const card = el('div', { className: 'card' });
    card.appendChild(el('h2', { text: 'Раскладка текста' }));
    const s = track.style;
    // Mode selector: choose which animation mode this track uses.
    const layoutSel = selectField(
      'Режим',
      RENDERER_LIST.map((r) => [r.id, r.label] as [string, string]),
      s.layout,
      (v) => mutateStyle((x) => (x.layout = v as TextStyle['layout'])),
    );
    trackFields.push({ get: (st) => st.layout, field: layoutSel as Field<unknown> });
    card.appendChild(layoutSel.root);
    // The active renderer's setting controls (auto-generated from its spec).
    const renderer = getRenderer(s.layout);
    for (const spec of renderer.settings) {
      card.appendChild(buildRendererSettingControl(renderer.id, spec, track).root);
    }
    lastLayout = s.layout;
    return card;
  }

  /** Rebuild all per-track cards for the current active track. */
  function rebuildTrackCards(): void {
    const project = store.getProject();
    const track = getActiveTrack(project);
    trackFields = [];
    trackHost.innerHTML = '';
    const header = el('div', { className: 'card' });
    header.appendChild(el('h2', { text: track.type === 'audio' ? 'Аудиодорожка' : 'Текстовая дорожка' }));
    const nameLab = el('label', { className: 'field' });
    nameLab.appendChild(el('span', { text: 'Название дорожки' }));
    const nameInput = el('input') as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.value = track.name;
    nameInput.addEventListener('input', () => store.mutate((p) => (getActiveTrack(p).name = nameInput.value)));
    nameLab.appendChild(nameInput);
    trackFields.push({
      get: (_st, t) => t.name,
      field: {
        root: nameLab,
        set: (v) => {
          if (document.activeElement !== nameInput && nameInput.value !== v) nameInput.value = String(v);
        },
      },
    });
    header.appendChild(nameLab);
    trackHost.appendChild(header);

    // Text-specific cards only when a text track is active. Audio tracks have
    // no text settings yet — hide the per-track panels.
    if (track.type === 'text') {
      trackHost.appendChild(buildBase(track.style));
      trackHost.appendChild(buildStroke(track.style));
      trackHost.appendChild(buildLayout(track));
    }
    lastActiveTrackId = project.activeTrackId;
  }

  // ---------- PROJECT-LEVEL CARDS ----------

  function buildBg(bg: Background): void {
    bgCardEl.innerHTML = '';
    bgCardEl.appendChild(el('h2', { text: 'Фон (общий)' }));
    const typeSel = selectField('Тип фона', [['color', 'Цвет'], ['gradient', 'Градиент'], ['image', 'Картинка']], bg.bgType, (v) => mutateBg((x) => (x.bgType = v as BgType)));
    projFields.push({ get: (p) => p.background.bgType, field: typeSel as Field<unknown> });
    bgCardEl.appendChild(typeSel.root);

    if (bg.bgType === 'color') {
      const f = colorField('Цвет фона', bg.bgColor, (v) => mutateBg((x) => (x.bgColor = v)));
      projFields.push({ get: (p) => p.background.bgColor, field: f as Field<unknown> });
      bgCardEl.appendChild(f.root);
    } else if (bg.bgType === 'gradient') {
      const top = colorField('Сверху', bg.bgColors[0], (v) => mutateBg((x) => (x.bgColors = [v, x.bgColors[1]])));
      const bot = colorField('Снизу', bg.bgColors[1], (v) => mutateBg((x) => (x.bgColors = [x.bgColors[0], v])));
      projFields.push({ get: (p) => p.background.bgColors[0], field: top as Field<unknown> });
      projFields.push({ get: (p) => p.background.bgColors[1], field: bot as Field<unknown> });
      bgCardEl.appendChild(top.root);
      bgCardEl.appendChild(bot.root);
    } else {
      const lab = el('label', { className: 'field' });
      lab.appendChild(el('span', { text: 'Файл картинки' }));
      const file = el('input') as HTMLInputElement;
      file.type = 'file';
      file.accept = 'image/*';
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        const dataUrl = await fileToDataUrl(f);
        mutateBg((x) => (x.bgImageDataUrl = dataUrl));
        invalidateBgImageCache();
      });
      lab.appendChild(file);
      bgCardEl.appendChild(lab);
      if (bg.bgImageDataUrl) {
        bgCardEl.appendChild(el('div', { className: 'hint', text: 'Картинка загружена. Смените тип фона, чтобы применить.' }));
      }
    }
  }

  function buildProjectLayout(project: Project): void {
    layoutCardEl.innerHTML = '';
    layoutCardEl.appendChild(el('h2', { text: 'Проект и экспорт' }));

    const res = selectField('Разрешение', [['1920x1080', '1920×1080 (Full HD)'], ['1280x720', '1280×720 (HD)']], `${project.width}x${project.height}`, (v) => {
      const [w, h] = v.split('x').map((n) => parseInt(n, 10));
      store.mutate((pr) => {
        pr.width = w;
        pr.height = h;
      });
    });
    projFields.push({ get: (pr) => `${pr.width}x${pr.height}`, field: res as Field<unknown> });
    layoutCardEl.appendChild(res.root);

    const fps = numberField('FPS', project.fps, 15, 60, 1, (v) => store.mutate((pr) => (pr.fps = Math.round(v))));
    projFields.push({ get: (pr) => pr.fps, field: fps as Field<unknown> });
    layoutCardEl.appendChild(fps.root);
  }

  function rebuildProjectCards(): void {
    const project = store.getProject();
    projFields.length = 0;
    buildBg(project.background);
    lastBgType = project.background.bgType;
    buildProjectLayout(project);
  }

  function syncFromStore(): void {
    const project = store.getProject();
    const track = getActiveTrack(project);
    const isText = track.type === 'text';
    // Layout trigger applies to text tracks only (audio tracks have no layout).
    const layoutKey = isText ? track.style.layout : '';
    const needRebuild = project.activeTrackId !== lastActiveTrackId || layoutKey !== lastLayout;

    // Per-track cards: rebuild ONLY when the active track or the layout mode
    // changes, so dragging a slider within a track doesn't tear down the panel.
    if (needRebuild) {
      rebuildTrackCards();
    } else if (isText) {
      // Sync every per-track field's value in place (text track only).
      const tt = track;
      for (const { get, field } of trackFields) field.set(get(tt.style, tt));
    }

    // Background card: rebuild ONLY when bg type flips.
    if (project.background.bgType !== lastBgType) {
      buildBg(project.background);
      lastBgType = project.background.bgType;
    }

    // Project-level fields (bg colors, resolution, fps).
    for (const { get, field } of projFields) field.set(get(project));
  }

  // Initial build.
  root.appendChild(trackHost);
  root.appendChild(bgCardEl);
  root.appendChild(layoutCardEl);
  rebuildTrackCards();
  rebuildProjectCards();

  store.subscribe(syncFromStore);

  return { root };
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}
