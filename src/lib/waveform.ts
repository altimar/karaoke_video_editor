/**
 * Waveform peak computation.
 *
 * Turns a decoded AudioBuffer into a fixed number of vertical peaks (0..1) for
 * drawing a waveform overview. We downsample by scanning the PCM in fixed-size
 * buckets and taking the max absolute amplitude per bucket — cheap, and the
 * result is cached by (buffer identity + bucket count) so the timeline can
 * redraw freely without recomputing.
 *
 * We use the first channel (a mono mixdown isn't worth the cost for an overview);
 * if the buffer is multi-channel, we read channel 0 which is representative.
 */

export interface WaveformPeaks {
  /** Normalized peak amplitudes in [0, 1], one per pixel column. */
  peaks: Float32Array;
  /** The maximum absolute sample value found, used for normalization. */
  max: number;
}

const cache = new WeakMap<AudioBuffer, Map<number, WaveformPeaks>>();

/**
 * Compute `buckets` peaks for the given buffer. Results are cached per buffer
 * (WeakMap) keyed by bucket count, so repeated calls with the same width are free.
 */
export function computePeaks(buffer: AudioBuffer, buckets: number): WaveformPeaks {
  buckets = Math.max(1, Math.floor(buckets));
  let perWidth = cache.get(buffer);
  if (!perWidth) {
    perWidth = new Map();
    cache.set(buffer, perWidth);
  }
  const cached = perWidth.get(buckets);
  if (cached) return cached;

  const data = buffer.getChannelData(0);
  const len = data.length;
  const peaks = new Float32Array(buckets);

  // First pass: find raw max amplitude and fill buckets with max-abs per bucket.
  let globalMax = 0;
  const samplesPerBucket = Math.max(1, Math.floor(len / buckets));
  for (let b = 0; b < buckets; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(len, start + samplesPerBucket);
    let bucketMax = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(data[i]);
      if (v > bucketMax) bucketMax = v;
    }
    if (bucketMax > globalMax) globalMax = bucketMax;
    peaks[b] = bucketMax;
  }

  // Normalize so the loudest bucket reaches 1.0 (avoids tiny waveforms on quiet
  // tracks). Guard against silence to avoid divide-by-zero.
  const norm = globalMax > 0 ? 1 / globalMax : 0;
  for (let b = 0; b < buckets; b++) peaks[b] *= norm;

  const result = { peaks, max: globalMax };
  perWidth.set(buckets, result);
  return result;
}
