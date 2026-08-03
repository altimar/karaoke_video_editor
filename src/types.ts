/**
 * Core data model for the karaoke project.
 *
 * Lyrics are a list of lines; each line is a list of syllables. A syllable's
 * `startMs` is the moment it BEGINS to fill. Its end (and thus fill progress)
 * is implied by the next syllable's start (or the song duration for the very
 * last syllable). Storing only starts keeps editing simple: you drag a marker
 * and the fill of the previous syllable follows automatically.
 */

export interface Syllable {
  /** The text of this syllable, e.g. "Ка" or "Привет," (punctuation is kept). */
  text: string;
  /** Time in ms when this syllable starts to fill. `null` = not timed yet. */
  startMs: number | null;
  /**
   * The delimiter that preceded this syllable in the source text: ' ' (space),
   * '/' (slash), or '' for the first syllable of a line. Stored so the lyrics
   * textarea round-trips losslessly: words separated by spaces keep their
   * spaces, and slashes the user typed to split inside a word are preserved.
   */
  sep?: string;
}

export interface Line {
  syllables: Syllable[];
}

/** The lyrics layouts the renderer supports. */
export type Layout = 'scroller';

export type BgType = 'color' | 'gradient' | 'image';

/** Full visual + layout configuration. Every field here is exposed in the UI. */
export interface Style {
  // --- base text ---
  fontFamily: string;
  fontSize: number; // px at the project's native resolution
  fontWeight: number;
  lineHeight: number; // multiplier
  textAlign: 'left' | 'center' | 'right';
  colorBase: string; // not-yet-filled syllable text color
  colorHighlight: string; // filled / highlighted syllable text color

  // --- stroke & glow ---
  strokeWidth: number; // 0 = none
  strokeColor: string;
  glowBlur: number; // shadowBlur, 0 = none
  glowColor: string;

  // --- background ---
  bgType: BgType;
  bgColor: string; // for 'color'
  bgColors: [string, string]; // for 'gradient' (top -> bottom)
  bgImageDataUrl: string | null; // for 'image' (kept as data URL for save/load)

  // --- layout ---
  layout: Layout;
}

/**
 * Per-renderer settings. Keyed by renderer id (a Layout value), then by the
 * setting key declared in the renderer's `settings` spec. Kept on the Project so
 * it persists across save/load. Missing entries are merged with renderer defaults.
 */
export type RendererSettings = Record<string, Record<string, number | boolean>>;

export interface Project {
  audioFileName: string | null;
  durationMs: number;
  lines: Line[];
  style: Style;
  fps: number;
  width: number;
  height: number;
  /** Whether the waveform track is shown above the timeline. UI-only setting. */
  showWaveform: boolean;
  /** Per-renderer settings (visibleLines for scroller, etc.). Merged with defaults. */
  rendererSettings: RendererSettings;
}

/** Default project used on first load. */
export function createDefaultStyle(): Style {
  return {
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 64,
    fontWeight: 700,
    lineHeight: 1.4,
    textAlign: 'center',
    colorBase: 'rgba(255,255,255,0.35)',
    colorHighlight: '#ffe14d',

    strokeWidth: 3,
    strokeColor: 'rgba(0,0,0,0.85)',
    glowBlur: 24,
    glowColor: 'rgba(255,180,0,0.9)',

    bgType: 'color',
    bgColor: '#0e0f1a',
    bgColors: ['#1a1033', '#0e0f1a'],
    bgImageDataUrl: null,

    layout: 'scroller',
  };
}

export function createDefaultProject(): Project {
  return {
    audioFileName: null,
    durationMs: 0,
    lines: [{ syllables: [{ text: 'Загрузите текст', startMs: null }] }],
    style: createDefaultStyle(),
    fps: 30,
    width: 1920,
    height: 1080,
    showWaveform: true,
    // Must mirror the renderer defaults declared in text_renderers/*.ts.
    rendererSettings: {
      scroller: { visibleLines: 8 },
    },
  };
}
