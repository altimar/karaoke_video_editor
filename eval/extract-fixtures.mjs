/**
 * Extract alignment-eval fixtures from the .kfn samples in kfn/ (kept in the
 * repo on purpose — they are the ground truth for tuning and for comparing
 * future alignment models; see eval/README.md).
 *
 * Per song this writes into eval/fixtures/<slug>/:
 *   - lyrics.txt      — the song text with the KFN's syllable split
 *                      (slashes inside words, spaces between them)
 *   - reference.json  — [{text, startMs}] per syllable, flat order (ground truth)
 *   - vocal.mp3       — the vocal stem, when the KFN carries one (Kiri does:
 *                      [MP3Music] Track0 "Backing Vocals"; Dreaming Wild has
 *                      none, so only lyrics+reference are written there)
 *
 * Run: node eval/extract-fixtures.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Bundle the app's real KFN importer + lyrics serializer.
const entry = join(__dirname, '_extract-entry.ts');
writeFileSync(
  entry,
  `export { importFromKfn } from '${root.replace(/\\/g, '/')}/src/lib/kfnImport';\n` +
    `export { serializeLyrics, flatSyllables } from '${root.replace(/\\/g, '/')}/src/lib/textParser';\n`,
);
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: join(__dirname, '_extract-bundle.mjs'), logLevel: 'silent' });
const { importFromKfn, serializeLyrics } = await import(pathToFileURL(join(__dirname, '_extract-bundle.mjs')).href + '?' + Date.now());
unlinkSync(entry);
rmSync(join(__dirname, '_extract-bundle.mjs'), { force: true });

/** Parse the KFN container directory (same walk as importFromKfn). */
function parseKfnEntries(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dec = new TextDecoder();
  let pos = 4;
  while (pos < data.length) {
    const name = dec.decode(data.slice(pos, pos + 4)); pos += 4;
    const dtype = data[pos]; pos += 1;
    const val = dv.getUint32(pos, true); pos += 4;
    if (dtype === 2) pos += val;
    if (name === 'ENDH') break;
  }
  const count = dv.getUint32(pos, true); pos += 4;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint32(pos, true); pos += 4;
    const name = dec.decode(data.slice(pos, pos + nameLen)); pos += nameLen;
    const type = dv.getUint32(pos, true);
    const offset = dv.getUint32(pos + 8, true);
    const inLen = dv.getUint32(pos + 12, true);
    pos += 20;
    entries.push({ name, type, offset, inLen });
  }
  const dirEnd = pos;
  for (const e of entries) e.absOffset = dirEnd + e.offset;
  return entries;
}

const SONGS = [
  { kfn: 'Monoral - Kiri (Ergo Proxy).kfn', slug: 'kiri' },
  { kfn: 'Klahr & KEV - Dreaming wild.kfn', slug: 'dreaming-wild' },
  { kfn: 'with backing vocal audio.kfn', slug: 'soul' },
];

for (const song of SONGS) {
  const bytes = new Uint8Array(readFileSync(join(root, 'kfn', song.kfn)));
  const result = importFromKfn(bytes);
  const textTrack = result.project.tracks.find((t) => t.type === 'text');
  if (!textTrack) throw new Error(`no text track in ${song.kfn}`);

  const outDir = join(__dirname, 'fixtures', song.slug);
  mkdirSync(outDir, { recursive: true });

  // Ground truth: one entry per syllable, flat order. `sep` (the separator
  // BEFORE the syllable) lets the eval compare at WORD level, so a different
  // syllabification of the same text doesn't break the comparison.
  const reference = [];
  for (const line of textTrack.lines) {
    for (const syl of line.syllables) {
      reference.push({ text: syl.text, sep: syl.sep ?? '', startMs: syl.startMs });
    }
  }
  writeFileSync(join(outDir, 'lyrics.txt'), serializeLyrics(textTrack.lines), 'utf8');
  writeFileSync(join(outDir, 'reference.json'), JSON.stringify(reference, null, 2), 'utf8');

  // Vocal stem: the [MP3Music] Track0 entry ("backing vocals"), when present.
  const entries = parseKfnEntries(bytes);
  const vocal = entries.find((e) => e.name.toLowerCase().includes('backing vocals'));
  if (vocal) {
    writeFileSync(join(outDir, 'vocal.mp3'), bytes.slice(vocal.absOffset, vocal.absOffset + vocal.inLen));
  }
  console.log(
    `${song.slug}: ${reference.length} syllables, lyrics.txt, reference.json${vocal ? ', vocal.mp3 (' + (vocal.inLen / 1048576).toFixed(1) + ' MB)' : ' (no vocal stem in this KFN)'}`,
  );
}
