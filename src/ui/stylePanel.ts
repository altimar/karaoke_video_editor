/**
 * Style & effects panel.
 *
 * IMPORTANT: the panel is built ONCE, and individual controls are updated in
 * place when the store changes (via setter callbacks). We must NOT rebuild the
 * DOM on every store change, because doing so while the user is dragging a
 * range slider would destroy the element under the pointer and break the drag —
 * which was the original bug ("sliders only work on click, not drag").
 *
 * Each field builder returns its root element plus a `set(v)` function that
 * pushes a new value into the control WITHOUT firing its change handler (so we
 * don't create feedback loops).
 */
import { store } from '../state/store';
import { BgType, Project, Style } from '../types';
import { invalidateBgImageCache } from '../lib/render';
import { getRenderer } from '../lib/text_renderers/registry';
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

  // Build the static skeleton once: cards with placeholders we can swap content
  // into depending on conditional state (bg type, layout). Conditional blocks
  // are rebuilt only when their condition changes — never on plain value edits.
  const baseCardEl = el('div', { className: 'card' });
  const strokeCardEl = el('div', { className: 'card' });
  const bgCardEl = el('div', { className: 'card' });
  const layoutCardEl = el('div', { className: 'card' });

  // References to all value-bearing fields, so the store subscription can sync them.
  const fields: Array<{ get: (s: Style, p: Project) => string | number | boolean; field: Field<unknown> }> = [];

  // Track the last-seen condition values for conditional blocks, so we only
  // rebuild them when the condition actually flips.
  let lastBgType: string | null = null;
  let lastLayout: string | null = null;

  function mutate(fn: (s: Style) => void): void {
    store.mutate((p) => fn(p.style));
  }

  /**
   * Build a control for one renderer setting, wired to project.rendererSettings.
   * Number specs → slider; boolean specs → checkbox. Returns a Field so it syncs
   * in place on store changes (no DOM rebuild while dragging).
   */
  function buildRendererSettingControl(rendererId: string, spec: RenderSettingSpec, p: Project): Field<unknown> {
    const read = (): number | boolean => {
      const v = p.rendererSettings?.[rendererId]?.[spec.key];
      return v !== undefined ? v : spec.default;
    };
    if (spec.kind === 'boolean') {
      const lab = el('label', { className: 'field' });
      lab.appendChild(el('span', { text: spec.label }));
      const cb = el('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = Boolean(read());
      cb.addEventListener('change', () => store.mutate((pr) => setSetting(pr, rendererId, spec.key, cb.checked)));
      lab.appendChild(cb);
      fields.push({
        get: (_st, pr) => {
          const v = pr.rendererSettings?.[rendererId]?.[spec.key];
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
      store.mutate((pr) => setSetting(pr, rendererId, spec.key, v)),
    );
    fields.push({
      get: (_st, pr) => {
        const v = pr.rendererSettings?.[rendererId]?.[spec.key];
        return v !== undefined ? v : spec.default;
      },
      field: f as Field<unknown>,
    });
    return f as Field<unknown>;
  }

  /** Ensure the settings object exists, then set one key. */
  function setSetting(pr: Project, rendererId: string, key: string, value: number | boolean): void {
    if (!pr.rendererSettings) pr.rendererSettings = {};
    if (!pr.rendererSettings[rendererId]) pr.rendererSettings[rendererId] = {};
    pr.rendererSettings[rendererId][key] = value;
  }

  function buildBase(s: Style): void {
    baseCardEl.innerHTML = '';
    baseCardEl.appendChild(el('h2', { text: 'Текст' }));

    const ffLab = el('label', { className: 'field' });
    ffLab.appendChild(el('span', { text: 'Шрифт' }));
    const ff = el('input') as HTMLInputElement;
    ff.value = s.fontFamily;
    let focused = false;
    ff.addEventListener('focus', () => (focused = true));
    ff.addEventListener('blur', () => (focused = false));
    ff.addEventListener('input', () => mutate((x) => (x.fontFamily = ff.value)));
    ffLab.appendChild(ff);
    fields.push({
      get: (st) => st.fontFamily,
      field: {
        root: ffLab,
        set: (v) => {
          if (!focused && ff.value !== v) ff.value = String(v);
        },
      },
    });
    baseCardEl.appendChild(ffLab);

    const addNum = (label: string, min: number, max: number, step: number, get: (s: Style) => number, set: (s: Style, v: number) => void): void => {
      const f = numberField(label, get(s), min, max, step, (v) => mutate((x) => set(x, v)));
      fields.push({ get: (st) => get(st), field: f as Field<unknown> });
      baseCardEl.appendChild(f.root);
    };
    addNum('Размер', 16, 200, 1, (st) => st.fontSize, (st, v) => (st.fontSize = v));
    addNum('Межстрочный', 0.8, 3, 0.05, (st) => st.lineHeight, (st, v) => (st.lineHeight = v));

    const align = selectField('Выравнивание', [['left', 'Слева'], ['center', 'Центр'], ['right', 'Справа']], s.textAlign, (v) => mutate((x) => (x.textAlign = v as Style['textAlign'])));
    fields.push({ get: (st) => st.textAlign, field: align as Field<unknown> });
    baseCardEl.appendChild(align.root);

    const colors = el('div', { className: 'row2' });
    const cb = colorField('Цвет базовый', s.colorBase, (v) => mutate((x) => (x.colorBase = v)));
    const ch = colorField('Цвет заливки', s.colorHighlight, (v) => mutate((x) => (x.colorHighlight = v)));
    fields.push({ get: (st) => st.colorBase, field: cb as Field<unknown> });
    fields.push({ get: (st) => st.colorHighlight, field: ch as Field<unknown> });
    colors.appendChild(cb.root);
    colors.appendChild(ch.root);
    baseCardEl.appendChild(colors);

    const weights = el('div', { className: 'row2' });
    const wf = selectField('Начертание', [['400', 'Обычный'], ['600', 'Полужирный'], ['700', 'Жирный'], ['900', 'Чёрный']], String(s.fontWeight), (v) => mutate((x) => (x.fontWeight = parseInt(v, 10))));
    fields.push({ get: (st) => String(st.fontWeight), field: wf as Field<unknown> });
    weights.appendChild(wf.root);
    baseCardEl.appendChild(weights);
  }

  function buildStroke(s: Style): void {
    strokeCardEl.innerHTML = '';
    strokeCardEl.appendChild(el('h2', { text: 'Обводка и свечение' }));
    const sw = numberField('Обводка', s.strokeWidth, 0, 20, 0.5, (v) => mutate((x) => (x.strokeWidth = v)));
    fields.push({ get: (st) => st.strokeWidth, field: sw as Field<unknown> });
    strokeCardEl.appendChild(sw.root);
    const sc = colorField('Цвет обводки', s.strokeColor, (v) => mutate((x) => (x.strokeColor = v)));
    fields.push({ get: (st) => st.strokeColor, field: sc as Field<unknown> });
    strokeCardEl.appendChild(sc.root);
    const gb = numberField('Свечение', s.glowBlur, 0, 80, 1, (v) => mutate((x) => (x.glowBlur = v)));
    fields.push({ get: (st) => st.glowBlur, field: gb as Field<unknown> });
    strokeCardEl.appendChild(gb.root);
    const gc = colorField('Цвет свечения', s.glowColor, (v) => mutate((x) => (x.glowColor = v)));
    fields.push({ get: (st) => st.glowColor, field: gc as Field<unknown> });
    strokeCardEl.appendChild(gc.root);
  }

  function buildBg(s: Style): void {
    bgCardEl.innerHTML = '';
    bgCardEl.appendChild(el('h2', { text: 'Фон' }));
    const typeSel = selectField('Тип фона', [['color', 'Цвет'], ['gradient', 'Градиент'], ['image', 'Картинка']], s.bgType, (v) => mutate((x) => (x.bgType = v as BgType)));
    fields.push({ get: (st) => st.bgType, field: typeSel as Field<unknown> });
    bgCardEl.appendChild(typeSel.root);

    if (s.bgType === 'color') {
      const f = colorField('Цвет фона', s.bgColor, (v) => mutate((x) => (x.bgColor = v)));
      fields.push({ get: (st) => st.bgColor, field: f as Field<unknown> });
      bgCardEl.appendChild(f.root);
    } else if (s.bgType === 'gradient') {
      const top = colorField('Сверху', s.bgColors[0], (v) => mutate((x) => (x.bgColors = [v, x.bgColors[1]])));
      const bot = colorField('Снизу', s.bgColors[1], (v) => mutate((x) => (x.bgColors = [x.bgColors[0], v])));
      fields.push({ get: (st) => st.bgColors[0], field: top as Field<unknown> });
      fields.push({ get: (st) => st.bgColors[1], field: bot as Field<unknown> });
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
        mutate((x) => (x.bgImageDataUrl = dataUrl));
        invalidateBgImageCache();
      });
      lab.appendChild(file);
      bgCardEl.appendChild(lab);
      if (s.bgImageDataUrl) {
        bgCardEl.appendChild(el('div', { className: 'hint', text: 'Картинка загружена. Смените тип фона, чтобы применить.' }));
      }
    }
  }

  function buildLayout(s: Style, p: Project): void {
    layoutCardEl.innerHTML = '';
    layoutCardEl.appendChild(el('h2', { text: 'Раскладка и экспорт' }));
    // The active renderer's setting controls (auto-generated from its spec).
    const renderer = getRenderer(s.layout);
    for (const spec of renderer.settings) {
      layoutCardEl.appendChild(buildRendererSettingControl(renderer.id, spec, p).root);
    }

    const res = selectField('Разрешение', [['1920x1080', '1920×1080 (Full HD)'], ['1280x720', '1280×720 (HD)']], `${p.width}x${p.height}`, (v) => {
      const [w, h] = v.split('x').map((n) => parseInt(n, 10));
      store.mutate((pr) => {
        pr.width = w;
        pr.height = h;
      });
    });
    fields.push({ get: (_st, pr) => `${pr.width}x${pr.height}`, field: res as Field<unknown> });
    layoutCardEl.appendChild(res.root);

    const fps = numberField('FPS', p.fps, 15, 60, 1, (v) => store.mutate((pr) => (pr.fps = Math.round(v))));
    fields.push({ get: (_st, pr) => pr.fps, field: fps as Field<unknown> });
    layoutCardEl.appendChild(fps.root);

    // Waveform visibility toggle (UI-only setting, lives on the project).
    const waveLab = el('label', { className: 'field' });
    waveLab.appendChild(el('span', { text: 'Волна на таймлайне' }));
    const waveCb = el('input') as HTMLInputElement;
    waveCb.type = 'checkbox';
    waveCb.checked = p.showWaveform;
    waveCb.addEventListener('change', () => store.mutate((pr) => (pr.showWaveform = waveCb.checked)));
    waveLab.appendChild(waveCb);
    fields.push({
      get: (_st, pr) => pr.showWaveform,
      field: {
        root: waveLab,
        set: (v) => {
          if (waveCb.checked !== v) waveCb.checked = Boolean(v);
        },
      },
    });
    layoutCardEl.appendChild(waveLab);
  }

  function rebuildAll(): void {
    const { style, ...rest } = store.getProject() as Project;
    const project = { style, ...rest };
    fields.length = 0; // clear references; conditional rebuilds repopulate
    buildBase(style);
    buildStroke(style);
    buildBg(style);
    buildLayout(style, project);
    lastBgType = style.bgType;
    lastLayout = style.layout;
  }

  function syncFromStore(): void {
    const project = store.getProject();
    const s = project.style;

    // Conditional blocks: rebuild ONLY when their condition flips (not on every
    // value tweak), so dragging a slider doesn't tear down the panel.
    if (s.bgType !== lastBgType) {
      buildBg(s);
      lastBgType = s.bgType;
    }
    if (s.layout !== lastLayout) {
      buildLayout(s, project);
      lastLayout = s.layout;
    }

    // Sync every field's value in place (setters only touch .value when needed).
    for (const { get, field } of fields) {
      field.set(get(s, project));
    }
  }

  // Initial build.
  rebuildAll();
  root.appendChild(baseCardEl);
  root.appendChild(strokeCardEl);
  root.appendChild(bgCardEl);
  root.appendChild(layoutCardEl);

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
