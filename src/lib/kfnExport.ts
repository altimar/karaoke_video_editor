/**
 * KaraFun (.kfn) file exporter.
 *
 * The .kfn format is a binary container with:
 *  1. Header: magic "KFNB" + ID3-style blocks (4-char name, 1-byte type, 4-byte value/length).
 *  2. Directory: file count + entries (filename, type, sizes, offset, flags).
 *  3. File data: raw bytes (MP3, Song.ini, optional images) stored as-is.
 *
 * Lyrics and timings live in Song.ini (a text INI file inside the container).
 * Timings are in centiseconds (1/100 of a second).
 *
 * Structure reverse-engineered by George Yunaev (ulduzsoft.com) and verified
 * against real .kfn sample files.
 */
import { Project, TextTrack } from '../types';
import { getTextTracks, getAudioTrackByRole, AudioRole } from '../types';
import { ExportCanceledError } from './exportErrors';
import { previewSecToTrajectory } from './text_renderers/scroller';

/** Max outline thickness KaraFun Studio supports (Frame0..Frame5). */
const KFN_MAX_FRAME = 5;

/**
 * Warnings about project settings that don't map cleanly to the KaraFun format,
 * computed WITHOUT building the file. Used to preview issues in the export
 * dialog's KaraFun tab before the user starts the export. The same conditions
 * are re-checked during export (in case the project changes between preview
 * and export) and surfaced via the result's `warnings`.
 */
export function collectKfnWarnings(project: Project): string[] {
  const warnings: string[] = [];
  const textTracks = getTextTracks(project);
  if (textTracks.length > 2) {
    warnings.push(
      `В проекте ${textTracks.length} текстовых дорожек, а KaraFun поддерживает максимум 2 текстовых эффекта. ` +
        `Лишние дорожки экспортированы, но KaraFun может их не показать.`,
    );
  }
  // KFN export needs at least the minus (instrumental) audio; warn if empty.
  const minus = getAudioTrackByRole(project, 'minus');
  if (!minus || !minus.audioFileName) {
    warnings.push('Дорожка «минус» пуста — экспорт KaraFun будет без инструментала (Source).');
  }
  // Video background: we embed MP4, but the KFN spec only lists wmv/avi/mpg
  // for type-5 files — KaraFun's player may refuse to play it.
  if (project.background.bgType === 'video' && project.background.bgVideoFileName) {
    warnings.push(
      'Видео-фон вшивается как MP4; KaraFun официально поддерживает только WMV/AVI/MPG — плеер KaraFun может его не показать.',
    );
  }
  for (const track of textTracks) {
    if (track.style.layout !== 'scroller' && track.style.layout !== 'classic') {
      warnings.push(
        `Дорожка «${track.name}»: режим «${track.style.layout}» не поддерживается KaraFun, ` +
          `экспортирован как скроллер (эффекты могут отличаться).`,
      );
    }
    const strokeW = Math.max(0, Math.round(track.style.strokeWidth));
    if (strokeW > KFN_MAX_FRAME) {
      warnings.push(
        `Дорожка «${track.name}»: толщина обводки ${strokeW} превышает максимум KaraFun (${KFN_MAX_FRAME}); ` +
          `экспортировано ${KFN_MAX_FRAME}.`,
      );
    }
  }
  return warnings;
}

/** Build the binary header. All fields are mandatory for KaraFun compatibility. */
function buildHeader(title: string, artist: string, source: string): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];

  /** Add a block with an integer value (type 0x01). */
  const addInt = (name: string, value: number): void => {
    const b = new Uint8Array(9);
    for (let i = 0; i < 4; i++) b[i] = name.charCodeAt(i);
    b[4] = 0x01;
    new DataView(b.buffer).setUint32(5, value >>> 0, true);
    blocks.push(b);
  };

  /** Add a block with a string value (type 0x02). */
  const addStr = (name: string, str: string): void => {
    const s = enc.encode(str);
    const b = new Uint8Array(9 + s.length);
    for (let i = 0; i < 4; i++) b[i] = name.charCodeAt(i);
    b[4] = 0x02;
    new DataView(b.buffer).setUint32(5, s.length, true);
    b.set(s, 9);
    blocks.push(b);
  };

  // Mandatory metadata blocks (order matters, matching observed files).
  addInt('DIFM', 0);
  addInt('DIFW', 0);
  addInt('GNRE', 0xffffffff); // -1 = unknown genre
  addInt('SFTV', 0x01145a15); // software version constant from samples
  addInt('MUSL', 0);
  addInt('ANME', 13);
  addInt('TYPE', 0);
  addStr('FLID', '                '); // 16 spaces (no encryption key)
  addStr('TITL', title);
  addStr('ARTS', artist);
  addStr('SORC', source);
  addInt('RGHT', 0);
  addInt('PROV', 0);
  addStr('IDUS', '                '); // 16 spaces
  addInt('ENDH', 0xffffffff); // end marker, value = -1

  // Concatenate all blocks after "KFNB".
  const total = blocks.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(4 + total);
  out[0] = 0x4b; // K
  out[1] = 0x46; // F
  out[2] = 0x4e; // N
  out[3] = 0x42; // B
  let off = 4;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

interface DirEntry {
  filename: string;
  fileType: number; // 1=Song.ini, 2=audio, 3=image
  data: Uint8Array;
}

/** Build the directory + file data section. */
function buildDirectoryAndData(entries: DirEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const countBuf = new Uint8Array(4);
  new DataView(countBuf.buffer).setUint32(0, entries.length, true);

  // Calculate directory size: 4 bytes count + per-entry (4 + name + 20).
  let dirSize = 4;
  for (const e of entries) {
    dirSize += 4 + enc.encode(e.filename).length + 20;
  }

  // Build directory buffer with correct offsets.
  const dirBuf = new Uint8Array(dirSize);
  let pos = 0;
  dirBuf.set(countBuf, pos); pos += 4;
  let dataOff = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.filename);
    new DataView(dirBuf.buffer).setUint32(pos, nameBytes.length, true); pos += 4;
    dirBuf.set(nameBytes, pos); pos += nameBytes.length;
    const dv = new DataView(dirBuf.buffer, pos);
    dv.setUint32(0, e.fileType, true);
    dv.setUint32(4, e.data.length, true);
    dv.setUint32(8, dataOff, true); // offset relative to end of directory
    dv.setUint32(12, e.data.length, true);
    dv.setUint32(16, 0, true); // flags
    pos += 20;
    dataOff += e.data.length;
  }

  // Concatenate directory + all file data.
  const total = dirSize + entries.reduce((s, e) => s + e.data.length, 0);
  const out = new Uint8Array(total);
  out.set(dirBuf, 0);
  pos = dirSize;
  for (const e of entries) {
    out.set(e.data, pos);
    pos += e.data.length;
  }
  return out;
}

/**
 * Build ONE [EffN] effect section from a text track. ID is 1 for the first text
 * track and 2 for any additional one (KaraFun supports at most two text layers).
 * The renderer mode is written back into KFN fields:
 *  - scroller → Trajectory=PlainBottomToTop (the scroll animation);
 *  - classic  → no Trajectory, LineCount=lineSlots, OffsetX/OffsetY (fixed slots).
 * Non-scroller layouts are coerced to scroller-equivalent fields and a warning
 * is emitted, since KaraFun only knows these two animation styles.
 *
 * Returns the section lines plus any export warnings.
 */
function buildEffectSection(track: TextTrack, effIndex: number, textTrackIndex: number): { lines: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: string[] = [];
  // KaraFun text effect ID: 1 for the main lyrics, 2 for the alternate. It
  // depends on the TEXT track order, not the absolute effect index (a background
  // image effect may precede the text effects).
  const id = textTrackIndex === 0 ? 1 : 2;

  out.push(`[Eff${effIndex + 1}]`);
  out.push(`ID=${id}`);
  out.push('InPractice=1');
  // Track name — KaraFun stores it in Caption.
  out.push(`Caption=${track.name}`);
  out.push('Enabled=-1');
  out.push('Locked=0');

  // Text lines + a FLAT array of all syllable timestamps for this effect.
  // In real KFN files, Sync0..SyncN are chunks of ~41 timestamps each that
  // together form one flat sequence covering ALL syllables of the effect.
  const textLines: string[] = [];
  const allSyncs: number[] = [];
  let textIdx = 0;
  for (const line of track.lines) {
    let text = '';
    for (const syl of line.syllables) {
      if (syl.sep === ' ') text += ' ';
      else if (syl.sep === '/') text += '/';
      text += syl.text;
      allSyncs.push(syl.startMs !== null ? Math.round(syl.startMs / 10) : -1);
    }
    textLines.push(`Text${textIdx}=${text}`);
    textIdx++;
  }
  out.push(`TextCount=${textIdx}`);
  for (const t of textLines) out.push(t);

  const CHUNK = 41;
  for (let i = 0; i < allSyncs.length; i += CHUNK) {
    const chunk = allSyncs.slice(i, i + CHUNK);
    out.push(`Sync${Math.floor(i / CHUNK)}=${chunk.join(',')}`);
  }

  // Font: KFN size is in KaraFun units where 18 ≈ our 64px (verified on samples).
  const kfnFontSize = Math.max(8, Math.round((track.style.fontSize * 18) / 64));
  // Strip fallback families — KFN wants a single family name.
  const family = track.style.fontFamily.split(',')[0].trim();
  out.push(`Font=${family}*${kfnFontSize}`);
  out.push(`ActiveColor=${cssToArgb(track.style.colorHighlight)}`);
  out.push(`InactiveColor=${cssToArgb(track.style.colorBase)}`);
  out.push(`FrameColor=${cssToArgb(track.style.strokeColorActive)}`);
  out.push(`InactiveFrameColor=${cssToArgb(track.style.strokeColorInactive)}`);
  // Stroke width → FrameType: KaraFun encodes outline thickness as the FrameType
  // name (Frame0 = none, Frame1 = 1px, …, Frame5 = 5px max). Clamp to the max
  // KaraFun Studio supports and warn when the project's width exceeds it (our
  // own renderer is not limited, but a .kfn opened in KaraFun would be capped).
  const strokeW = Math.max(0, Math.round(track.style.strokeWidth));
  if (strokeW > KFN_MAX_FRAME) {
    warnings.push(
      `Дорожка «${track.name}»: толщина обводки ${strokeW} превышает максимум KaraFun (${KFN_MAX_FRAME}); ` +
        `экспортировано ${KFN_MAX_FRAME}.`,
    );
  }
  out.push(`FrameType=Frame${Math.min(KFN_MAX_FRAME, strokeW)}`);
  out.push('Alignment=Center');

  // Layout → KFN animation fields. KaraFun has two lyric styles: scrolling
  // (Trajectory=PlainBottomToTop) and fixed-slot. Map our modes onto them.
  // OffsetZ is a perspective/depth value KaraFun uses to scale scrolling text
  // (0 = huge/foreground, larger = smaller/farther; Studio always writes 30).
  // We don't render perspective ourselves, but mirror KaraFun's defaults so the
  // exported file looks right when opened in KaraFun Studio.
  const KFN_SCROLLER_OFFSETZ = 30;
  const classic = track.rendererSettings?.classic;
  const scroller = track.rendererSettings?.scroller;
  if (track.style.layout === 'classic' && classic) {
    out.push('LineCount=' + (classic.lineSlots ?? 4));
    out.push('OffsetX=' + (classic.offsetX ?? 0));
    out.push('OffsetY=' + (classic.offsetY ?? 0));
    // Classic (fixed-slot) tracks have no OffsetZ in KaraFun files.
  } else if (track.style.layout === 'scroller') {
    // Trajectory param = 10 / previewSec (inverse: more preview → smaller param).
    const previewSec = typeof scroller?.previewSec === 'number' ? scroller.previewSec : 10;
    const param = previewSecToTrajectory(previewSec).toFixed(6);
    out.push(`Trajectory=PlainBottomToTop*${param}*1.000000*1.000000*1.000000`);
    out.push('OffsetX=0');
    out.push('OffsetY=0');
    out.push(`OffsetZ=${KFN_SCROLLER_OFFSETZ}`);
  } else {
    // Unknown / future renderer: coerce to scroller (the most compatible) and warn.
    warnings.push(
      `Дорожка «${track.name}»: режим «${track.style.layout}» не поддерживается KaraFun, ` +
        `экспортирован как скроллер (эффекты могут отличаться).`,
    );
    out.push('Trajectory=PlainBottomToTop*1.000000*1.000000*1.000000*1.000000');
    out.push('OffsetX=0');
    out.push('OffsetY=0');
    out.push(`OffsetZ=${KFN_SCROLLER_OFFSETZ}`);
  }
  out.push('IsFade=1');
  out.push('AspectRatio=1');
  out.push('IsFill=1');
  out.push('NbAnim=0');
  out.push('InSync=1');
  out.push('');

  return { lines: out, warnings };
}

/**
 * Build Song.ini from ALL text tracks + optional background image/video. Each
 * text track becomes its own [EffN] effect (ID=1 for the first, ID=2 for the
 * rest); a background image, if present, is written as an [Eff1] ID=51 effect
 * BEFORE the text effects (matching KaraFun's own file order); a background
 * video is written as an ID=62 effect the same way. KaraFun supports at
 * most two text effects, so more than two tracks produce a warning (they are
 * still written as additional effects, at the user's own risk).
 */
function buildSongIni(
  tracks: TextTrack[],
  audioFileName: string,
  bgImageFileName: string | null,
  bgVideoFileName: string | null,
  leadAudioFileName: string | null,
  backAudioFileName: string | null,
): { ini: string; warnings: string[] } {
  const warnings: string[] = [];
  const lines: string[] = [];

  // [General] section
  const title = (audioFileName.replace(/\.[^.]+$/, '') || 'Karaoke').replace(/[_]/g, ' ');
  lines.push('[General]');
  lines.push(`Title=${title}`);
  lines.push('Artist=');
  lines.push('Album=');
  lines.push('Composer=');
  lines.push('Year=');
  lines.push('Track=');
  lines.push('GenreID=-1');
  lines.push('Copyright=');
  lines.push('Comment=');
  lines.push(`Source=1,I,${audioFileName}`);
  // EffectCount covers ALL effects: background image/video + text tracks.
  lines.push(`EffectCount=${tracks.length + (bgImageFileName ? 1 : 0) + (bgVideoFileName ? 1 : 0)}`);
  lines.push('LanguageID=');
  lines.push('DiffMen=0');
  lines.push('DiffWomen=0');
  lines.push('KFNType=0');
  lines.push('Properties=24');
  lines.push('KaraokeVersion=');
  lines.push('VocalGuide=');
  lines.push('KaraFunization=');
  lines.push('InfoScreenBmp=');
  lines.push('GlobalShift=0');
  lines.push('');
  lines.push('[Marks]');
  for (let i = 0; i <= 8; i++) lines.push(`Mark${i}=-1`);
  lines.push('');

  // [MP3Music] — additional audio tracks, verified on real KaraFun files:
  //  - lead/guide vocal → TrackN with type 0 (`guide vocal.kfn`: `Track0=<file>,0,0,,`);
  //  - backing vocals   → TrackN with type 2 (`with backing vocal audio.kfn`).
  // The audio itself is embedded as its own type=2 container entry; the track
  // line format is <file>,<type>,<offset>,,<empty>.
  const extraTracks: Array<{ name: string; type: 0 | 2 }> = [];
  if (leadAudioFileName) extraTracks.push({ name: leadAudioFileName, type: 0 });
  if (backAudioFileName) extraTracks.push({ name: backAudioFileName, type: 2 });
  lines.push('[MP3Music]');
  lines.push(`NumTracks=${extraTracks.length}`);
  extraTracks.forEach((t, i) => lines.push(`Track${i}=${t.name},${t.type},0,,`));
  lines.push('');

  // Background image effect (ID=51) goes FIRST, matching KaraFun's file order.
  let effIndex = 0;
  if (bgImageFileName) {
    lines.push(`[Eff${effIndex + 1}]`);
    lines.push('ID=51');
    lines.push('InPractice=0');
    lines.push('Enabled=-1');
    lines.push('Locked=0');
    lines.push('Color=#000000');
    lines.push(`LibImage=${bgImageFileName}`);
    lines.push('ImageColor=#FFFFFFFF');
    lines.push('AlphaBlending=Opacity');
    lines.push('OffsetX=0');
    lines.push('OffsetY=0');
    lines.push('Depth=0');
    lines.push('NbAnim=0');
    lines.push('');
    effIndex++;
  }

  // Background video effect (ID=62), same first-position convention. We embed
  // MP4 (type=5 file); KaraFun's own files use WMV, so the player may refuse —
  // a warning is emitted in collectKfnWarnings.
  if (bgVideoFileName) {
    lines.push(`[Eff${effIndex + 1}]`);
    lines.push('ID=62');
    lines.push('InPractice=0');
    lines.push('Enabled=-1');
    lines.push('Locked=0');
    lines.push(`VideoFile=${bgVideoFileName}`);
    lines.push('PlayAtStart=1');
    lines.push('SeekTime=0');
    // Trim semantics live on OUR side (the export renders exactly
    // durationMs); inside KaraFun the video plays once, no freeze at the end.
    lines.push('LoopVideo=0');
    lines.push('DisplayLastFrame=0');
    lines.push('ZoomScale=100');
    lines.push('Filter=#FFFFFFFF');
    lines.push('AlphaBlending=Opacity');
    lines.push('OffsetX=0');
    lines.push('OffsetY=0');
    lines.push('NbAnim=0');
    lines.push('');
    effIndex++;
  }

  // One [EffN] per text track. Warn if more than two — KaraFun only defines two
  // text layers (ID=1 main, ID=2 alternate).
  if (tracks.length > 2) {
    warnings.push(
      `В проекте ${tracks.length} дорожек, а KaraFun поддерживает максимум 2 текстовых эффекта. ` +
        `Лишние дорожки экспортированы, но KaraFun может их не показать.`,
    );
  }
  for (let i = 0; i < tracks.length; i++) {
    const { lines: effLines, warnings: effWarn } = buildEffectSection(tracks[i], effIndex, i);
    lines.push(...effLines);
    warnings.push(...effWarn);
    effIndex++;
  }

  return { ini: lines.join('\r\n'), warnings };
}

/**
 * Convert a CSS color (hex / rgba / rgb) to KFN's `#RRGGBBAA` format. KaraFun
 * stores colors as Red,Green,Blue,Alpha (alpha is the LAST byte) — see the
 * matching `argbToCss` in kfnImport.ts. This is NOT ARGB despite the #AARRGGBB
 * sometimes seen in references: `#00ACFFFF` is opaque cyan (RR GG BB AA).
 */
function cssToArgb(css: string): string {
  css = (css ?? '').trim();
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  // #RGB / #RRGGBB / #RRGGBBAA / #RGBA
  const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}|[0-9a-fA-F]{4})$/.exec(css);
  if (hexMatch) {
    let h = hexMatch[1];
    let a = 255;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    else if (h.length === 4) {
      a = parseInt(h[3] + h[3], 16);
      h = h.slice(0, 3).split('').map((c) => c + c).join('');
    } else if (h.length === 8) {
      a = parseInt(h.slice(6, 8), 16);
      h = h.slice(0, 6);
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`.toUpperCase();
  }
  const rgbaMatch = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,]+([\d.]+))?\s*\)/i.exec(css);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1], 10);
    const g = parseInt(rgbaMatch[2], 10);
    const b = parseInt(rgbaMatch[3], 10);
    const a = rgbaMatch[4] !== undefined ? Math.round(parseFloat(rgbaMatch[4]) * 255) : 255;
    return `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`.toUpperCase();
  }
  return '#FFFFFFFF';
}

/** Result of a KFN export: the Blob plus human-readable warnings. */
export interface KfnExportResult {
  blob: Blob;
  warnings: string[];
}

/** Options for an async KFN export run. */
export interface KfnExportOptions {
  /** If provided and aborted, the export rejects with ExportCanceledError. */
  signal?: AbortSignal;
  /** Called with 0..1 as the file is built. */
  onProgress?: (fraction: number) => void;
  /** Raw MP4 bytes of the background video (required to embed an ID=62 effect). */
  bgVideoBytes?: Uint8Array | null;
}

/**
 * Export the project to a KaraFun .kfn file. Every text track becomes its own
 * [EffN] effect (ID=1 for the first, ID=2 for the rest). KaraFun supports at
 * most two text effects, so exporting more than two tracks yields a warning
 * (still written). Non-scroller/non-classic renderers are coerced to scroller
 * with a per-track warning.
 *
 * The export runs asynchronously and reports progress so the UI can show a
 * progress bar. The heavy step is copying the (potentially large) audio bytes
 * into the container, so that phase covers most of the 0..1 range.
 */
export async function exportToKfn(
  project: Project,
  audioByRole: Map<AudioRole, Uint8Array>,
  options?: KfnExportOptions,
): Promise<KfnExportResult> {
  const signal = options?.signal;
  const onProgress = options?.onProgress;
  const report = (f: number): void => onProgress?.(Math.max(0, Math.min(1, f)));
  const yield_ = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const checkAbort = (): void => {
    if (signal?.aborted) throw new ExportCanceledError('Экспорт отменён');
  };

  // Audio roles: minus → [General] Source (type 2), lead → [MP3Music] TrackN
  // (type 0, guide vocal), back → [MP3Music] TrackN (type 2).
  const minusTrack = getAudioTrackByRole(project, 'minus');
  const leadTrack = getAudioTrackByRole(project, 'lead');
  const backTrack = getAudioTrackByRole(project, 'back');
  const minusBytes = minusTrack?.audioFileName ? audioByRole.get('minus') : undefined;
  const leadBytes = leadTrack?.audioFileName ? audioByRole.get('lead') : undefined;
  const backBytes = backTrack?.audioFileName ? audioByRole.get('back') : undefined;
  const audioFileName = minusTrack?.audioFileName || 'song.mp3';
  const leadAudioFileName = leadBytes && leadTrack?.audioFileName ? leadTrack.audioFileName : null;
  const backAudioFileName = backBytes && backTrack?.audioFileName ? backTrack.audioFileName : null;
  const title = audioFileName.replace(/\.[^.]+$/, '').replace(/[_]/g, ' ');
  const source = `1,I,${audioFileName}`;

  const textTracks = getTextTracks(project);
  if (textTracks.length === 0) {
    throw new Error('В проекте нет текстовых дорожек для экспорта');
  }
  if (!minusBytes) {
    throw new Error('Дорожка «минус» пуста — нечего экспортировать в KaraFun');
  }
  report(0.02);

  // Phase 1: build Song.ini.
  checkAbort();
  let bgImageFileName: string | null = null;
  if (project.background.bgType === 'image' && project.background.bgImageDataUrl) {
    bgImageFileName = 'background.' + (project.background.bgImageDataUrl.match(/data:image\/([a-z0-9]+);/i)?.[1] ?? 'jpg');
  }
  // Background video: embedded as a type=5 container file referenced by an
  // ID=62 effect. Only when actual bytes are available.
  const bgVideoBytes = options?.bgVideoBytes ?? null;
  const bgVideoFileName =
    project.background.bgType === 'video' && bgVideoBytes && project.background.bgVideoFileName
      ? 'background.' + (project.background.bgVideoFileName.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'mp4')
      : null;
  const { ini: songIni, warnings } = buildSongIni(textTracks, audioFileName, bgImageFileName, bgVideoFileName, leadAudioFileName, backAudioFileName);
  if (bgVideoFileName) {
    warnings.push(
      'Видео-фон вшит как MP4; KaraFun официально поддерживает только WMV/AVI/MPG — плеер KaraFun может его не показать.',
    );
  }
  const songIniBytes = new TextEncoder().encode(songIni);
  report(0.1);
  await yield_();

  // Phase 2: collect container entries — audio (minus + optional lead/back), bg, Song.ini.
  checkAbort();
  const entries: DirEntry[] = [{ filename: audioFileName, fileType: 2, data: minusBytes }];
  if (leadBytes && leadAudioFileName) {
    entries.push({ filename: leadAudioFileName, fileType: 2, data: leadBytes });
  }
  if (backBytes && backAudioFileName) {
    entries.push({ filename: backAudioFileName, fileType: 2, data: backBytes });
  }
  if (project.background.bgType === 'image' && project.background.bgImageDataUrl) {
    const decoded = decodeDataUrl(project.background.bgImageDataUrl);
    if (decoded) entries.push({ filename: decoded.filename, fileType: 3, data: decoded.bytes });
  }
  if (bgVideoFileName && bgVideoBytes) {
    entries.push({ filename: bgVideoFileName, fileType: 5, data: bgVideoBytes });
  }
  entries.push({ filename: 'Song.ini', fileType: 1, data: songIniBytes });
  report(0.35);
  await yield_();

  // Phase 3: assemble the binary container (header + directory + data). The
  // directory builder copies all file bytes — dominated by the audio size.
  checkAbort();
  const header = buildHeader(title, '', source);
  const dirAndData = buildDirectoryAndData(entries);
  report(0.9);
  await yield_();

  // Phase 4: final concatenation + Blob.
  checkAbort();
  const out = new Uint8Array(header.length + dirAndData.length);
  out.set(header, 0);
  out.set(dirAndData, header.length);
  report(1);

  return { blob: new Blob([out], { type: 'application/octet-stream' }), warnings };
}

/**
 * Decode a `data:image/<ext>;base64,...` URL into raw bytes + a sane filename.
 * Returns null for non-image or malformed data URLs.
 */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; filename: string } | null {
  const m = /^data:image\/([a-zA-Z0-9]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, filename: `background.${ext}` };
  } catch {
    return null;
  }
}
