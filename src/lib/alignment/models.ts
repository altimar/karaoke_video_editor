/**
 * Alignment model registry + automatic model choice by the lyrics' script.
 *
 * Two checkpoints, same wav2vec2-CTC ONNX interface (16 kHz input, one frame
 * per 320 samples, CTC logits per frame):
 *
 *  - ENGLISH (historical): wav2vec2-large-960h-lv60-self, fp16 ~630 MB —
 *    uppercase A–Z + apostrophe vocab (32 tokens, `<pad>`=blank, `|` word
 *    separator). Benchmarked on English (eval/results/, p90 247 ms).
 *  - MULTILINGUAL: MMS forced aligner (facebook/mms-300m trained for
 *    alignment on 1130 languages), fp16 ~630 MB — lowercase romanized a–z +
 *    apostrophe vocab (31 tokens, `<blank>`=0, NO word separator). Any script
 *    works because text is uroman-romanized first (alignment/romanize.ts).
 *    Weight license: CC-BY-NC-4.0.
 *
 * The pipeline (forcedAlign.ts) is model-agnostic: it just consumes the
 * config (vocab, case, word separator, url).
 */

/** Everything the alignment pipeline needs to run one checkpoint. */
export interface AlignModelConfig {
  id: 'en' | 'multi';
  /** Human label for status messages / toasts. */
  label: string;
  /** ONNX file (single, self-contained) + Cache Storage bucket. */
  url: string;
  cacheName: string;
  /** CTC letter vocabulary (after case normalization + romanization). */
  letters: Record<string, number>;
  vocabSize: number;
  /** CTC blank id (0 for both current checkpoints). */
  blankId: number;
  /** Word-separator token (960h's `|`), or null when the model has none. */
  wordSepId: number | null;
  /** Case normalization applied before vocab lookup. */
  caseMode: 'upper' | 'lower';
  /** Romanize the word to Latin first (uroman-style; required for MMS). */
  romanize: boolean;
}

/** wav2vec2-large-960h-lv60-self (our fp16 ONNX export, eval/export-large-align.py). */
export const ENGLISH_ALIGN_MODEL: AlignModelConfig = {
  id: 'en',
  label: 'английская',
  url: 'https://huggingface.co/Project42/wav2vec2-large-lv60-align/resolve/main/model_fp16.onnx',
  cacheName: 'wav2vec2-align-large-v1',
  letters: {
    A: 7, B: 24, C: 19, D: 14, E: 5, F: 20, G: 21, H: 11, I: 10, J: 29,
    K: 26, L: 15, M: 17, N: 9, O: 8, P: 23, Q: 30, R: 13, S: 12, T: 6,
    U: 16, V: 25, W: 18, X: 28, Y: 22, Z: 31, "'": 27,
  },
  vocabSize: 32,
  blankId: 0,
  wordSepId: 4,
  caseMode: 'upper',
  romanize: false,
};

/**
 * MMS-300M forced aligner, 1130 languages (our fp16 ONNX export of
 * MahmoudAshraf/mms-300m-1130-forced-aligner, eval/export-mms-align.py).
 * Vocab verified against the checkpoint's vocab.json (frequency-ordered,
 * lowercase; `<blank>`=0 is the CTC blank; no word-separator token).
 */
export const MULTILINGUAL_ALIGN_MODEL: AlignModelConfig = {
  id: 'multi',
  label: 'мультиязычная (MMS)',
  url: 'https://huggingface.co/Project42/mms-300m-align/resolve/main/model_fp16.onnx',
  cacheName: 'mms-align-300m-v1',
  letters: {
    a: 4, i: 5, e: 6, n: 7, o: 8, u: 9, t: 10, s: 11, r: 12, m: 13,
    k: 14, l: 15, d: 16, g: 17, h: 18, y: 19, b: 20, p: 21, w: 22, c: 23,
    v: 24, j: 25, z: 26, f: 27, "'": 28, q: 29, x: 30,
  },
  vocabSize: 31,
  blankId: 0,
  wordSepId: null,
  caseMode: 'lower',
  romanize: true,
};

/**
 * Pick the alignment model for a piece of lyrics text: any non-ASCII letters
 * (Cyrillic, umlauts, other scripts) → the multilingual MMS checkpoint;
 * pure-ASCII-Latin text stays on the proven English checkpoint.
 */
export function pickAlignModel(text: string): AlignModelConfig {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 128) continue; // ASCII: letters handled by the en vocab or dropped
    if (isLetter(ch)) return MULTILINGUAL_ALIGN_MODEL;
  }
  return ENGLISH_ALIGN_MODEL;
}

function isLetter(ch: string): boolean {
  return /\p{L}/u.test(ch);
}
