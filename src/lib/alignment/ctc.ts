/**
 * Pure CTC forced-alignment math (no model, no browser APIs) — the alignment
 * engine behind the syllable auto-timing feature (lib/forcedAlign.ts).
 *
 * The approach mirrors torchaudio's `forced_align`: given per-frame CTC
 * log-probabilities from a wav2vec2-style model and a KNOWN transcript, find
 * the most likely frame for every transcript token via Viterbi. No speech
 * recognition happens — the text is given, only its position in the audio is
 * unknown. This is why it works on sung vocals where ASR (Whisper etc.)
 * degrades.
 *
 * Everything here is pure so it is unit-testable with synthetic logits.
 */
import { Line } from '../../types';

/**
 * Vocabulary of facebook/wav2vec2-base-960h (verified against the model's
 * vocab.json): `<pad>` is the CTC blank, `|` is the word separator.
 * Specials <s>=1, </s>=2, <unk>=3 are never produced by this checkpoint.
 */
export const BLANK_ID = 0;
export const WORDSEP_ID = 4;
export const VOCAB_SIZE = 32;

const LETTER_IDS: Record<string, number> = {
  A: 7, B: 24, C: 19, D: 14, E: 5, F: 20, G: 21, H: 11, I: 10, J: 29,
  K: 26, L: 15, M: 17, N: 9, O: 8, P: 23, Q: 30, R: 13, S: 12, T: 6,
  U: 16, V: 25, W: 18, X: 28, Y: 22, Z: 31, "'": 27,
};

/** One flattened syllable with its global position (line- and syllable-index). */
export interface FlatSyllable {
  text: string;
  /** Separator BEFORE this syllable ('' line start, '/' word-internal, ' ' word boundary). */
  sep: string;
  lineIndex: number;
  sylIndex: number;
}

/** Flatten a track's lines into the global syllable order used everywhere. */
export function flattenSyllablesForAlignment(lines: Line[]): FlatSyllable[] {
  const out: FlatSyllable[] = [];
  lines.forEach((line, lineIndex) => {
    line.syllables.forEach((syl, sylIndex) => {
      out.push({ text: syl.text, sep: syl.sep ?? '', lineIndex, sylIndex });
    });
  });
  return out;
}

/**
 * A word = consecutive syllables NOT separated by a space (sep '/' or '' keeps
 * a syllable in the same word; sep ' ' starts a new one).
 */
export interface AlignWord {
  /** Indices into the flat syllable array. */
  syllables: number[];
  /** Uppercased letter tokens (punctuation stripped); may be empty. */
  tokenIds: number[];
}

/** Split flat syllables into words and tokenize each word to CTC token ids. */
export function buildWords(flat: FlatSyllable[]): AlignWord[] {
  const words: AlignWord[] = [];
  let cur: AlignWord | null = null;
  let prevLine = -1;
  flat.forEach((syl, i) => {
    if (!cur || syl.sep === ' ' || syl.lineIndex !== prevLine) {
      cur = { syllables: [], tokenIds: [] };
      words.push(cur);
    }
    prevLine = syl.lineIndex;
    cur.syllables.push(i);
    for (const ch of syl.text.toUpperCase()) {
      const id = LETTER_IDS[ch];
      if (id !== undefined) cur.tokenIds.push(id);
    }
  });
  return words;
}

/**
 * The full CTC transcript: words joined by the `|` separator. Words with no
 * letters (pure punctuation) are skipped — they carry no sound. `tokenWord`
 * maps every token to its word index (-1 for the separators).
 */
export function buildTranscript(words: AlignWord[]): { tokens: number[]; tokenWord: number[] } {
  const tokens: number[] = [];
  const tokenWord: number[] = [];
  let first = true;
  words.forEach((w, wi) => {
    if (w.tokenIds.length === 0) return;
    if (!first) {
      tokens.push(WORDSEP_ID);
      tokenWord.push(-1);
    }
    first = false;
    for (const t of w.tokenIds) {
      tokens.push(t);
      tokenWord.push(wi);
    }
  });
  return { tokens, tokenWord };
}

/**
 * CTC Viterbi forced alignment (torchaudio.functional.forced_align port).
 *
 * States are [blank, t0, blank, t1, blank, …] (2L+1). Per frame a state may
 * stay, come from the previous state, or — when a token repeats — skip over
 * the blank between the two identical token states.
 *
 * @param logProbs Float32Array of shape [T, V] — per-frame log-softmax.
 * @param tokens   transcript token ids (values < V).
 * @returns the frame index per transcript token (-1 if never emitted) + score.
 */
export function ctcForcedAlign(
  logProbs: Float32Array,
  T: number,
  V: number,
  tokens: number[],
): { frames: Int32Array; score: number } {
  const L = tokens.length;
  const S = 2 * L + 1;
  const NEG_INF = -1e30;

  const scores = new Float64Array(S).fill(NEG_INF);
  const next = new Float64Array(S).fill(NEG_INF);
  const backptr = new Int32Array(T * S);

  scores[0] = logProbs[BLANK_ID];
  if (S > 1) scores[1] = logProbs[tokens[0]];

  for (let t = 1; t < T; t++) {
    const base = t * V;
    for (let s = 0; s < S; s++) {
      // Candidates: stay (s), step from the previous state (s-1), or — when a
      // token repeats — skip over the blank between the two identical tokens.
      // NOTE: no reachability guard here — a state unreachable via "stay" may
      // still be reachable from s-1/s-2.
      let bestSrc = s;
      let best = scores[s];
      const fromPrev = s >= 1 ? scores[s - 1] : NEG_INF;
      if (fromPrev > best) {
        best = fromPrev;
        bestSrc = s - 1;
      }
      if (s >= 2 && s % 2 === 1) {
        const tok = tokens[(s - 1) / 2];
        const prevTok = tokens[(s - 3) / 2];
        if (tok === prevTok && scores[s - 2] > best) {
          best = scores[s - 2];
          bestSrc = s - 2;
        }
      }
      const emit = s % 2 === 0 ? logProbs[base + BLANK_ID] : logProbs[base + tokens[(s - 1) / 2]];
      next[s] = best + emit;
      backptr[t * S + s] = bestSrc;
    }
    scores.set(next);
    next.fill(NEG_INF);
  }

  let s = scores[S - 1] >= scores[S - 2] ? S - 1 : S - 2;
  const score = scores[s];
  const frames = new Int32Array(L).fill(-1);
  for (let t = T - 1; t >= 0; t--) {
    if (s % 2 === 1) frames[(s - 1) / 2] = t;
    s = backptr[t * S + s];
  }
  return { frames, score };
}

/** Stitch chunked logits: keep [0, keep) frames of every chunk but the last. */
export function stitchChunks(
  chunks: Array<{ logits: Float32Array; frames: number; keep: number }>,
  V: number,
): Float32Array {
  let total = 0;
  chunks.forEach((c, i) => { total += i === chunks.length - 1 ? c.frames : c.keep; });
  const out = new Float32Array(total * V);
  let off = 0;
  chunks.forEach((c, i) => {
    const n = (i === chunks.length - 1 ? c.frames : c.keep) * V;
    out.set(c.logits.subarray(0, n), off);
    off += n;
  });
  return out;
}

/** Letter weight of a syllable (punctuation ignored) for proportional splits. */
function letterWeight(text: string): number {
  let n = 0;
  for (const ch of text.toUpperCase()) if (LETTER_IDS[ch] !== undefined) n++;
  return Math.max(1, n);
}

/**
 * Convert per-token frames (the FULL transcript stream from buildTranscript,
 * separators included) into syllable start times in milliseconds.
 *
 * Strategy 'proportional' (default): each word's span comes from its own
 * first/last token frames; syllable starts inside are distributed by letter
 * weight. Smooth — robust to char-level jitter.
 * Strategy 'chars': each syllable starts at the frame of its first letter.
 *
 * Words with no tokens (punctuation-only) are interpolated between the
 * surrounding words. Output is strictly increasing, clamped to [0, durationMs].
 */
export function distributeSyllableTimes(
  words: AlignWord[],
  tokenWord: number[],
  frames: Int32Array,
  flat: FlatSyllable[],
  frameMs: number,
  durationMs: number,
  strategy: 'proportional' | 'chars' = 'proportional',
): number[] {
  const nSyl = flat.length;
  const starts = new Array<number>(nSyl).fill(-1);

  // Word spans + each word's start index in the transcript token stream.
  const spanFrom = new Array<number>(words.length).fill(-1);
  const spanTo = new Array<number>(words.length).fill(-1);
  const wordTokenStart = new Array<number>(words.length).fill(-1);
  {
    let ti = 0;
    words.forEach((w, wi) => {
      if (w.tokenIds.length === 0) return;
      if (ti < tokenWord.length && tokenWord[ti] === -1) ti++; // separator before this word
      wordTokenStart[wi] = ti;
      for (let k = 0; k < w.tokenIds.length; k++, ti++) {
        const f = frames[ti];
        if (f < 0) continue;
        if (spanFrom[wi] < 0 || f < spanFrom[wi]) spanFrom[wi] = f;
        if (f > spanTo[wi]) spanTo[wi] = f;
      }
    });
  }

  // Interpolation ranges for token-less words (punctuation only).
  const interp = new Map<number, [number, number]>();
  words.forEach((w, i) => {
    if (w.tokenIds.length > 0) return;
    let prev = -1;
    for (let j = i - 1; j >= 0; j--) if (words[j].tokenIds.length > 0) { prev = j; break; }
    let nextA = -1;
    for (let j = i + 1; j < words.length; j++) if (words[j].tokenIds.length > 0) { nextA = j; break; }
    const from = prev >= 0 ? spanTo[prev] * frameMs : 0;
    const to = nextA >= 0 ? spanFrom[nextA] * frameMs : durationMs;
    interp.set(i, [Math.max(0, from), Math.min(durationMs, Math.max(from, to))]);
  });

  words.forEach((w, wi) => {
    const hasTokens = w.tokenIds.length > 0;
    const from = hasTokens ? spanFrom[wi] * frameMs : interp.get(wi)![0];
    const to = hasTokens ? Math.max(spanTo[wi] * frameMs, from + 1) : interp.get(wi)![1];

    if (strategy === 'chars' && hasTokens) {
      let consumed = 0;
      for (const sylIdx of w.syllables) {
        const need = letterWeight(flat[sylIdx].text);
        let first = -1;
        for (let k = 0; k < need && consumed < w.tokenIds.length; k++, consumed++) {
          const f = frames[wordTokenStart[wi] + consumed];
          if (f >= 0 && first < 0) first = f;
        }
        starts[sylIdx] = first >= 0 ? first * frameMs : from;
      }
      return;
    }
    // proportional
    const weights = w.syllables.map((idx) => letterWeight(flat[idx].text));
    const total = weights.reduce((s, x) => s + x, 0) || 1;
    let acc = 0;
    w.syllables.forEach((sylIdx, k) => {
      starts[sylIdx] = k === 0 ? from : from + ((to - from) * acc) / total;
      acc += weights[k];
    });
  });

  // Monotonic + clamp.
  let prevMs = -Infinity;
  for (let i = 0; i < nSyl; i++) {
    let v = starts[i] < 0 ? (Number.isFinite(prevMs) ? prevMs + 1 : 0) : starts[i];
    v = Math.max(0, Math.min(durationMs, v));
    if (v <= prevMs) v = prevMs + 1;
    if (v > durationMs) v = Math.max(0, durationMs);
    starts[i] = Math.round(v);
    prevMs = starts[i];
  }
  return starts;
}
