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
import { Project } from '../types';

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
 * Convert a Project's lyrics into the Song.ini text format.
 * - Each line becomes `Text{n}=...` with syllables separated by `/`.
 * - Timings become `Sync{n}=...` in centiseconds (ms / 10), comma-separated.
 * - Sync{n} corresponds to Text{n}: one timestamp per syllable in that line.
 */
function buildSongIni(project: Project, audioFileName: string): string {
  const lines: string[] = [];

  // [General] section
  const title = (project.audioFileName?.replace(/\.[^.]+$/, '') || 'Karaoke').replace(/[_]/g, ' ');
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
  lines.push('EffectCount=1');
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

  // [MP3Music]
  lines.push('[MP3Music]');
  lines.push('NumTracks=0');
  lines.push('');

  // [Eff1] — the lyrics effect
  lines.push('[Eff1]');
  lines.push('ID=1');
  lines.push('InPractice=1');
  lines.push('Enabled=-1');
  lines.push('Locked=0');

  // Build Text lines and a FLAT array of all syllable timestamps.
  // In real KFN files, Sync0..SyncN are chunks of ~40 timestamps each that
  // together form one flat sequence covering ALL syllables across ALL text lines.
  // We replicate this: collect all timestamps in order, then split into chunks.
  const textLines: string[] = [];
  const allSyncs: number[] = [];
  let textIdx = 0;

  for (const line of project.lines) {
    let text = '';
    for (const syl of line.syllables) {
      if (syl.sep === ' ') text += ' ';
      else if (syl.sep === '/') text += '/';
      text += syl.text;
      // Centiseconds: ms / 10. Use -1 for untimed syllables.
      allSyncs.push(syl.startMs !== null ? Math.round(syl.startMs / 10) : -1);
    }
    textLines.push(`Text${textIdx}=${text}`);
    textIdx++;
  }

  lines.push(`TextCount=${textIdx}`);
  for (const t of textLines) lines.push(t);

  // Split allSyncs into chunks of ~41 (matching observed files) and emit as Sync0..SyncN.
  const CHUNK = 41;
  for (let i = 0; i < allSyncs.length; i += CHUNK) {
    const chunk = allSyncs.slice(i, i + CHUNK);
    lines.push(`Sync${Math.floor(i / CHUNK)}=${chunk.join(',')}`);
  }

  // Styling (minimal defaults for KFN compatibility).
  // KFN font size is NOT in pixels — it's in KaraFun's own units where 18 is the
  // standard readable size (verified across all sample files). Our project's
  // fontSize (e.g. 64px at 1080p) would be absurdly large, so we map
  // proportionally: 64px → 18 KFN units.
  const kfnFontSize = Math.max(8, Math.round(project.style.fontSize * 18 / 64));
  lines.push(`Font=${project.style.fontFamily}*${kfnFontSize}`);
  lines.push(`ActiveColor=#00ACFFFF`);
  lines.push(`InactiveColor=#FFFFFFFF`);
  lines.push(`FrameColor=#000000FF`);
  lines.push(`InactiveFrameColor=#010101FF`);

  return lines.join('\r\n');
}

/**
 * Export the project to a KaraFun .kfn file Blob.
 * @param project The karaoke project with lyrics and timings.
 * @param audioData Raw bytes of the original MP3 file.
 * @returns A Blob containing the .kfn file.
 */
export function exportToKfn(project: Project, audioData: Uint8Array): Blob {
  const audioFileName = project.audioFileName || 'song.mp3';
  const title = audioFileName.replace(/\.[^.]+$/, '').replace(/[_]/g, ' ');
  const source = `1,I,${audioFileName}`;

  // Build Song.ini.
  const songIni = buildSongIni(project, audioFileName);
  const songIniBytes = new TextEncoder().encode(songIni);

  // Build the file entries: audio (type 2) + Song.ini (type 1).
  const entries: DirEntry[] = [
    { filename: audioFileName, fileType: 2, data: audioData },
    { filename: 'Song.ini', fileType: 1, data: songIniBytes },
  ];

  // Assemble: header + directory + data.
  const header = buildHeader(title, '', source);
  const dirAndData = buildDirectoryAndData(entries);

  const out = new Uint8Array(header.length + dirAndData.length);
  out.set(header, 0);
  out.set(dirAndData, header.length);

  return new Blob([out], { type: 'application/octet-stream' });
}
