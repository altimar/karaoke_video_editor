/**
 * Core data model for the karaoke project.
 *
 * Lyrics are a list of lines; each line is a list of syllables. A syllable's
 * `startMs` is the moment it BEGINS to fill. Its end (and thus fill progress)
 * is implied by the next syllable's start (or the song duration for the very
 * last syllable). Storing only starts keeps editing simple: you drag a marker
 * and the fill of the previous syllable follows automatically.
 *
 * A project has ONE OR MORE text tracks (`TextTrack`). Each track is fully
 * independent: its own lyrics (lines), text style (font, colors, stroke/glow),
 * layout mode and per-renderer settings. Tracks render on top of a shared
 * background; they may overlap visually. Exactly one track is "active" at a
 * time — it is the target of text editing, timing capture and timeline dragging.
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
export type Layout = 'scroller' | 'classic';

export type BgType = 'color' | 'gradient' | 'image' | 'video';

/**
 * How an image/video background is mapped onto the canvas:
 * - 'cover'   — preserve aspect, scale to fill, crop the excess (centered);
 * - 'stretch' — fill the canvas exactly, distorting the aspect ratio;
 * - 'contain' — fit entirely inside, letterboxed by the bg color/gradient.
 */
export type BgFit = 'cover' | 'stretch' | 'contain';

/**
 * Text-level visual configuration for ONE track (font, colors, stroke/glow,
 * layout). Every field here is exposed in the UI and is independent per track.
 * Background is NOT part of this — it is shared at the project level.
 */
export interface TextStyle {
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
  strokeColorActive: string; // outline of a filled / active syllable (KFN FrameColor)
  strokeColorInactive: string; // outline of an unfilled syllable (KFN InactiveFrameColor)
  glowBlur: number; // shadowBlur, 0 = none
  glowColor: string;

  // --- layout ---
  layout: Layout;
}

/**
 * Shared background configuration for the whole project. Drawn once per frame
 * behind every text track.
 */
export interface Background {
  bgType: BgType;
  bgColor: string; // for 'color'
  bgColors: [string, string]; // for 'gradient' (top -> bottom)
  bgImageDataUrl: string | null; // for 'image' (kept as data URL for save/load)
  /** for 'video' — filename marker; the MP4 bytes live outside the project JSON
   * (src/lib/backgroundVideo.ts), exactly like per-role audio bytes. */
  bgVideoFileName: string | null;
  /** How image/video backgrounds fill the canvas. Defaults to 'cover'. */
  bgFit: BgFit;
}

/**
 * Per-renderer settings. Keyed by renderer id (a Layout value), then by the
 * setting key declared in the renderer's `settings` spec. Kept on the track so
 * it persists across save/load. Missing entries are merged with renderer defaults.
 */
export type RendererSettings = Record<string, Record<string, number | boolean>>;

/**
 * Base for all track kinds. A `type` discriminator narrows to a concrete shape
 * (text, audio, …). Tracks render/operate independently; exactly one is active
 * at a time (editing, recording, timeline dragging target it).
 */
export interface BaseTrack {
  /** Stable unique id (used to identify the active track and in save/load). */
  id: string;
  /** Human-readable name shown in the track switcher. */
  name: string;
  /** Discriminator — narrows this BaseTrack to a concrete track kind. */
  type: 'text' | 'audio';
}

/**
 * One independent text track. Holds its own lyrics, text style and renderer
 * settings. Renders on top of the shared background, in array order, and may
 * overlap with other text tracks. Editing, timing capture and timeline dragging
 * operate on the project's active track (when it is a text track).
 */
export interface TextTrack extends BaseTrack {
  type: 'text';
  lines: Line[];
  style: TextStyle;
  /** Per-renderer settings (visibleLines for scroller, etc.). Merged with defaults. */
  rendererSettings: RendererSettings;
}

/**
 * One independent audio track. Holds the reference to its source audio file and
 * the volume-automation envelope. Audio bytes themselves are kept OUTSIDE the
 * project (in the audio engine / controls) so the model stays light; the track
 * stores the filename + automation only. Does not render to the video frame.
 *
 * A project has four fixed audio roles:
 *  - 'original' — the full reference mix, used for timing capture only.
 *  - 'minus'    — the instrumental (vocals removed); mixed into the video export.
 *  - 'back'     — backing vocals; mixed into the video export.
 *  - 'lead'     — the lead vocal (extracted by Mel-RoFormer); audible in editor
 *                 playback but NOT mixed into the video export.
 * Roles can't be renamed.
 */
export type AudioRole = 'original' | 'minus' | 'back' | 'lead';

export interface AudioTrack extends BaseTrack {
  type: 'audio';
  /** Fixed role (original/minus/back/lead). Names and playback semantics follow it. */
  role: AudioRole;
  /** Source audio filename; empty string = no audio loaded in this slot. */
  audioFileName: string;
  /**
   * Volume automation points: time in ms + linear gain (0 = mute, 1 = original,
   * 2 = double). Sorted by timeMs; empty = no automation (flat gain 1.0).
   */
  volumeAutomation: VolumePoint[];
  /** Mute: when true the role plays at gain 0 and is excluded from the MP4 export. */
  muted: boolean;
  /** Solo: when true (on any role) only solo-ed roles are audible / exported. */
  solo: boolean;
}

/** Any track kind (text, audio, …). Narrow via the `type` discriminator. */
export type Track = TextTrack | AudioTrack;

export interface Project {
  durationMs: number;
  /** All tracks (text, audio, …), in display order. */
  tracks: Track[];
  /** Id of the track currently targeted by editing/recording/timeline. */
  activeTrackId: string;
  /** Shared background, drawn behind every track. */
  background: Background;
  fps: number;
  width: number;
  height: number;
}

/** One point on the volume automation envelope. */
export interface VolumePoint {
  timeMs: number;
  gain: number;
}

/** Default text style used when a new track is created. */
export function createTextStyle(): TextStyle {
  return {
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 64,
    fontWeight: 700,
    lineHeight: 1.4,
    textAlign: 'center',
    colorBase: 'rgba(255,255,255,0.35)',
    colorHighlight: '#ffe14d',

    strokeWidth: 3,
    strokeColorActive: 'rgba(0,0,0,0.85)',
    strokeColorInactive: 'rgba(1,1,1,0.85)',
    glowBlur: 24,
    glowColor: 'rgba(255,180,0,0.9)',

    layout: 'scroller',
  };
}

/** Default shared background used for new projects. */
export function createBackground(): Background {
  return {
    bgType: 'color',
    bgColor: '#0e0f1a',
    bgColors: ['#1a1033', '#0e0f1a'],
    bgImageDataUrl: null,
    bgVideoFileName: null,
    bgFit: 'cover',
  };
}

/** Generate a unique id for a new track. Uses crypto.randomUUID when available. */
export function newTrackId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'track-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Default per-renderer settings for a fresh track. */
function defaultRendererSettings(): RendererSettings {
  // Must mirror the renderer defaults declared in text_renderers/*.ts.
  return {
    scroller: { previewSec: 10 },
    classic: { lineSlots: 4, fadeMs: 1500, offsetX: 0, offsetY: 0 },
  };
}

/**
 * Create a new independent text track. `name` defaults to "Дорожка N" by the
 * caller (who knows how many tracks already exist); pass an explicit name to
 * override.
 */
export function createTextTrack(name: string, lines?: Line[]): TextTrack {
  return {
    id: newTrackId(),
    name,
    type: 'text',
    lines: lines ?? [{ syllables: [{ text: 'Загрузите текст', startMs: null }] }],
    style: createTextStyle(),
    rendererSettings: defaultRendererSettings(),
  };
}

/** Human-readable name for an audio role (also the track name; roles can't be renamed). */
export const AUDIO_ROLE_NAMES: Record<AudioRole, string> = {
  original: 'Оригинал',
  lead: 'Вокал',
  minus: 'Минус',
  back: 'Бэк',
};

/** Create a new audio track for a role with no audio loaded (flat gain 1.0). */
export function createAudioTrack(role: AudioRole, audioFileName = ''): AudioTrack {
  return {
    id: newTrackId(),
    name: AUDIO_ROLE_NAMES[role],
    type: 'audio',
    role,
    audioFileName,
    volumeAutomation: [],
    muted: false,
    solo: false,
  };
}

/**
 * The track currently targeted by editing/recording/timeline (any type).
 * Falls back to the first track if the active id is stale (e.g. after a delete).
 */
export function getActiveTrack(project: Project): Track {
  return project.tracks.find((t) => t.id === project.activeTrackId) ?? project.tracks[0];
}

/** All text tracks (in display order). */
export function getTextTracks(project: Project): TextTrack[] {
  return project.tracks.filter((t): t is TextTrack => t.type === 'text');
}

/** All audio tracks (in display order). */
export function getAudioTracks(project: Project): AudioTrack[] {
  return project.tracks.filter((t): t is AudioTrack => t.type === 'audio');
}

/**
 * The active track IF it is a text track, else null. For text-only consumers
 * (lyrics editor, timing capture, style panel) that have nothing to do when an
 * audio track is active.
 */
export function getActiveTextTrack(project: Project): TextTrack | null {
  const t = getActiveTrack(project);
  return t.type === 'text' ? t : null;
}

/** The active audio track, else the first audio track, else null. */
export function getActiveAudioTrack(project: Project): AudioTrack | null {
  const t = getActiveTrack(project);
  if (t.type === 'audio') return t;
  return getAudioTracks(project)[0] ?? null;
}

/** Look up a text track by id; null if missing or not a text track. */
export function getTextTrack(project: Project, id: string): TextTrack | null {
  const t = project.tracks.find((tr) => tr.id === id);
  return t && t.type === 'text' ? t : null;
}

/** The audio track for a role, or null if none. */
export function getAudioTrackByRole(project: Project, role: AudioRole): AudioTrack | null {
  return getAudioTracks(project).find((t) => t.role === role) ?? null;
}

/**
 * Whether a loaded audio role is audible under the current mute/solo state.
 * A role is audible when it is NOT muted AND (no role is solo-ed, OR it is solo).
 * Used by both the playback engine and the MP4 export to pick the same set.
 */
export function isRoleAudible(project: Project, role: AudioRole): boolean {
  const at = getAudioTrackByRole(project, role);
  if (!at || !at.audioFileName) return false;
  if (at.muted) return false;
  const anySolo = getAudioTracks(project).some((t) => t.solo && t.audioFileName);
  return !anySolo || at.solo;
}

/** Default project used on first load: one text track + the four fixed audio slots. */
export function createDefaultProject(): Project {
  const track = createTextTrack('Дорожка 1');
  const audio = [
    createAudioTrack('original'),
    createAudioTrack('lead'),
    createAudioTrack('minus'),
    createAudioTrack('back'),
  ];
  return {
    durationMs: 0,
    tracks: [track, ...audio],
    activeTrackId: track.id,
    background: createBackground(),
    fps: 30,
    width: 1920,
    height: 1080,
  };
}
