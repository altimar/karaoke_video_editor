/**
 * Background-video filmstrip: a sparse strip of decoded thumbnails for the
 * timeline's «Фон» row.
 *
 * Frames are extracted OFFLINE — no <video> playback: mediabunny demuxes the
 * MP4 and WebCodecs VideoDecoder decodes frames at the requested (sparse,
 * monotonically sorted) timestamps, so each packet is decoded at most once and
 * keyframes do the heavy lifting. One thumbnail every few seconds; the count
 * is capped so huge videos stay cheap.
 *
 * The result is cached keyed by the bytes object identity (there is at most
 * one bg video at a time; loadBgVideo/clearBgVideo replace the bytes object,
 * which invalidates the cache naturally).
 */
import { Input, BlobSource, Mp4InputFormat, VideoSampleSink } from 'mediabunny';

/** One filmstrip cell: a decoded thumbnail + its source time. */
export interface BgThumb {
  tSec: number;
  canvas: HTMLCanvasElement;
}

/** A built filmstrip: thumbnails + sampling interval + the video's duration. */
export interface BgFilmstrip {
  thumbs: BgThumb[];
  intervalSec: number;
  durationSec: number;
}

/** How often a thumbnail is taken (seconds of video). */
export const THUMB_INTERVAL_SEC = 2;
/** Cap so very long videos don't explode the count. */
const MAX_THUMBS = 400;
/** Thumbnail pixel height (drawn into a ~30px row, ×2 for retina sharpness). */
const THUMB_H = 64;

let cache: { src: Uint8Array; strip: BgFilmstrip } | null = null;
let building = false;
/** Fired once a fresh filmstrip finished building (timeline redraws). */
let onReady: (() => void) | null = null;

/** Register the redraw callback (the timeline). */
export function setFilmstripOnReady(cb: () => void): void {
  onReady = cb;
}

/**
 * Get the filmstrip for these bytes, kicking off an async build if stale.
 * Returns null while building/failed — the row falls back to the status text.
 * Synchronous when the cache is fresh (the normal case after first build).
 */
export function ensureBgFilmstrip(bytes: Uint8Array): BgFilmstrip | null {
  if (cache && cache.src === bytes) return cache.strip;
  if (building) return null;
  building = true;
  void build(bytes)
    .then((strip) => {
      cache = { src: bytes, strip };
    })
    .catch(() => {
      // decode failed → cache the empty result so we don't retry forever
      cache = { src: bytes, strip: { thumbs: [], intervalSec: THUMB_INTERVAL_SEC, durationSec: 0 } };
    })
    .finally(() => {
      building = false;
      onReady?.();
    });
  return null;
}

/** Drop the cache (e.g. when the bg video is cleared). */
export function invalidateBgFilmstrip(): void {
  cache = null;
}

/** Peek at the cache WITHOUT triggering a build (E2E hook / debugging). */
export function peekBgFilmstrip(): { count: number; intervalSec: number } | null {
  return cache ? { count: cache.strip.thumbs.length, intervalSec: cache.strip.intervalSec } : null;
}

/** The interval actually used for the last build (exposed for tile math). */
export function thumbIntervalFor(durationSec: number): number {
  return Math.max(THUMB_INTERVAL_SEC, durationSec / MAX_THUMBS);
}

/** Decode one thumbnail per `interval` seconds into small canvases. */
async function build(bytes: Uint8Array): Promise<BgFilmstrip> {
  const input = new Input({
    formats: [new Mp4InputFormat()],
    source: new BlobSource(new Blob([bytes.buffer as ArrayBuffer], { type: 'video/mp4' })),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return { thumbs: [], intervalSec: THUMB_INTERVAL_SEC, durationSec: 0 };
    const durationSec = await track.computeDuration();
    const interval = thumbIntervalFor(durationSec);
    const sink = new VideoSampleSink(track);

    const times: number[] = [];
    for (let t = 0; t < durationSec; t += interval) times.push(t);

    const thumbs: BgThumb[] = [];
    for await (const sample of sink.samplesAtTimestamps(times)) {
      if (!sample) continue;
      const src = sample.toCanvasImageSource();
      const w = Math.max(1, Math.round((sample.displayWidth / sample.displayHeight) * THUMB_H));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = THUMB_H;
      c.getContext('2d')!.drawImage(src, 0, 0, w, THUMB_H);
      sample.close();
      thumbs.push({ tSec: sample.timestamp, canvas: c });
    }
    return { thumbs, intervalSec: interval, durationSec };
  } finally {
    input.dispose();
  }
}
