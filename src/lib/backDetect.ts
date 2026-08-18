/**
 * "Is there actually a backing vocal?" detector for the separation pipeline.
 *
 * Many songs have NO backing vocals at all — but the phase-2 (lead/back) model
 * still tears a quiet residual of the LEAD vocal into the back stem, "everywhere,
 * very quiet". Loading that as a "Бэк" track is noise for the user, and keeping
 * the phase-2 split carves audible holes into the lead.
 *
 * Discriminator (both conditions must hold to call the back stem leakage):
 *  - the back stem is far below the lead in OVERALL energy (RMS ratio), AND
 *  - it NEVER gets close in loudness — its loudest window stays well below the
 *    lead's loudest window. A real back (even mixed low) peaks up in choruses.
 *
 * Pure channel math, unit-testable in Node. The caller acts on the verdict:
 * leakage → the lead becomes the FULL phase-1 vocal stem and no back stem is
 * produced (see separateFull).
 */

export interface BackVocalsVerdict {
  /** false = the back stem is just lead leakage; there are no backing vocals. */
  backVocals: boolean;
  /** Whole-track back/lead RMS ratio in dB (−Infinity for a silent back). */
  ratioDb: number;
  /** Loudest-window back/lead RMS ratio in dB. */
  peakDb: number;
}

/** Analysis window for the peak comparison (ms). */
const WINDOW_MS = 100;
/** Drop when the back stem is quieter than the lead overall by more than this. */
const RATIO_DB = -15;
/** …AND when even its loudest window stays this far below the lead's peak. */
const PEAK_DB = -9;

/**
 * Compare the lead and back stems (same scale, channel 0 is representative).
 * Returns the verdict + the measured levels (for tests/diagnostics).
 */
export function detectBackingVocals(
  lead: Float32Array,
  back: Float32Array,
  sampleRate: number,
): BackVocalsVerdict {
  const n = Math.min(lead.length, back.length);
  const rms = (data: Float32Array): number => {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += data[i] * data[i];
    return Math.sqrt(acc / Math.max(1, n));
  };
  const leadRms = rms(lead);
  const backRms = rms(back);

  // Peak window RMS per stem (100 ms windows, no overlap).
  const win = Math.max(1, Math.round((WINDOW_MS / 1000) * sampleRate));
  const maxWindow = (data: Float32Array): number => {
    let max = 0;
    for (let s = 0; s + win <= n || s < n; s += win) {
      const e = Math.min(n, s + win);
      let acc = 0;
      let cnt = 0;
      for (let i = s; i < e; i++) {
        acc += data[i] * data[i];
        cnt++;
      }
      const r = Math.sqrt(acc / Math.max(1, cnt));
      if (r > max) max = r;
      if (e >= n) break;
    }
    return max;
  };
  const leadPeak = maxWindow(lead);
  const backPeak = maxWindow(back);

  const db = (v: number, ref: number): number => (ref > 0 ? 20 * Math.log10(Math.max(v, 1e-12) / ref) : v > 0 ? 40 : -Infinity);
  const ratioDb = db(backRms, leadRms);
  const peakDb = db(backPeak, leadPeak);

  // A silent/degenerate lead can't be judged by ratio — keep whatever is there.
  if (leadRms < 1e-6) {
    return { backVocals: backRms > 1e-4, ratioDb, peakDb };
  }
  return { backVocals: !(ratioDb < RATIO_DB && peakDb < PEAK_DB), ratioDb, peakDb };
}
