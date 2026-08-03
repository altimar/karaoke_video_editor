/**
 * KaraFun (.kfn) file importer.
 *
 * Parses a .kfn binary container and extracts:
 *  - Song.ini (lyrics + timings)
 *  - The embedded audio file (MP3 bytes)
 *
 * Converts them into the project model (Lines + Syllables) and returns the raw
 * audio bytes so AudioEngine can load them.
 */
import { Line, Syllable } from '../types';

export interface KfnImportResult {
  project: { lines: Line[]; audioFileName: string };
  audioBytes: Uint8Array;
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

/** Parse the KFN binary into header fields, directory entries, and file data. */
function parseKfn(data: Uint8Array): { entries: KfnEntry; songIni: string; audioBytes: Uint8Array; audioName: string } {
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

  // Compute absolute offsets (relative to dirEnd) and extract data.
  const entries = rawEntries.map((e) => ({
    ...e,
    absOffset: dirEnd + e.offset,
  }));

  // Find Song.ini (type 1) and audio (type 2).
  const songEntry = entries.find((e) => e.type === 1 || e.name.toLowerCase().endsWith('.ini'));
  const audioEntry = entries.find((e) => e.type === 2 || /\.(mp3|ogg|wav)$/i.test(e.name));
  if (!songEntry) throw new Error('Song.ini не найден в KFN');
  if (!audioEntry) throw new Error('Аудиофайл не найден в KFN');

  const songIni = dec.decode(data.slice(songEntry.absOffset, songEntry.absOffset + songEntry.inLen));
  const audioBytes = data.slice(audioEntry.absOffset, audioEntry.absOffset + audioEntry.inLen);

  return { entries: entries[0], songIni, audioBytes, audioName: audioEntry.name };
}

/**
 * Parse Song.ini text into Lines + Syllables.
 *
 * IMPORTANT: Sync values are NOT mapped per-text-line. In a KFN file, Sync0..SyncN
 * are chunks of timestamps (split into groups of ~40 values each) that together
 * form ONE flat sequence of timestamps for ALL syllables in ALL text lines, in
 * order. We flatten all Sync values into one array and assign them to syllables
 * sequentially as we walk through Text0..TextN.
 *
 * Timings are in centiseconds (1/100 s); we convert to milliseconds (×10).
 */
function parseSongIni(songIni: string): Line[] {
  const lines: Line[] = [];

  // Collect Text{n} values in order, and flatten ALL Sync values into one array.
  const textMap = new Map<number, string>();
  let textCount = 0;
  const allSyncs: number[] = []; // flat: Sync0 values, then Sync1, then Sync2...

  for (const rawLine of songIni.split(/\r?\n/)) {
    const textMatch = rawLine.match(/^Text(\d+)=(.*)$/);
    if (textMatch) {
      textMap.set(parseInt(textMatch[1], 10), textMatch[2]);
      continue;
    }
    const countMatch = rawLine.match(/^TextCount=(\d+)$/);
    if (countMatch) {
      textCount = parseInt(countMatch[1], 10);
      continue;
    }
    const syncMatch = rawLine.match(/^Sync(\d+)=(.*)$/);
    if (syncMatch) {
      const vals = syncMatch[2].split(',').map((v) => parseInt(v.trim(), 10));
      allSyncs.push(...vals);
      continue;
    }
  }

  // Walk through all text lines, splitting each into syllables and consuming
  // timestamps from the flat allSyncs array in order.
  const maxIdx = textCount || Math.max(...textMap.keys(), -1);
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
 * Import a .kfn file: extract audio bytes and parse lyrics/timings.
 * Returns a partial project (lines + audio filename) and raw audio bytes.
 */
export function importFromKfn(data: Uint8Array): KfnImportResult {
  const parsed = parseKfn(data);
  const lines = parseSongIni(parsed.songIni);
  return {
    project: { lines, audioFileName: parsed.audioName },
    audioBytes: parsed.audioBytes,
  };
}
