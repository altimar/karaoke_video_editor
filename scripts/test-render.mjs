/**
 * Standalone render-logic test (no DOM, no real canvas).
 *
 * Transpiles src/lib/render.ts + src/types.ts with esbuild and runs renderFrame
 * against a recording fake 2D context that captures every drawing call. This
 * verifies the renderer's logic (background draw order, syllable fill via clip,
 * stroke pass, active-syllable scale) without needing a browser or a canvas
 * implementation.
 *
 * Run: node scripts/test-render.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Bundle render.ts (and its types.ts import) to a single ESM file in a temp dir.
const outDir = join(tmpdir(), 'kve-render-test');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'render-bundle.mjs');

await build({
  entryPoints: [join(root, 'src/lib/render.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: outFile,
  logLevel: 'silent',
});

const { renderFrame } = await import(pathToFileURL(outFile).href);

/** Build a recording fake context implementing exactly the methods render uses. */
function makeFakeCtx(measure = 40) {
  const calls = [];
  const state = {
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
  const ctx = {
    ...state,
    set fillStyle(v) { state.fillStyle = v; },
    get fillStyle() { return state.fillStyle; },
    set strokeStyle(v) { state.strokeStyle = v; },
    get strokeStyle() { return state.strokeStyle; },
    set font(v) { state.font = v; },
    get font() { return state.font; },
    set textAlign(v) { state.textAlign = v; },
    get textAlign() { return state.textAlign; },
    set textBaseline(v) { state.textBaseline = v; },
    get textBaseline() { return state.textBaseline; },
    set lineWidth(v) { state.lineWidth = v; },
    get lineWidth() { return state.lineWidth; },
    set lineJoin(v) { state.lineJoin = v; },
    get lineJoin() { return state.lineJoin; },
    set globalAlpha(v) { state.globalAlpha = v; },
    get globalAlpha() { return state.globalAlpha; },
    set shadowBlur(v) { state.shadowBlur = v; },
    get shadowBlur() { return state.shadowBlur; },
    set shadowColor(v) { state.shadowColor = v; },
    get shadowColor() { return state.shadowColor; },
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    drawImage: (...a) => calls.push(['drawImage', ...a]),
    createLinearGradient: (...a) => {
      calls.push(['createLinearGradient', ...a]);
      const g = { stops: [], addColorStop: (off, col) => g.stops.push([off, col]) };
      return g;
    },
    measureText: (text) => {
      calls.push(['measureText', text]);
      return { width: measure * (text.length || 1) };
    },
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (...a) => calls.push(['translate', ...a]),
    scale: (...a) => calls.push(['scale', ...a]),
    beginPath: () => calls.push(['beginPath']),
    rect: (...a) => calls.push(['rect', ...a]),
    clip: () => calls.push(['clip']),
    fillText: (text, x, y) => calls.push(['fillText', text, Math.round(x), Math.round(y), state.fillStyle]),
    strokeText: (text, x, y) => calls.push(['strokeText', text, Math.round(x), Math.round(y)]),
  };
  return { ctx, calls };
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('  ✗ FAIL:', msg);
  } else {
    console.log('  ✓', msg);
  }
}

function count(calls, name) {
  return calls.filter((c) => c[0] === name).length;
}

// --- Build a project with known timings ---
const project = {
  audioFileName: 'x.wav',
  durationMs: 4000,
  fps: 30,
  width: 1920,
  height: 1080,
  style: {
    fontFamily: 'Arial',
    fontSize: 64,
    fontWeight: 700,
    lineHeight: 1.4,
    textAlign: 'center',
    colorBase: 'rgba(255,255,255,0.35)',
    colorHighlight: '#ffe14d',
    strokeWidth: 3,
    strokeColor: '#000',
    glowBlur: 24,
    glowColor: '#ffb400',
    bgType: 'color',
    bgColor: '#0e0f1a',
    bgColors: ['#1a1033', '#0e0f1a'],
    bgImageDataUrl: null,
    layout: 'scroller',
  },
  rendererSettings: {
    scroller: { visibleLines: 8 },
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
};

console.log('Renderer logic tests\n');

// Test 1: background + at least one fillText at start.
{
  const { ctx, calls } = makeFakeCtx(40);
  renderFrame(ctx, 0, project);
  assert(count(calls, 'clearRect') === 1, 'clears the frame once');
  assert(count(calls, 'fillRect') >= 1, 'fills background');
  assert(count(calls, 'fillText') >= 1, 'draws text (fillText)');
  assert(count(calls, 'strokeText') >= 1, 'draws stroke outline');
}

// Test 2: mid-fill of the first syllable should produce TWO fillText for it
// (base pass + clipped highlight pass).
{
  const { ctx, calls } = makeFakeCtx(40);
  renderFrame(ctx, 500, project); // halfway through syllable 1 (0..1000)
  const fills = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  const priCount = fills.filter((t) => t === 'При').length;
  assert(priCount === 2, `first syllable filled twice (base + highlight), got ${priCount}`);
  assert(count(calls, 'clip') >= 1, 'uses clip for the highlight wipe');
}

// Test 3: fully-filled first syllable (past its end) shows highlight color once.
{
  const { ctx, calls } = makeFakeCtx(40);
  renderFrame(ctx, 1500, project); // syllable 1 fully done, syllable 2 mid
  const priFills = calls.filter((c) => c[0] === 'fillText' && c[1] === 'При').map((c) => c[4]);
  assert(
    priFills.includes('#ffe14d'),
    'completed syllable shows highlight color (#ffe14d)',
  );
}

// Test 3b: spacing — slash-joined syllables have NO gap (one word), space-separated
// syllables have a real space between them.
{
  const { ctx, calls } = makeFakeCtx(40);
  // Line: "При/вет" (slash, one word) + "мир" (space, separate word).
  // syllable.text includes leading space for space-separated ones per the parser,
  // but layout uses `sep` to insert the space. We test the rendered X positions.
  const p = JSON.parse(JSON.stringify(project));
  p.lines = [
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
}

// Test 5: gradient background calls createLinearGradient.
{
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  p.style.bgType = 'gradient';
  renderFrame(ctx, 0, p);
  assert(count(calls, 'createLinearGradient') === 1, 'gradient background builds a gradient');
}

// Test 6: zero stroke disables strokeText.
{
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  p.style.strokeWidth = 0;
  renderFrame(ctx, 0, p);
  assert(count(calls, 'strokeText') === 0, 'strokeWidth=0 disables outline');
}

// Test 7: untimed syllables do NOT render. IMPORTANT: this is intentional —
// untimed syllables are invisible in preview/export until they get a timing.
{
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  p.lines[0].syllables[1].startMs = null; // "вет" untimed
  renderFrame(ctx, 500, p);
  const texts = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert(!texts.includes('вет'), 'untimed syllable is NOT rendered');
}

// Test 8: all-untimed renders only background.
{
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  p.lines.forEach((l) => l.syllables.forEach((s) => (s.startMs = null)));
  renderFrame(ctx, 1500, p);
  assert(count(calls, 'fillText') === 0, 'all-untimed renders no text');
  assert(count(calls, 'strokeText') === 0, 'all-untimed renders no strokes');
}

// Test 9: timed syllables in a partially-timed line render; untimed ones don't.
{
  const { ctx, calls } = makeFakeCtx(40);
  const p = JSON.parse(JSON.stringify(project));
  p.lines[0].syllables[1].startMs = null;
  p.lines[0].syllables[2].startMs = null;
  renderFrame(ctx, 100, p);
  const texts = new Set(calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  assert(texts.has('При'), 'timed syllable renders');
  assert(!texts.has('вет') && !texts.has(' мир'), 'untimed syllables NOT rendered');
}

// Test 10: 'scroller' layout draws the active line + nearby window only.
{
  const { ctx, calls } = makeFakeCtx(40);
  // 6 lines, each with one timed syllable 1s apart; line 0 active at t=0.
  const p = JSON.parse(JSON.stringify(project));
  p.style.layout = 'scroller';
  p.rendererSettings.scroller.visibleLines = 4;
  p.lines = Array.from({ length: 6 }, (_, i) => ({
    syllables: [{ text: `L${i}`, startMs: i * 1000 }],
  }));
  p.durationMs = 7000;
  renderFrame(ctx, 100, p); // active line 0
  const texts = new Set(calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  assert(texts.has('L0'), 'scroller shows active line L0');
  // Lines far below the window (L5) should not be rendered when active is L0
  // and only 4 lines fit — the window spans L0..L3 at most.
  assert(!texts.has('L5'), 'scroller hides far-below line L5');
}

// Test 11: 'scroller' — constant speed + each line at CENTER at its anchor time.
{
  const p = JSON.parse(JSON.stringify(project));
  p.style.layout = 'scroller';
  p.rendererSettings.scroller.visibleLines = 8;
  // Evenly-spaced lines (0, 1000, 2000, ...) so speed is well-defined.
  p.lines = Array.from({ length: 10 }, (_, i) => ({ syllables: [{ text: `W${i}`, startMs: i * 1000, sep: '' }] }));
  p.durationMs = 12000;

  const yOf = (label, t) => {
    const rec = makeFakeCtx(40);
    renderFrame(rec.ctx, t, p);
    const hit = rec.calls.find((c) => c[0] === 'fillText' && c[1] === label);
    return hit ? hit[3] : null;
  };
  const centerY = 1080 / 2;

  // 1. Each line at center at its startMs.
  assert(Math.abs(yOf('W0', 0) - centerY) < 2, `W0 at center at t=0`);
  assert(Math.abs(yOf('W3', 3000) - centerY) < 2, `W3 at center at t=3000`);
  assert(Math.abs(yOf('W5', 5000) - centerY) < 2, `W5 at center at t=5000`);

  // 2. Constant speed: sample W0 over time, speed should be the same.
  const samples = [0, 200, 400, 600, 800].map((t) => ({ t, y: yOf('W0', t) }));
  assert(samples.every((s) => s.y !== null), 'W0 rendered across samples');
  const speeds = [];
  for (let i = 1; i < samples.length; i++) speeds.push(samples[i - 1].y - samples[i].y);
  const allClose = speeds.every((s) => Math.abs(s - speeds[0]) < 1.5);
  assert(allClose, `constant speed (${speeds.map((s) => s.toFixed(1)).join(', ')} px/200ms)`);
  assert(speeds[0] > 0, 'text moves upward (speed > 0)');
}

// Test 12: 'scroller' shows ~N lines on screen — when lines are evenly timed
// so the scroll pace matches the spacing.
{
  const p = JSON.parse(JSON.stringify(project));
  p.style.layout = 'scroller';
  p.rendererSettings.scroller.visibleLines = 4;
  // 10 lines evenly spaced so the global scroll speed matches the N=4 spacing.
  p.lines = Array.from({ length: 10 }, (_, i) => ({ syllables: [{ text: `X${i}`, startMs: i * 2000 }] }));
  p.durationMs = 22000;
  const rec = makeFakeCtx(40);
  renderFrame(rec.ctx, 5000, p); // mid-scroll
  const labels = new Set(rec.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]));
  // With visibleLines=4 and even timing, ~3-5 lines should be on screen.
  assert(labels.size >= 3 && labels.size <= 6, `~4 lines visible for visibleLines=4 (got ${labels.size})`);
}

// Test 13: 'scroller' fill starts at the CENTER — a line entering from the
// bottom is unfilled (progress 0) until it reaches the vertical middle.
{
  const p = JSON.parse(JSON.stringify(project));
  p.style.layout = 'scroller';
  p.rendererSettings.scroller.visibleLines = 4;
  p.lines = [
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
}

// Test 14: 'scroller' renders lines in correct top-to-bottom order — the NEXT
// line is BELOW the previous one (not above, which was the regression bug).
{
  const p = JSON.parse(JSON.stringify(project));
  p.style.layout = 'scroller';
  p.rendererSettings.scroller.visibleLines = 8;
  p.lines = [
    { syllables: [{ text: 'FIRST', startMs: 0 }] },
    { syllables: [{ text: 'SECOND', startMs: 1000 }] },
    { syllables: [{ text: 'THIRD', startMs: 2000 }] },
  ];
  p.durationMs = 4000;
  const rec = makeFakeCtx(40);
  renderFrame(rec.ctx, 0, p);
  const yOf = (label) => {
    const hit = rec.calls.find((c) => c[0] === 'fillText' && c[1] === label);
    return hit ? hit[3] : null;
  };
  const yFirst = yOf('FIRST');
  const ySecond = yOf('SECOND');
  const yThird = yOf('THIRD');
  assert(yFirst !== null && ySecond !== null && yThird !== null, 'all three lines rendered at t=0');
  // SECOND must be BELOW FIRST (larger Y), and THIRD below SECOND.
  assert(ySecond > yFirst, `SECOND below FIRST (SECOND=${ySecond}, FIRST=${yFirst})`);
  assert(yThird > ySecond, `THIRD below SECOND (THIRD=${yThird}, SECOND=${ySecond})`);
}

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
if (failures > 0) process.exit(1);
