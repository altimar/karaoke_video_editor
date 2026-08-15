/**
 * Standalone render-logic test (no DOM, no real canvas).
 *
 * Runs renderFrame against a recording fake 2D context that captures every
 * drawing call. This verifies the renderer's logic (background draw order,
 * syllable fill via clip, stroke pass, active-syllable scale) without needing
 * a browser or a canvas implementation.
 */
import { test } from 'vitest';
import { renderFrame } from '../src/lib/render';
import { buildTimings, progress } from '../src/lib/text_renderers/helpers';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

/** Build a recording fake context implementing exactly the methods render uses. */
function makeFakeCtx(measure = 40) {
  const calls: any[] = [];
  const state: Record<string, unknown> = {
    fillStyle: '#000',
    strokeStyle: '#000',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    lineJoin: 'miter',
    globalAlpha: 1,
    shadowBlur: 0,
    shadowColor: 'rgba(0,0,0,0)',
  };
  const ctx: any = {
    clearRect: (...a: any[]) => calls.push(['clearRect', ...a]),
    fillRect: (...a: any[]) => calls.push(['fillRect', ...a]),
    drawImage: (...a: any[]) => calls.push(['drawImage', ...a]),
    createLinearGradient: (...a: any[]) => {
      calls.push(['createLinearGradient', ...a]);
      const g = { stops: [] as Array<[number, string]>, addColorStop: (off: number, col: string) => g.stops.push([off, col]) };
      return g;
    },
    measureText: (text: string) => {
      calls.push(['measureText', text]);
      return { width: measure * (text.length || 1) };
    },
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (...a: any[]) => calls.push(['translate', ...a]),
    scale: (...a: any[]) => calls.push(['scale', ...a]),
    beginPath: () => calls.push(['beginPath']),
    rect: (...a: any[]) => calls.push(['rect', ...a]),
    clip: () => calls.push(['clip']),
    fillText: (text: string, x: number, y: number) => calls.push(['fillText', text, Math.round(x), Math.round(y), state.fillStyle]),
    strokeText: (text: string, x: number, y: number) => calls.push(['strokeText', text, Math.round(x), Math.round(y), state.strokeStyle]),
  };
  for (const k of Object.keys(state)) {
    Object.defineProperty(ctx, k, {
      get: () => state[k],
      set: (v: unknown) => { state[k] = v; },
    });
  }
  return { ctx, calls };
}

function count(calls: any[], name: string): number {
  return calls.filter((c) => c[0] === name).length;
}

// --- A project with known timings ---
const project: any = {
  audioFileName: 'x.wav',
  durationMs: 4000,
  fps: 30,
  width: 1920,
  height: 1080,
  background: {
    bgType: 'color',
    bgColor: '#0e0f1a',
    bgColors: ['#1a1033', '#0e0f1a'],
    bgImageDataUrl: null,
  },
  tracks: [
    {
      id: 't1',
      type: 'text',
      name: 'Дорожка 1',
      style: {
        fontFamily: 'Arial',
        fontSize: 64,
        fontWeight: 700,
        lineHeight: 1.4,
        textAlign: 'center',
        colorBase: 'rgba(255,255,255,0.35)',
        colorHighlight: '#ffe14d',
        strokeWidth: 3,
        strokeColorActive: '#000',
        strokeColorInactive: '#010101',
        glowBlur: 24,
        glowColor: '#ffb400',
        layout: 'scroller',
      },
      rendererSettings: {
        scroller: { previewSec: 10 },
      },
      lines: [
        {
          syllables: [
            { text: 'При', startMs: 0 },
            { text: 'вет', startMs: 1000 },
            { text: ' мир', startMs: 2000 },
          ],
        },
        {
          syllables: [
            { text: 'Как', startMs: 3000 },
          ],
        },
      ],
    },
  ],
};

/** Helper: the single track of the default `project` fixture (tests mutate it). */
function track(p: any = project): any {
  return p.tracks[0];
}

test('background + text + stroke are drawn', () => {
  const { ctx, calls } = makeFakeCtx(40);
  renderFrame(ctx, 0, project);
  assert(count(calls, 'clearRect') === 1, 'clears the frame once');
  assert(count(calls, 'fillRect') >= 1, 'fills background');
  assert(count(calls, 'fillText') >= 1, 'draws text (fillText)');
  assert(count(calls, 'strokeText') >= 1, 'draws stroke outline');
});

test('mid-fill of a syllable: base pass + clipped highlight pass', () => {
  const { ctx, calls } = makeFakeCtx(40);
  renderFrame(ctx, 500, project); // halfway through syllable 1 (0..1000)
  const fills = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  const priCount = fills.filter((t) => t === 'При').length;
  assert(priCount === 2, `first syllable filled twice (base + highlight), got ${priCount}`);
  assert(count(calls, 'clip') >= 1, 'uses clip for the highlight wipe');
});

test('fully-filled syllable shows highlight color', () => {
  const { ctx, calls } = makeFakeCtx(40);
  renderFrame(ctx, 1500, project); // syllable 1 fully done, syllable 2 mid
  const priFills = calls.filter((c) => c[0] === 'fillText' && c[1] === 'При').map((c) => c[4]);
  assert(priFills.includes('#ffe14d'), 'completed syllable shows highlight color (#ffe14d)');
});

test('spacing: slash-joined syllables have NO gap, space-separated have a real space', () => {
  const { ctx, calls } = makeFakeCtx(40);
  // Line: "При/вет" (slash, one word) + "мир" (space, separate word).
  // Layout uses `sep` to insert the space; we test the rendered X positions.
  const p = JSON.parse(JSON.stringify(project));
  track(p).lines = [
    {
      syllables: [
        { text: 'При', startMs: 0, sep: '' },
        { text: 'вет', startMs: 1000, sep: '/' },
        { text: 'мир', startMs: 2000, sep: ' ' },
      ],
    },
  ];
  renderFrame(ctx, 100, p);
  const fills = calls.filter((c) => c[0] === 'fillText');
  const pri = fills.find((c) => c[1] === 'При');
  const vet = fills.find((c) => c[1] === 'вет');
  const mir = fills.find((c) => c[1] === 'мир');
  assert(pri && vet && mir, 'all three syllables rendered');
  // "При" width = 3 chars * 40 = 120 (fake measureText). "вет" right after: no gap.
  const priW = 3 * 40;
  assert(Math.abs((vet[2] - pri[2]) - priW) < 1, `slash: no gap between pieces (gap=${vet[2] - pri[2] - priW})`);
  // "мир" preceded by a space: gap = measureText(' ') width = 40 in fake ctx.
  const vetW = 3 * 40;
  const spaceW = 40; // measureText(' ') for 1-char string in fake ctx
  const expectedMirX = vet[2] + vetW + spaceW;
  assert(Math.abs(mir[2] - expectedMirX) < 1, `space: real space gap between words (got X=${mir[2]}, expected=${expectedMirX})`);
});

test('gradient background builds a gradient', () => {
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  p.background.bgType = 'gradient';
  renderFrame(ctx, 0, p);
  assert(count(calls, 'createLinearGradient') === 1, 'gradient background builds a gradient');
});

test('zero stroke disables strokeText', () => {
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.strokeWidth = 0;
  renderFrame(ctx, 0, p);
  assert(count(calls, 'strokeText') === 0, 'strokeWidth=0 disables outline');
});

// IMPORTANT: untimed syllables are intentionally invisible — in preview AND
// export — until they get a timing (see AGENTS.md invariants).
test('untimed syllables do NOT render', () => {
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  track(p).lines[0].syllables[1].startMs = null; // "вет" untimed
  renderFrame(ctx, 500, p);
  const texts = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert(!texts.includes('вет'), 'untimed syllable is NOT rendered');
});

test('all-untimed renders only background', () => {
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  track(p).lines.forEach((l: any) => l.syllables.forEach((s: any) => (s.startMs = null)));
  renderFrame(ctx, 1500, p);
  assert(count(calls, 'fillText') === 0, 'all-untimed renders no text');
  assert(count(calls, 'strokeText') === 0, 'all-untimed renders no strokes');
});

test('timed syllables in a partially-timed line render; untimed ones don\'t', () => {
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  track(p).lines[0].syllables[1].startMs = null;
  track(p).lines[0].syllables[2].startMs = null;
  renderFrame(ctx, 100, p);
  const texts = new Set(calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  assert(texts.has('При'), 'timed syllable renders');
  assert(!texts.has('вет') && !texts.has(' мир'), 'untimed syllables NOT rendered');
});

test('scroller: active line drawn, lines beyond previewSec hidden', () => {
  const { ctx, calls } = makeFakeCtx(40);
  // 6 lines, each with one timed syllable 1s apart; line 0 active at t=0.
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.layout = 'scroller';
  // previewSec=2 → only lines within ~2s ahead are on the bottom half of screen.
  track(p).rendererSettings.scroller.previewSec = 2;
  track(p).lines = Array.from({ length: 6 }, (_, i) => ({
    syllables: [{ text: `L${i}`, startMs: i * 1000 }],
  }));
  p.durationMs = 7000;
  renderFrame(ctx, 100, p); // active line 0
  const texts = new Set(calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  assert(texts.has('L0'), 'scroller shows active line L0');
  // L5 is 5s ahead — well beyond the 2s preview, off the bottom of the screen.
  assert(!texts.has('L5'), 'scroller hides far-below line L5 (beyond previewSec)');
});

test('scroller: constant speed + each line at CENTER at its anchor time', () => {
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.layout = 'scroller';
  track(p).rendererSettings.scroller.previewSec = 10;
  // Evenly-spaced lines (0, 1000, 2000, ...) so speed is well-defined.
  track(p).lines = Array.from({ length: 10 }, (_, i) => ({ syllables: [{ text: `W${i}`, startMs: i * 1000, sep: '' }] }));
  p.durationMs = 12000;

  const yOf = (label: string, t: number): number | null => {
    const rec = makeFakeCtx(40);
    renderFrame(rec.ctx, t, p);
    const hit = rec.calls.find((c) => c[0] === 'fillText' && c[1] === label);
    return hit ? hit[3] : null;
  };
  const centerY = 1080 / 2;

  // 1. Each line at center at its startMs.
  assert(Math.abs((yOf('W0', 0) as number) - centerY) < 2, 'W0 at center at t=0');
  assert(Math.abs((yOf('W3', 3000) as number) - centerY) < 2, 'W3 at center at t=3000');
  assert(Math.abs((yOf('W5', 5000) as number) - centerY) < 2, 'W5 at center at t=5000');

  // 2. Constant speed: sample W0 over time, speed should be the same.
  const samples = [0, 200, 400, 600, 800].map((t) => ({ t, y: yOf('W0', t) }));
  assert(samples.every((s) => s.y !== null), 'W0 rendered across samples');
  const speeds: number[] = [];
  for (let i = 1; i < samples.length; i++) speeds.push((samples[i - 1].y as number) - (samples[i].y as number));
  const allClose = speeds.every((s) => Math.abs(s - speeds[0]) < 1.5);
  assert(allClose, `constant speed (${speeds.map((s) => s.toFixed(1)).join(', ')} px/200ms)`);
  assert(speeds[0] > 0, 'text moves upward (speed > 0)');
});

test('scroller: several lines visible — active at center plus upcoming', () => {
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.layout = 'scroller';
  track(p).rendererSettings.scroller.previewSec = 10;
  // 10 lines 2s apart; at t=5000 the active line is X2 (start 4000).
  track(p).lines = Array.from({ length: 10 }, (_, i) => ({ syllables: [{ text: `X${i}`, startMs: i * 2000 }] }));
  p.durationMs = 22000;
  const rec = makeFakeCtx(40);
  renderFrame(rec.ctx, 5000, p); // mid-scroll
  const labels = new Set(rec.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  // The active line + past lines + a couple upcoming lines are on screen.
  assert(labels.size >= 3, `several lines visible with previewSec=10 (got ${labels.size})`);
  assert(labels.has('X2'), 'active line X2 visible');
});

test('scroller: fill starts at the CENTER — an entering line is unfilled', () => {
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.layout = 'scroller';
  track(p).rendererSettings.scroller.previewSec = 10;
  track(p).lines = [
    { syllables: [{ text: 'A', startMs: 1000 }] },
    { syllables: [{ text: 'B', startMs: 2000 }] },
  ];
  p.durationMs = 4000;
  // At t=500, line A is below center (entering from the bottom). Its fill should
  // be 0 — i.e. NOT yet filled (only base color, no highlight color).
  const rec = makeFakeCtx(40);
  renderFrame(rec.ctx, 500, p);
  // Find fillText calls for 'A': there should be exactly ONE (base pass only),
  // meaning progress is 0. If progress > 0 there'd be two (base + highlight).
  const aFills = rec.calls.filter((c) => c[0] === 'fillText' && c[1] === 'A');
  assert(aFills.length === 1, `entering line 'A' is unfilled at t=500 (1 fillText = base only, got ${aFills.length})`);
});

test('scroller: NEXT line renders BELOW the previous one (order regression)', () => {
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.layout = 'scroller';
  track(p).rendererSettings.scroller.previewSec = 10;
  track(p).lines = [
    { syllables: [{ text: 'FIRST', startMs: 0 }] },
    { syllables: [{ text: 'SECOND', startMs: 1000 }] },
    { syllables: [{ text: 'THIRD', startMs: 2000 }] },
  ];
  p.durationMs = 4000;
  const rec = makeFakeCtx(40);
  renderFrame(rec.ctx, 0, p);
  const yOf = (label: string): number | null => {
    const hit = rec.calls.find((c) => c[0] === 'fillText' && c[1] === label);
    return hit ? hit[3] : null;
  };
  const yFirst = yOf('FIRST');
  const ySecond = yOf('SECOND');
  const yThird = yOf('THIRD');
  assert(yFirst !== null && ySecond !== null && yThird !== null, 'all three lines rendered at t=0');
  // SECOND must be BELOW FIRST (larger Y), and THIRD below SECOND.
  assert((ySecond as number) > (yFirst as number), `SECOND below FIRST (SECOND=${ySecond}, FIRST=${yFirst})`);
  assert((yThird as number) > (ySecond as number), `THIRD below SECOND (THIRD=${yThird}, SECOND=${ySecond})`);
});

test('MULTIPLE tracks render independently in one frame', () => {
  const p = JSON.parse(JSON.stringify(project));
  p.tracks = [
    {
      id: 't1',
      type: 'text', name: 'Lead',
      style: { ...track(p).style },
      rendererSettings: { scroller: { previewSec: 10 } },
      lines: [{ syllables: [{ text: 'LEAD', startMs: 0 }] }],
    },
    {
      id: 't2',
      type: 'text', name: 'Backing',
      style: { ...track(p).style },
      rendererSettings: { scroller: { previewSec: 10 } },
      lines: [{ syllables: [{ text: 'BACK', startMs: 0 }] }],
    },
  ];
  p.durationMs = 2000;
  const rec = makeFakeCtx(40);
  renderFrame(rec.ctx, 0, p);
  const texts = new Set(rec.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  assert(texts.has('LEAD'), 'track 1 (Lead) text renders');
  assert(texts.has('BACK'), 'track 2 (Backing) text renders');
});

// ---------------------------------------------------------------------------
// 'classic' renderer — fixed-slot karaoke (stationary text, cyclical slots,
// fade in/out). Mirrors the scroller tests but for the fixed-slot mode.
// ---------------------------------------------------------------------------

test('classic: draws the active line', () => {
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.layout = 'classic';
  track(p).rendererSettings = { classic: { lineSlots: 4, fadeMs: 1500 } };
  track(p).lines = [{ syllables: [{ text: 'SONG', startMs: 0 }] }];
  p.durationMs = 2000;
  const rec = makeFakeCtx(40);
  renderFrame(rec.ctx, 0, p);
  const texts = new Set(rec.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  assert(texts.has('SONG'), 'classic renders the active line');
});

test('classic: cyclical slots — line 5 shares slot Y with line 1 (mod N=4)', () => {
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.layout = 'classic';
  track(p).rendererSettings = { classic: { lineSlots: 4, fadeMs: 0 } };
  // 5 lines, 1s apart, each one syllable. fadeMs=0 → a line is visible only
  // during its own window so no overlap clouds the Y comparison.
  track(p).lines = Array.from({ length: 5 }, (_, i) => ({
    syllables: [{ text: `L${i}`, startMs: i * 1000 }],
  }));
  p.durationMs = 6000;
  const yAt = (label: string, t: number): number | null => {
    const rec = makeFakeCtx(40);
    renderFrame(rec.ctx, t, p);
    const hit = rec.calls.find((c) => c[0] === 'fillText' && c[1] === label);
    return hit ? hit[3] : null;
  };
  // L0 at its start (t=0) and L4 at its start (t=4000) use slot 0 and 4%4=0.
  const y0 = yAt('L0', 0);
  const y4 = yAt('L4', 4000);
  assert(y0 !== null, 'classic renders L0 at its window');
  assert(y4 !== null, 'classic renders L4 at its window');
  assert(Math.abs((y0 as number) - (y4 as number)) < 2, `cyclical: L4 shares slot 0 with L0 (y0=${y0}, y4=${y4})`);
});

test('classic: a line is NOT drawn before start - fadeMs', () => {
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.layout = 'classic';
  track(p).rendererSettings = { classic: { lineSlots: 4, fadeMs: 1000 } };
  track(p).lines = [{ syllables: [{ text: 'EARLY', startMs: 2000 }] }];
  p.durationMs = 4000;
  const rec = makeFakeCtx(40);
  // start - fadeMs = 1000; at t=500 the line should be invisible (alpha 0).
  renderFrame(rec.ctx, 500, p);
  const texts = new Set(rec.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  assert(!texts.has('EARLY'), 'classic hides a line before its fade-in window');
  // And at its start it IS visible.
  const rec2 = makeFakeCtx(40);
  renderFrame(rec2.ctx, 2000, p);
  const texts2 = new Set(rec2.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  assert(texts2.has('EARLY'), 'classic shows a line once its window begins');
});

test('classic: active syllable drawn twice (base + clipped highlight)', () => {
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.layout = 'classic';
  track(p).rendererSettings = { classic: { lineSlots: 4, fadeMs: 1500 } };
  track(p).lines = [
    {
      syllables: [
        { text: 'При', startMs: 0, sep: '' },
        { text: 'вет', startMs: 1000, sep: '/' },
      ],
    },
  ];
  p.durationMs = 2000;
  const rec = makeFakeCtx(40);
  renderFrame(rec.ctx, 500, p); // halfway through syllable 1
  const fills = rec.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  const priCount = fills.filter((t) => t === 'При').length;
  assert(priCount === 2, `classic fills active syllable twice (base+highlight), got ${priCount}`);
  assert(count(rec.calls, 'clip') >= 1, 'classic uses clip for the highlight wipe');
});

test('line-last syllable has a FIXED 500ms fill (not stretching to the next line)', () => {
  const lines = [
    { syllables: [{ text: 'a', startMs: 0 }, { text: 'b', startMs: 1000 }] }, // last: 'b'
    { syllables: [{ text: 'c', startMs: 3000 }] }, // next line starts at 3000
  ];
  const t = buildTimings(lines as any, 10000);
  const lastOfLine0 = t.find((x) => x.syl.text === 'b')!;
  const midOfLine0 = t.find((x) => x.syl.text === 'a')!;
  assert(lastOfLine0 && lastOfLine0.endMs === 1500, `line-last syllable ends at start+500ms (got ${lastOfLine0?.endMs})`);
  assert(midOfLine0 && midOfLine0.endMs === 1000, `mid-line syllable ends at next start (got ${midOfLine0?.endMs})`);
  // Fill completes within the 500ms window: at start+500 progress = 1, and well
  // before the next line begins (so it isn't slowly filling across the gap).
  assert(progress(lastOfLine0, 1499) < 1, 'line-last syllable still filling just before 500ms');
  assert(progress(lastOfLine0, 1500) === 1, 'line-last syllable fully filled at 500ms');
  assert(progress(lastOfLine0, 2999) === 1, 'line-last syllable stays filled through the gap to next line');
});

test("the SONG's very last syllable fills to the song duration (unchanged)", () => {
  const lines = [{ syllables: [{ text: 'end', startMs: 1000 }] }];
  const t = buildTimings(lines as any, 5000);
  assert(t[0].endMs === 5000, `song-last syllable ends at durationMs (got ${t[0].endMs})`);
  assert(progress(t[0], 5000) === 1, 'song-last syllable fully filled at the end');
});

test('outline color follows fill state (active vs inactive stroke colors)', () => {
  const p = JSON.parse(JSON.stringify(project));
  track(p).style.strokeColorActive = '#112233';
  track(p).style.strokeColorInactive = '#445566';
  // One line: "A" filled completely (past its end), "B" not yet started.
  track(p).lines = [
    { syllables: [{ text: 'A', startMs: 0, sep: '' }, { text: 'B', startMs: 5000, sep: ' ' }] },
  ];
  p.durationMs = 6000;
  const rec = makeFakeCtx(40);
  renderFrame(rec.ctx, 2500, p); // A is fully filled, B is unfilled
  const strokes = rec.calls.filter((c) => c[0] === 'strokeText');
  const a = strokes.find((c) => c[1] === 'A');
  const b = strokes.find((c) => c[1] === 'B');
  assert(a && a[4] === '#112233', `filled syllable outline = strokeColorActive (got ${a?.[4]})`);
  assert(b && b[4] === '#445566', `unfilled syllable outline = strokeColorInactive (got ${b?.[4]})`);
});
