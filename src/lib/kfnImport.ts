/**
 * KaraFun (.kfn) file importer.
 *
 * Parses a .kfn binary container and extracts:
 *  - Song.ini (lyrics + timings, one or more text effects)
 *  - The embedded audio file (MP3 bytes)
 *
 * A KFN file may contain up to two TEXT effects: ID=1 (main lyrics) and ID=2
 * (alternate). Each becomes an independent text track. Non-text effects
 * (ID=51 background image, ID=62 background video) are ignored. The renderer
 * mode of an imported track is inferred from its `Trajectory` field:
 * `PlainBottomToTop*...` → scroller; absence → classic (fixed slots), using
 * `LineCount` for the slot count and `OffsetX/OffsetY` for the block offset.
 *
 * Timings within one effect are a flat sequence (Sync0..SyncN chunks), but they
 * are LOCAL to that effect — each effect has its own independent Sync array.
 */
import { Line, Syllable, TextStyle, TextTrack, Track, newTrackId, RendererSettings, Background, createBackground, AudioRole } from '../types';
import { trajectoryToPreviewSec } from './text_renderers/scroller';

export interface KfnImportResult {
  project: { tracks: Track[]; background: Background };
  audioByRole: Map<AudioRole, Uint8Array>;
}

interface KfnEntry {
  name: string;
  type: number;
  outLen: number;
  offset: number;
  inLen: number;
  flags: number;
  absOffset: number;
}

/** Parse the KFN binary into directory entries + Song.ini text. */
function parseKfn(data: Uint8Array): { entries: KfnEntry[]; songIni: string } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dec = new TextDecoder();

  // --- Header ---
  if (data[0] !== 0x4b || data[1] !== 0x46 || data[2] !== 0x4e || data[3] !== 0x42) {
    throw new Error('Не KFN файл (отсутствует сигнатура KFNB)');
  }
  let pos = 4;
  while (pos < data.length) {
    const name = dec.decode(data.slice(pos, pos + 4)); pos += 4;
    const dtype = data[pos]; pos++;
    const val = dv.getUint32(pos, true); pos += 4;
    if (dtype === 2) pos += val; // skip string payload
    if (name === 'ENDH') break;
  }

  // --- Directory ---
  const fileCount = dv.getUint32(pos, true); pos += 4;
  const rawEntries: Array<{ name: string; type: number; outLen: number; offset: number; inLen: number; flags: number }> = [];
  for (let i = 0; i < fileCount; i++) {
    const nameLen = dv.getUint32(pos, true); pos += 4;
    const name = dec.decode(data.slice(pos, pos + nameLen)); pos += nameLen;
    const type = dv.getUint32(pos, true);
    const outLen = dv.getUint32(pos + 4, true);
    const offset = dv.getUint32(pos + 8, true);
    const inLen = dv.getUint32(pos + 12, true);
    const flags = dv.getUint32(pos + 16, true);
    pos += 20;
    rawEntries.push({ name, type, outLen, offset, inLen, flags });
  }
  const dirEnd = pos;

  const entries = rawEntries.map((e) => ({ ...e, absOffset: dirEnd + e.offset }));

  const songEntry = entries.find((e) => e.type === 1 || e.name.toLowerCase().endsWith('.ini'));
  if (!songEntry) throw new Error('Song.ini не найден в KFN');
  const songIni = dec.decode(data.slice(songEntry.absOffset, songEntry.absOffset + songEntry.inLen));
  return { entries, songIni };
}

/** One [EffN] section parsed into a flat key→value map. */
interface EffectFields {
  id: number;
  fields: Map<string, string>;
}

/**
 * Split Song.ini into its [EffN] sections. Only text effects (ID=1 or 2) are
 * returned; background/video effects (ID=51/62) are skipped. Section order in
 * the file is preserved.
 */
function parseEffects(songIni: string): EffectFields[] {
  const out: EffectFields[] = [];
  let current: { name: string; fields: Map<string, string> } | null = null;
  // `current.name` is the section name WITHOUT brackets (e.g. "Eff1").
  const isEffect = (name: string): boolean => /^Eff\d+$/.test(name);
  const flush = (): void => {
    if (!current || !isEffect(current.name)) return;
    const id = parseInt(current.fields.get('ID') ?? '0', 10);
    if (id === 1 || id === 2) {
      out.push({ id, fields: current.fields });
    }
  };
  for (const rawLine of songIni.split(/\r?\n/)) {
    const secMatch = rawLine.match(/^\[(\w+)\]\s*$/);
    if (secMatch) {
      flush();
      current = { name: secMatch[1], fields: new Map() };
      continue;
    }
    if (!current) continue;
    const eq = rawLine.indexOf('=');
    if (eq > 0) current.fields.set(rawLine.slice(0, eq), rawLine.slice(eq + 1));
  }
  flush(); // trailing section
  return out;
}

/**
 * Extract the background image from an ID=51 effect, if present. Looks up the
 * effect's `LibImage` filename among the container's image entries (type 3),
 * reads the raw bytes and converts them to a data URL. Returns null when there
 * is no background image effect or the referenced file is missing.
 */
function extractBackground(songIni: string, entries: KfnEntry[], data: Uint8Array): Background | null {
  // Find an ID=51 effect and its LibImage reference.
  let libImage: string | null = null;
  let current: { name: string; fields: Map<string, string> } | null = null;
  const isEffect = (name: string): boolean => /^Eff\d+$/.test(name);
  const flush = (): void => {
    if (!current || !isEffect(current.name)) return;
    const id = parseInt(current.fields.get('ID') ?? '0', 10);
    if (id === 51) libImage = (current.fields.get('LibImage') ?? '').trim() || null;
  };
  for (const rawLine of songIni.split(/\r?\n/)) {
    const secMatch = rawLine.match(/^\[(\w+)\]\s*$/);
    if (secMatch) {
      flush();
      current = { name: secMatch[1], fields: new Map() };
      continue;
    }
    if (!current) continue;
    const eq = rawLine.indexOf('=');
    if (eq > 0) current.fields.set(rawLine.slice(0, eq), rawLine.slice(eq + 1));
  }
  flush();
  if (!libImage) return null;

  // Find the image file in the container (by name or any type=3 entry).
  const imgEntry =
    entries.find((e) => e.name === libImage) ?? entries.find((e) => e.type === 3);
  if (!imgEntry) return null;

  const bytes = data.slice(imgEntry.absOffset, imgEntry.absOffset + imgEntry.inLen);
  const ext = imgEntry.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? 'jpg';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  // Convert raw bytes → base64 data URL.
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const dataUrl = `data:image/${mime};base64,${btoa(bin)}`;
  const bg = createBackground();
  bg.bgType = 'image';
  bg.bgImageDataUrl = dataUrl;
  return bg;
}

/**
 * Parse ONE effect's Text{n}/Sync{n} into Lines + Syllables.
 *
 * Sync values within one effect are a flat sequence (Sync0..SyncN chunks cover
 * all syllables of that effect in reading order). Timings are centiseconds
 * (1/100 s); we convert to milliseconds (×10). -1 → untimed (null).
 */
function parseEffectLines(fields: Map<string, string>): Line[] {
  const lines: Line[] = [];
  const textMap = new Map<number, string>();
  let textCount = 0;
  const allSyncs: number[] = []; // flat: Sync0 values, then Sync1, ...

  for (const [key, value] of fields) {
    const textMatch = key.match(/^Text(\d+)$/);
    if (textMatch) {
      textMap.set(parseInt(textMatch[1], 10), value);
      continue;
    }
    if (key === 'TextCount') {
      textCount = parseInt(value, 10);
      continue;
    }
    const syncMatch = key.match(/^Sync(\d+)$/);
    if (syncMatch) {
      const vals = value.split(',').map((v) => parseInt(v.trim(), 10));
      allSyncs.push(...vals);
    }
  }

  const maxIdx = textCount || (textMap.size ? Math.max(...textMap.keys()) : -1);
  let syncIdx = 0;

  for (let i = 0; i <= maxIdx; i++) {
    const text = textMap.get(i) ?? '';

    const syllables: Syllable[] = [];
    let token = '';
    let pendingSep = '';

    const flush = (): void => {
      if (token !== '') {
        syllables.push({
          text: token,
          startMs: syncIdx < allSyncs.length && allSyncs[syncIdx] >= 0 ? allSyncs[syncIdx] * 10 : null,
          sep: pendingSep,
        });
        token = '';
        syncIdx++;
      }
    };

    for (const ch of text) {
      if (ch === '/' || ch === ' ') {
        flush();
        pendingSep = ch;
      } else {
        token += ch;
      }
    }
    flush();

    if (syllables.length > 0 || text === '') {
      lines.push({ syllables });
    }
  }

  return lines;
}

/**
/**
 * Convert a KFN color (`#RRGGBBAA`) to a CSS rgba() string. KaraFun stores colors
 * as Red,Green,Blue,Alpha (verified on real files: `#00ACFFFF` is opaque cyan —
 * RR=00 GG=AC BB=FF AA=FF; `#FF0000FF` is opaque red). This is NOT ARGB despite
 * some references: alpha is the LAST byte.
 */
function argbToCss(kfnColor: string): string {
  const m = /^#([0-9a-fA-F]{8})$/.exec((kfnColor ?? '').trim());
  if (!m) return 'rgba(255,255,255,1)';
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const a = parseInt(m[1].slice(6, 8), 16) / 255;
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Default text style for an imported track (before per-effect overrides).
 * Fields NOT present in the KFN format start neutral/disabled so the imported
 * track doesn't inherit unrelated project defaults. In particular glow (our
 * extra effect with no KFN equivalent) is turned OFF.
 */
function defaultImportedStyle(): TextStyle {
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
    glowBlur: 0, // no KFN equivalent — start disabled
    glowColor: 'rgba(255,180,0,0.9)',
    layout: 'scroller',
  };
}

/** Parse `Font=family*size` (KFN size units; 18 ≈ our 64px). */
function applyFont(style: TextStyle, fontField: string | undefined): void {
  if (!fontField) return;
  const parts = fontField.split('*');
  if (parts[0]) style.fontFamily = `${parts[0]}, sans-serif`;
  if (parts[1]) {
    const kfnSize = parseInt(parts[1], 10);
    if (!Number.isNaN(kfnSize)) style.fontSize = Math.round((kfnSize * 64) / 18);
  }
}

/**
 * Infer a track's renderer mode + settings from an effect's fields.
 * `Trajectory` with PlainBottomToTop → scroller; otherwise classic (fixed
 * slots), using LineCount → lineSlots and OffsetX/OffsetY → offset.
 */
function applyLayout(style: TextStyle, fields: Map<string, string>): RendererSettings {
  const traj = (fields.get('Trajectory') ?? '');
  const trajLc = traj.toLowerCase();
  const settings: RendererSettings = {};
  if (trajLc.includes('bottomtotop') || trajLc.includes('plain')) {
    style.layout = 'scroller';
    // Trajectory = PlainBottomToTop*<param>*… where param = 10 / previewSec.
    const param = parseFloat(traj.split('*')[1] ?? '1') || 1;
    settings.scroller = { previewSec: trajectoryToPreviewSec(param) };
    return settings;
  }
  // No scroll trajectory → classic fixed-slot karaoke.
  style.layout = 'classic';
  const lineCount = parseInt(fields.get('LineCount') ?? '4', 10);
  const lineSlots = Number.isNaN(lineCount) ? 4 : Math.max(2, Math.min(16, lineCount));
  const offX = parseInt(fields.get('OffsetX') ?? '0', 10) || 0;
  const offY = parseInt(fields.get('OffsetY') ?? '0', 10) || 0;
  settings.classic = { lineSlots, fadeMs: 1500, offsetX: offX, offsetY: offY };
  return settings;
}

/** Convert one parsed text effect into an independent TextTrack. */
function effectToTrack(effect: EffectFields, index: number): TextTrack {
  const lines = parseEffectLines(effect.fields);
  const style = defaultImportedStyle();
  applyFont(style, effect.fields.get('Font'));
  // Colors: ActiveColor → highlight (filling), InactiveColor → base.
  if (effect.fields.has('ActiveColor')) style.colorHighlight = argbToCss(effect.fields.get('ActiveColor')!);
  if (effect.fields.has('InactiveColor')) style.colorBase = argbToCss(effect.fields.get('InactiveColor')!);
  if (effect.fields.has('FrameColor')) style.strokeColorActive = argbToCss(effect.fields.get('FrameColor')!);
  if (effect.fields.has('InactiveFrameColor')) style.strokeColorInactive = argbToCss(effect.fields.get('InactiveFrameColor')!);
  // Stroke width: KaraFun encodes it as the FrameType name (Frame1, Frame2, …).
  // Frame0 / none → no outline.
  const frameType = (effect.fields.get('FrameType') ?? '').match(/Frame(\d+)/i);
  if (frameType) style.strokeWidth = parseInt(frameType[1], 10);
  const rendererSettings = applyLayout(style, effect.fields);
  // Track name: KaraFun stores it in Caption. Fall back to a sensible default.
  const caption = (effect.fields.get('Caption') ?? '').trim();
  const name = caption || (effect.id === 1 ? 'Основная' : effect.id === 2 ? 'Альтернативная' : `Дорожка ${index + 1}`);
  return {
    id: newTrackId(),
    name,
    type: 'text',
    lines,
    style,
    rendererSettings,
  };
}

/**
 * Import a .kfn file: extract audio + lyrics/timings. Text effects (ID=1/2)
 * become text tracks. The main audio (`[General] Source`, instrumental) becomes
 * the 'minus' role; a `[MP3Music] Track0` (backing vocals) becomes the 'back'
 * role. Returns the project's tracks + per-role raw audio bytes.
 */
export function importFromKfn(data: Uint8Array): KfnImportResult {
  const parsed = parseKfn(data);
  const { entries, songIni } = parsed;
  const effects = parseEffects(songIni);
  const textTracks = effects
    .map((eff, i) => effectToTrack(eff, i))
    .filter((t) => t.lines.some((l) => l.syllables.length > 0));
  if (textTracks.length === 0) throw new Error('В KFN не найдено текстовых дорожек');

  // Parse [General] Source (instrumental → minus) and [MP3Music] Track0 (→ back).
  const sourceName = (songIni.match(/^Source=1,I,(.+)$/m)?.[1] ?? '').trim();
  const track0Name = (songIni.match(/^Track0=([^,]+)/m)?.[1] ?? '').trim();
  const audioByRole = new Map<AudioRole, Uint8Array>();
  if (sourceName) {
    const entry = entries.find((e) => e.name === sourceName);
    if (entry) audioByRole.set('minus', data.slice(entry.absOffset, entry.absOffset + entry.inLen));
  }
  if (track0Name) {
    const entry = entries.find((e) => e.name === track0Name);
    if (entry) audioByRole.set('back', data.slice(entry.absOffset, entry.absOffset + entry.inLen));
  }

  // Build the three fixed audio-role tracks; fill filenames from what was found.
  const audioTracks: Track[] = [
    makeAudio('original'),
    makeAudio('minus', audioByRole.has('minus') ? sourceName : ''),
    makeAudio('back', audioByRole.has('back') ? track0Name : ''),
  ];

  const tracks: Track[] = [...textTracks, ...audioTracks];
  const background = extractBackground(songIni, entries, data) ?? createBackground();
  return { project: { tracks, background }, audioByRole };
}

/** Helper: build an audio track for a role (empty audioFileName = no audio). */
function makeAudio(role: AudioRole, audioFileName = ''): Track {
  return {
    id: newTrackId(),
    name: role === 'original' ? 'Оригинал' : role === 'minus' ? 'Минус' : 'Бэк',
    type: 'audio',
    role,
    audioFileName,
    volumeAutomation: [],
  };
}
