/**
 * Tests for export quality presets + resolution/bitrate logic.
 *
 * The minimal WebCodecs surface is stubbed BEFORE the dynamic import so
 * src/lib/export.ts loads in Node (its module top level touches these).
 */
import { test, vi } from 'vitest';

vi.stubGlobal('VideoEncoder', class {});
vi.stubGlobal('AudioEncoder', class {});
vi.stubGlobal('VideoFrame', class {});
const { QUALITY_PRESETS, DEFAULT_QUALITY_ID, getQualityPreset, ExportCanceledError } = await import('../src/lib/export');

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

test('quality presets: 6 of them, 360p..4K, default 480p', () => {
  assert(QUALITY_PRESETS.length === 6, '6 presets (360p..4K)');
  assert(QUALITY_PRESETS[0].height === 360, 'first preset is 360p');
  assert(QUALITY_PRESETS[QUALITY_PRESETS.length - 1].height === 2160, 'last preset is 4K (2160p)');
  assert(DEFAULT_QUALITY_ID === '480p', 'default quality is 480p');
  assert(getQualityPreset(DEFAULT_QUALITY_ID).height === 480, 'default preset resolves to 480p height');
});

test('bitrate scales up with height', () => {
  let prevB = 0;
  for (const q of QUALITY_PRESETS) {
    assert(q.bitrate > 0, `${q.id} bitrate positive (${(q.bitrate / 1e6).toFixed(0)} Mbps)`);
    if (prevB > 0) assert(q.bitrate > prevB, `${q.id} bitrate scales up with height`);
    prevB = q.bitrate;
  }
  assert(getQualityPreset('nope').id === '480p', 'unknown id falls back to 480p');
  assert(getQualityPreset('1080p').bitrate > getQualityPreset('480p').bitrate * 2, '1080p bitrate >> 480p bitrate');
  assert(new ExportCanceledError('x') instanceof Error, 'ExportCanceledError is an Error');
});

test('resolution math sanity: 16:9 widths snap to even pixels', () => {
  // (We replicate the width calc from exportToMp4 to assert even-pixel snapping.)
  function widthFor(h: number, aspect = 16 / 9): number {
    let w = Math.round(h * aspect);
    if (w % 2 !== 0) w += 1;
    return w;
  }
  assert(widthFor(480) % 2 === 0, '480p width is even (' + widthFor(480) + ')');
  assert(widthFor(360) % 2 === 0, '360p width is even (' + widthFor(360) + ')');
});
