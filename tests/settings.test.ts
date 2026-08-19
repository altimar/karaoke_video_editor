// @vitest-environment jsdom
/**
 * App settings: localStorage-backed global store (defaults, persistence,
 * notifications, corrupt-storage self-healing).
 */
import { test, vi, expect, beforeEach } from 'vitest';

const KEY = 'app-settings';

// This Vitest/jsdom setup has NO localStorage (opaque origin) — stub an
// in-memory Storage so the module under test exercises its real code path.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  clear(): void {
    this.map.clear();
  }
}
let storage = new MemoryStorage();
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

test('defaults + update + persistence + notify', async () => {
  vi.resetModules();
  const { getSettings, updateSettings, subscribeSettings } = await import('../src/lib/settings');

  expect(getSettings().karaokeModel).toBe('fp32'); // default

  const seen: string[] = [];
  const unsub = subscribeSettings((s) => seen.push(s.karaokeModel));

  updateSettings({ karaokeModel: 'fp16' });
  expect(getSettings().karaokeModel).toBe('fp16');
  expect(JSON.parse(localStorage.getItem(KEY)!).karaokeModel).toBe('fp16');
  expect(seen).toEqual(['fp16']);

  unsub();
  updateSettings({ karaokeModel: 'fp32' });
  expect(seen).toEqual(['fp16']); // no notifications after unsubscribe

  // Persists across module reloads (the "new page" simulation).
  vi.resetModules();
  const reloaded = await import('../src/lib/settings');
  expect(reloaded.getSettings().karaokeModel).toBe('fp32');
});

test('corrupt or unknown stored values fall back to defaults', async () => {
  localStorage.setItem(KEY, '{not json');
  vi.resetModules();
  const { getSettings } = await import('../src/lib/settings');
  expect(getSettings().karaokeModel).toBe('fp32');

  localStorage.setItem(KEY, JSON.stringify({ karaokeModel: 'quantum' }));
  vi.resetModules();
  const again = await import('../src/lib/settings');
  expect(again.getSettings().karaokeModel).toBe('fp32'); // unknown variant → default
});
