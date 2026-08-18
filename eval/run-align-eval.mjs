/**
 * Alignment-model benchmark: runs the app's auto-timing (forced alignment)
 * against a fixture song and scores it versus the KFN ground truth.
 *
 * The flow mirrors the real user path: load the vocal stem into the 'back' role (the KFN-import path)
 * role → paste RAW lyrics (KFN slashes stripped) → press «✂ Разбить на слоги»
 * (OUR syllabifier) → press «⏱» (auto-timing) → compare the resulting word
 * start times with the reference.
 *
 * Comparison is at WORD level (syllable splits differ between the KFN and our
 * syllabifier, words don't). Metrics: word count matched, median/mean/p90
 * absolute deviation, % within 100/250/500 ms, global offset (first word).
 *
 * Usage:
 *   node eval/run-align-eval.mjs                                  # fixture vocal.mp3
 *   node eval/run-align-eval.mjs --audio kfn/Kiri-lead.mp3        # any local audio
 *   node eval/run-align-eval.mjs --audio kfn/orig.mp3 --separate  # FULL pipeline:
 *                                                                 original → Mel-RoFormer
 *                                                                 → lead → align
 *   node eval/run-align-eval.mjs --model xlsr-ru    # from MODEL_REGISTRY
 *   node eval/run-align-eval.mjs --strategy chars   # syllable distribution
 *
 * NOTE on the kiri fixture: its vocal.mp3 is BACKING VOCALS ONLY (the KFN's
 * author kept the lead stem out — verified by eval/verify-stem.mjs: the stem
 * is silent exactly where the reference words are). Do NOT use it for lead
 * alignment metrics; put the song's original or lead stem into kfn/ (gitignored)
 * and point --audio at it.
 *
 * Requires the dev server on :5173 (npm run dev). Results are appended to
 * eval/results/ (gitignored). WebGPU is needed — runs a real browser.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Registry of alignment models to compare. Each entry maps to a
 * self-contained ONNX (wav2vec2 CTC, 32-token English vocab compatible).
 * Add future models (e.g. a Russian xlsr CTC export) here.
 */
// Every entry carries a PRESET ('en' = English vocab config, 'multi' = the
// production MMS config) — the runner forces it through the full-model
// override hook, since production always picks MMS regardless of the script.
const MODEL_REGISTRY = {
  'en-large-fp16': {
    url: 'https://huggingface.co/Project42/wav2vec2-large-lv60-align/resolve/main/model_fp16.onnx',
    cacheName: 'wav2vec2-align-large-v1',
    preset: 'en',
  },
  'en-base-fp16': {
    url: 'https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main/onnx/model_fp16.onnx',
    cacheName: 'wav2vec2-align-v1',
    preset: 'en',
  },
  'en-base-q8': {
    url: 'https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main/onnx/model_quantized.onnx',
    cacheName: 'wav2vec2-align-v1-q8',
    preset: 'en',
  },
  // The production MULTILINGUAL checkpoint (own vocab + romanization).
  'mms-fp16': {
    url: 'https://huggingface.co/Project42/mms-300m-align/resolve/main/model_fp16.onnx',
    cacheName: 'mms-align-300m-v1',
    preset: 'multi',
  },
};

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const modelId = getArg('model') ?? 'mms-fp16'; // production default since the single-model merge
const songSlug = getArg('song') ?? 'kiri';
const strategy = getArg('strategy') ?? 'proportional';

const fixtureDir = join(__dirname, 'fixtures', songSlug);
const root = join(__dirname, '..');

// Audio source: --audio <path> (relative to the repo root — e.g. the song's
// original or lead stem placed into kfn/, which is gitignored), else the
// fixture's vocal.mp3. --separate switches to the FULL pipeline: the audio is
// loaded as the ORIGINAL and our Mel-RoFormer extracts the lead first.
const separate = args.includes('--separate');
const audioPath = getArg('audio')
  ? join(root, getArg('audio'))
  : join(fixtureDir, 'vocal.mp3');
if (!existsSync(audioPath)) {
  console.error(`Audio not found: ${audioPath}${getArg('audio') ? '' : ` (fixture "${songSlug}" has no vocal.mp3)`}`);
  process.exit(1);
}
const audioRole = separate ? 'original' : getArg('audio') ? 'lead' : 'back';
const lyricsRaw = readFileSync(join(fixtureDir, 'lyrics.txt'), 'utf8').replace(/\//g, '');
const reference = JSON.parse(readFileSync(join(fixtureDir, 'reference.json'), 'utf8'));

// --- helpers ---

/** Normalize a word for matching: uppercase letters only. */
const normWord = (s) => s.toUpperCase().replace(/[^A-Z']/g, '') || '?';

/** Group flat syllables [{text, sep, startMs}] into words. */
function toWords(flat) {
  const words = [];
  let cur = null;
  for (const s of flat) {
    if (!cur || s.sep === ' ') {
      cur = { text: '', startMs: s.startMs };
      words.push(cur);
    }
    cur.text += s.text;
  }
  return words.filter((w) => normWord(w.text) !== '?');
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// --- run ---

const browser = await chromium.launch({
  headless: process.env.HEADLESS === '1',
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });

  {
    const m = MODEL_REGISTRY[modelId];
    if (!m) throw new Error(`Unknown model "${modelId}". Known: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
    await page.evaluate(([preset, url, cache]) => window.__setAlignModelFull(preset, url, cache), [m.preset, m.url, m.cacheName]);
  }

  // 1. Load the audio. Plain mode: straight into the vocal role (back for the
  // KFN fixture, lead for --audio). --separate: load as the ORIGINAL and run
  // our Mel-RoFormer extraction — the full user pipeline (big first-run
  // download, several minutes of inference).
  // In HEADED mode the header click opens a NATIVE file dialog — intercept
  // the chooser and feed it the file (headless auto-dismisses instead).
  const audioPayload = {
    name: 'audio.mp3',
    mimeType: 'audio/mpeg',
    buffer: readFileSync(audioPath),
  };
  page.on('filechooser', (fc) => void fc.setFiles(audioPayload));
  await page.locator(`[data-testid="track-head-${audioRole}"]`).click();
  await page.waitForFunction(
    (role) => window.__audioEngine && window.__audioEngine.getBuffer(role),
    audioRole,
    { timeout: 60_000 },
  );
  if (separate) {
    console.log('Separating (Mel-RoFormer) — the first run downloads ~700 MB…');
    await page.locator('.timeline-track-extract').first().click();
    await page.waitForFunction(() => window.__audioEngine && window.__audioEngine.getBuffer('lead'), undefined, {
      timeout: 30 * 60_000,
    });
  }

  // 2. Raw lyrics into the active text track + our syllabifier.
  // (Loading the audio made an audio track active — switch back to the text one.)
  await page.locator('[data-testid="track-head-text"]').first().click();
  const textarea = page.locator('textarea.lyrics');
  await textarea.fill('');
  await textarea.fill(lyricsRaw);
  await page.getByRole('button', { name: /Разбить на слоги/ }).click();
  await page.waitForTimeout(300);

  // 3. Auto-timing (may download the model on the first run — takes a while).
  console.log(`Running auto-align (model=${modelId}, strategy=${strategy}) on "${songSlug}"…`);
  await page.locator('[data-testid="btn-auto-align"]').first().click();
  await page.waitForFunction(() => {
    const p = window.__store.getProject();
    const t = p.tracks.find((x) => x.type === 'text');
    return t && t.lines.length > 0 && t.lines.every((l) => l.syllables.every((s) => s.startMs !== null));
  }, undefined, { timeout: 10 * 60_000 });

  // 4. Read the result + the reference, compare at word level.
  const resultFlat = await page.evaluate(() => {
    const p = window.__store.getProject();
    const t = p.tracks.find((x) => x.type === 'text');
    const flat = [];
    for (const line of t.lines) {
      for (const s of line.syllables) flat.push({ text: s.text, sep: s.sep ?? '', startMs: s.startMs });
    }
    return flat;
  });

  const gotWords = toWords(resultFlat);
  const refWords = toWords(reference);
  if (gotWords.length !== refWords.length) {
    console.warn(`Word count mismatch: got ${gotWords.length}, reference ${refWords.length} — sequence-comparing the prefix.`);
  }
  const diffs = [];
  const perWord = [];
  const n = Math.min(gotWords.length, refWords.length);
  let mismatches = 0;
  for (let i = 0; i < n; i++) {
    if (normWord(gotWords[i].text) !== normWord(refWords[i].text)) {
      mismatches++;
      continue;
    }
    const dev = (gotWords[i].startMs ?? 0) - (refWords[i].startMs ?? 0);
    diffs.push(Math.abs(dev));
    perWord.push({ i, word: normWord(refWords[i].text), ref: refWords[i].startMs, got: gotWords[i].startMs, dev });
  }
  diffs.sort((a, b) => a - b);
  const within = (ms) => (diffs.filter((d) => d <= ms).length / (diffs.length || 1)) * 100;
  const median = percentile(diffs, 50);
  const mean = diffs.reduce((s, d) => s + d, 0) / (diffs.length || 1);
  const p90 = percentile(diffs, 90);
  const globalOffset = (gotWords[0]?.startMs ?? 0) - (refWords[0]?.startMs ?? 0);

  const report = {
    model: modelId,
    strategy,
    song: songSlug,
    wordsMatched: diffs.length,
    wordsTotal: refWords.length,
    textMismatches: mismatches,
    medianDevMs: Math.round(median),
    meanDevMs: Math.round(mean),
    p90DevMs: Math.round(p90),
    within100Ms: +within(100).toFixed(1),
    within250Ms: +within(250).toFixed(1),
    within500Ms: +within(500).toFixed(1),
    globalOffsetMs: Math.round(globalOffset),
    timestamp: new Date().toISOString(),
  };

  console.log('\n=== Alignment eval ===');
  for (const [k, v] of Object.entries(report)) console.log(`  ${k}: ${v}`);

  // Diagnostics: worst words + chronological deviations (drift runs).
  const worst = [...perWord].sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev)).slice(0, 15);
  console.log('\n  worst words (dev>1s):');
  for (const w of worst) console.log(`    #${w.i} "${w.word}" ref=${(w.ref/1000).toFixed(1)}s got=${(w.got/1000).toFixed(1)}s dev=${(w.dev/1000).toFixed(1)}s`);
  console.log('\n  chronological (song order):');
  const line = perWord.map((w) => (w.dev >= 0 ? '+' : '') + (w.dev / 1000).toFixed(1)).join(' ');
  console.log('  ' + line);

  mkdirSync(join(__dirname, 'results'), { recursive: true });
  const outFile = join(__dirname, 'results', `${Date.now()}-${modelId}-${songSlug}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nsaved: ${outFile}`);
} finally {
  await browser.close();
}
