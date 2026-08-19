/**
 * App-level settings, persisted in localStorage — GLOBAL for the browser,
 * independent of any project (unlike the project model).
 *
 * Tiny reactive store: get / update(patch) / subscribe. Consumers read the
 * current value when an operation starts (e.g. the separation runner picks
 * the karaoke model variant at run time).
 */

export interface AppSettings {
  /**
   * Phase-2 (lead/back) separation model variant:
   *  - 'fp32' — the original graph-surgered export, ~876 MB weights;
   *  - 'fp16' — half-precision conversion, ~440 MB: halves VRAM and speeds
   *    kernels up — the fallback for weaker GPUs (device-lost/TDR fixes).
   */
  karaokeModel: 'fp32' | 'fp16';
}

const DEFAULTS: AppSettings = { karaokeModel: 'fp32' };
const STORAGE_KEY = 'app-settings';

type Listener = (s: AppSettings) => void;
const listeners = new Set<Listener>();

function read(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      karaokeModel: parsed.karaokeModel === 'fp16' ? 'fp16' : 'fp32',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let current: AppSettings = read();

/** The current settings (live object — treat as read-only). */
export function getSettings(): AppSettings {
  return current;
}

/** Update fields, persist, and notify subscribers. */
export function updateSettings(patch: Partial<AppSettings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable — keep the in-memory value */
  }
  for (const l of listeners) l(current);
}

export function subscribeSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
