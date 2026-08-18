/**
 * Alignment model registry + model choice.
 *
 * ONE production checkpoint — the MULTILINGUAL MMS forced aligner — used for
 * every language, English included. The English A/B on the soul fixture
 * (eval/results/: median 5.6 s / p90 8.1 s for MMS vs 25.2 s / 66.9 s for
 * wav2vec2-large) showed the ASR-repurposed English checkpoint locks onto
 * repeated choruses and drifts; MMS is trained FOR alignment and stays
 * closer. A single model also means one ~630 MB download regardless of the
 * lyrics' script. Any script works because text is uroman-romanized first
 * (alignment/romanize.ts). Weight license: CC-BY-NC-4.0.
 *
 * The ENGLISH config is kept for the eval harness (comparing checkpoints
 * that share its vocab); production never picks it.
 *
 * Both checkpoints share the wav2vec2-CTC ONNX interface (16 kHz input, one
 * frame per 320 samples, CTC logits per frame). The pipeline (forcedAlign.ts)
 * is model-agnostic: it just consumes the config (vocab, case, word
 * separator, url).
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

/**
 * wav2vec2-large-960h-lv60-self (our fp16 ONNX export,
 * eval/export-large-align.py). NOT used in production — the eval harness
 * builds comparison overrides on top of this config.
 */
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
 * The alignment model for a piece of lyrics text: always the multilingual MMS
 * checkpoint — it matched or beat the English one on English lyrics (see the
 * module doc) and works for every script via romanization. The text parameter
 * is kept for interface stability (future per-script switches).
 */
export function pickAlignModel(_text: string): AlignModelConfig {
  return MULTILINGUAL_ALIGN_MODEL;
}

/**
 * Resolve an eval preset into a concrete model config, optionally swapping the
 * checkpoint URL/cache (for same-vocab comparison checkpoints).
 */
export function resolveAlignModelOverride(
  preset: 'en' | 'multi',
  url?: string,
  cacheName?: string,
): AlignModelConfig {
  const base = preset === 'en' ? ENGLISH_ALIGN_MODEL : MULTILINGUAL_ALIGN_MODEL;
  return url && cacheName ? { ...base, url, cacheName } : base;
}
