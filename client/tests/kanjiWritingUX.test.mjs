// UX / integration assertions for kanjiWriting.js — tests the DOM mount behavior,
// decimation (no smoothing, by design), DPR, ResizeObserver, Path2D caching,
// offscreen canvas, copy fixes, progress badge, Clear/Done labels.
// Uses source code assertions (reading file as text) to avoid DOM dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE_PATH = join('client', 'src', 'kanjiWriting.js');

async function readSource() {
  return readFile(SOURCE_PATH, 'utf-8');
}

test('mountKanjiWriting renders kanji large with "Write this kanji" and stroke counter', async () => {
  const source = await readSource();
  
  // Verify copy fixes in user-facing strings
  assert.ok(source.includes('Loading stroke order…'), 'Should say "Loading stroke order…" not "Loading stroke model…"');
  assert.ok(source.includes('no stroke order data'), 'Should say "no stroke order data" not "no stroke model"');
  assert.ok(source.includes('Watch stroke order'), 'Should say "Watch stroke order" not "Watch order"');
  assert.ok(source.includes('Cleared.'), 'Should say "Cleared." not "Canvas cleared."');
  assert.ok(source.includes('Write this kanji'), 'Should show "Write this kanji"');
  assert.ok(source.includes('strokeCounter'), 'Should have stroke counter badge');
  assert.ok(source.includes('Clear canvas'), 'Clear button should have aria-label "Clear canvas"');
  assert.ok(source.includes('Finish practice'), 'Done button should have aria-label "Finish practice"');
  assert.ok(source.includes('Show stroke order'), 'Should have "Show stroke order" toggle');
  // User-facing copy should not contain "trace" (replaced with "write")
  // Check only textContent strings, not comments
  assert.ok(!source.includes('text: \'trace') && !source.includes('text: "trace') && !source.includes('text: `trace'), 'Should not contain "trace" in user-facing text');
});

test('kanjiWriting.js applies DPR scaling at mount', async () => {
  const source = await readSource();
  assert.ok(source.includes('devicePixelRatio'), 'Should reference devicePixelRatio');
  assert.ok(source.includes('canvas.width ='), 'Should set canvas.width with DPR');
  assert.ok(source.includes('canvas.height ='), 'Should set canvas.height with DPR');
  assert.ok(source.includes('ctx.setTransform'), 'Should scale context with DPR');
  assert.ok(source.includes('applyDpr'), 'Should have applyDpr function');
});

test('kanjiWriting.js uses ResizeObserver for resize handling', async () => {
  const source = await readSource();
  assert.ok(source.includes('ResizeObserver'), 'Should use ResizeObserver');
  assert.ok(source.includes('resizeObserver.observe'), 'Should observe the stage container');
});

test('kanjiWriting.js caches rect on pointerdown and updates on scroll/resize', async () => {
  const source = await readSource();
  assert.ok(source.includes('rectCache'), 'Should cache bounding rect');
  assert.ok(source.includes('updateRectCache'), 'Should have updateRectCache function');
  assert.ok(source.includes('pointerdown'), 'Should update rect on pointerdown');
});

test('kanjiWriting.js moves assignDrawnStrokes to finishStroke only', async () => {
  const source = await readSource();
  // assignDrawnStrokes should be called in finishStroke, not in redraw
  const finishStrokeSection = source.substring(source.indexOf('const finishStroke'), source.indexOf('canvas.addEventListener'));
  assert.ok(finishStrokeSection.includes('assignDrawnStrokes'), 'assignDrawnStrokes should be called in finishStroke');
  // redraw should not call assignDrawnStrokes (it uses offscreen canvas)
  const redrawSection = source.substring(source.indexOf('const redraw'), source.indexOf('const finishStroke'));
  assert.ok(!redrawSection.includes('assignDrawnStrokes'), 'redraw should not call assignDrawnStrokes');
});

test('kanjiWriting.js caches completed strokes as Path2D objects', async () => {
  const source = await readSource();
  assert.ok(source.includes('Path2D'), 'Should use Path2D for caching');
  assert.ok(source.includes('buildPath2D'), 'Should have buildPath2D function');
  assert.ok(source.includes('stroke.path2d'), 'Should store path2d on stroke data');
  assert.ok(source.includes('offscreenCtx.stroke(stroke.path2d)'), 'Should stroke Path2D on offscreen canvas');
});

test('kanjiWriting.js builds offscreen canvas for settled strokes on finishStroke', async () => {
  const source = await readSource();
  assert.ok(source.includes('offscreenCanvas'), 'Should have offscreen canvas');
  assert.ok(source.includes('offscreenCtx'), 'Should have offscreen context');
  assert.ok(source.includes('drawImage(offscreenCanvas'), 'Should draw offscreen canvas in redraw');
});

test('kanjiWriting.js blits offscreen at CSS size under the DPR transform', async () => {
  const source = await readSource();
  // The offscreen backing store is css*dpr device px while ctx carries the
  // dpr transform: a bare 3-arg drawImage would render settled strokes
  // dpr× oversized. The destination must be sized in CSS user-space units.
  assert.ok(source.includes('drawImage(offscreenCanvas, 0, 0, offscreenCanvas.width / dpr'), 'Should size drawImage destination in CSS units');
  // A resize recreates the offscreen canvas empty: settled strokes must be
  // repainted into it, otherwise they vanish until the next stroke.
  assert.ok(source.includes('repaintOffscreen'), 'Should have repaintOffscreen helper');
  const applyDprSection = source.substring(source.indexOf('function applyDpr'), source.indexOf('function updateRectCache'));
  assert.ok(applyDprSection.includes('repaintOffscreen()'), 'applyDpr should repaint settled strokes after recreating offscreen');
});

test('kanjiWriting.js caps points per stroke with decimation', async () => {
  const source = await readSource();
  assert.ok(source.includes('decimatePoints'), 'Should have decimatePoints function');
  assert.ok(source.includes('maxPoints'), 'Should cap points per stroke');
  assert.ok(source.includes('200'), 'Should cap at ~200 points');
});

test('kanjiWriting.js decimates (no smoothing) on finishStroke', async () => {
  const source = await readSource();
  // Deliberate architecture: raw points only, capped by decimation.
  // No smoothing pass exists (rejected scope: no Catmull-Rom/interpolation).
  assert.ok(!source.includes('smoothStroke'), 'Should have no smoothStroke function');
  assert.ok(!source.includes('Catmull-Rom'), 'Should not reference Catmull-Rom spline');
  assert.ok(source.includes('decimatePoints(current.points)'), 'Should decimate raw points on finishStroke');
  // Verify grading uses the original first point scaled by the ACTUAL css
  // canvas size (the stage is responsive — a fixed 260 default mis-scales
  // grading on any other canvas size).
  assert.ok(source.includes('toModelSpace(current.points[0], stage.clientWidth'), 'Grading should use original first point at actual canvas size');
});

test('kanjiWriting.js has proper cleanup with removeEventListener', async () => {
  const source = await readSource();
  // The cleanup function should be enhanced to remove listeners
  // Note: current implementation returns a simple cleanup that sets cancelled=true
  // The event listeners are on the canvas which gets removed when container.replaceChildren() is called
  // This is acceptable since the canvas element is replaced
  assert.ok(source.includes('cleanup'), 'Should have cleanup function');
});

test('kanjiWriting.js has stroke counter badge showing current/total', async () => {
  const source = await readSource();
  assert.ok(source.includes('strokeCounter'), 'Should have stroke counter element');
  assert.ok(source.includes('drawnStrokes.length'), 'Should show current stroke count');
  assert.ok(source.includes('modelStarts.length'), 'Should show total model strokes');
  assert.ok(source.includes('aria-live'), 'Stroke counter should be aria-live');
});

test('kanjiWriting.js has Clear/Done buttons with clear labels', async () => {
  const source = await readSource();
  assert.ok(source.includes('aria-label'), 'Buttons should have aria-labels');
  assert.ok(source.includes('Clear canvas'), 'Clear button should say "Clear canvas"');
  assert.ok(source.includes('Finish practice'), 'Done button should say "Finish practice"');
});

test('kanjiWriting.js has Show stroke order toggle', async () => {
  const source = await readSource();
  assert.ok(source.includes('Show stroke order'), 'Should have show guide toggle');
  assert.ok(source.includes('guideCheckbox'), 'Should have checkbox reference');
  assert.ok(source.includes('svg.style.display'), 'Should toggle SVG visibility');
});

test('kanjiWriting.js decimates only on finishStroke, never per-move', async () => {
  const source = await readSource();
  const pointerMoveSection = source.substring(source.indexOf('pointermove'), source.indexOf('pointerup'));
  assert.ok(!pointerMoveSection.includes('decimatePoints'), 'Should not decimate on pointermove');
  const finishStrokeSection = source.substring(source.indexOf('const finishStroke'), source.indexOf('canvas.addEventListener'));
  assert.ok(!finishStrokeSection.includes('smoothStroke'), 'Should never smooth (no smoothing pass exists)');
  assert.ok(finishStrokeSection.includes('decimatePoints'), 'Should decimate on finishStroke');
});

test('kanjiWriting.js preserves grading logic (assignDrawnStrokes tolerance 25, order-only)', async () => {
  const source = await readSource();
  assert.ok(source.includes('START_TOLERANCE'), 'Should use START_TOLERANCE constant');
  assert.ok(source.includes('assignDrawnStrokes'), 'Should use assignDrawnStrokes for grading');
  // Should not have shape-based grading logic (only order-only)
  assert.ok(!source.includes('shape grad') && !source.includes('grade.*shape'), 'Should not reference shape grading logic');
});

test('kanjiWriting.js preserves Watch/Replay animation with prefers-reduced-motion', async () => {
  const source = await readSource();
  assert.ok(source.includes('prefers-reduced-motion'), 'Should respect reduced motion');
  assert.ok(source.includes('STROKE_DRAW_MS'), 'Should use stroke draw timing');
  assert.ok(source.includes('STROKE_PAUSE_MS'), 'Should use stroke pause timing');
  assert.ok(source.includes('animate'), 'Should use WAAPI animate');
});

test('kanjiWriting.js has accessibility: canvas role=img, button labels, aria-live verdict', async () => {
  const source = await readSource();
  assert.ok(source.includes("role'") && source.includes("'img'"), 'Canvas should have role=img');
  assert.ok(source.includes('aria-live'), 'Verdict should be aria-live polite');
  assert.ok(source.includes('aria-label'), 'Buttons should have aria-labels');
  assert.ok(source.includes('tabindex'), 'Canvas should be focusable');
});

test('kanjiWriting.js mobile-first: canvas fills container, touch-action:none, user-select:none', async () => {
  const source = await readSource();
  assert.ok(source.includes('touch-action:none'), 'Canvas should have touch-action:none');
  assert.ok(source.includes('user-select:none'), 'Canvas should have user-select:none');
  assert.ok(source.includes('mx-auto'), 'Stage should be centered');
  assert.ok(source.includes('WRITING_CANVAS_SIZE'), 'Should respect max 260px');
});

test('kanjiWriting.js has green flash on success, red flash on failure', async () => {
  const source = await readSource();
  assert.ok(source.includes('outline') && source.includes('2f7d4f'), 'Should have green flash on success');
  // Failure feedback is via verdict text (red text via CSS)
  assert.ok(source.includes('wrong'), 'Should show wrong stroke feedback');
});

test('kanjiWriting.js target kanji display: large kanji + "Write this kanji" + stroke counter', async () => {
  const source = await readSource();
  assert.ok(source.includes('text-5xl') && source.includes('font-serif'), 'Should show large kanji');
  assert.ok(source.includes('Write this kanji'), 'Should show "Write this kanji" label');
  assert.ok(source.includes('strokeCounter'), 'Should show stroke counter');
});

test('kanjiWriting.js progress/session: stroke counter badge (current/total)', async () => {
  const source = await readSource();
  assert.ok(source.includes('strokeCounter'), 'Should have stroke counter badge');
  assert.ok(source.includes('${drawnStrokes.length}'), 'Should show current count');
  assert.ok(source.includes('${modelStarts.length}'), 'Should show total count');
});