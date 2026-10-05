// Kanji writing MVP: stroke-start parsing and order assignment are pure
// logic — tested without DOM or canvas.
import test from 'node:test';
import assert from 'node:assert/strict';

import { assignDrawnStrokes, parseStrokeStart, toModelSpace } from '../src/kanjiWritingLogic.js';

test('parseStrokeStart reads the opening moveto', () => {
  assert.deepEqual(parseStrokeStart('M 10 20 C 30 40 50 60 70 80'), { x: 10, y: 20 });
  assert.deepEqual(parseStrokeStart('M10,20L30,40'), { x: 10, y: 20 });
  assert.deepEqual(parseStrokeStart('m 12.5 -3 L 40 50'), { x: 12.5, y: -3 });
  assert.deepEqual(parseStrokeStart('  M  0 109  '), { x: 0, y: 109 });
  assert.equal(parseStrokeStart(''), null);
  assert.equal(parseStrokeStart(null), null);
  assert.equal(parseStrokeStart('Z'), null);
});

test('assignDrawnStrokes accepts the model order within tolerance', () => {
  const model = [{ x: 10, y: 10 }, { x: 50, y: 50 }, { x: 90, y: 90 }];
  const drawn = [{ x: 12, y: 9 }, { x: 48, y: 52 }, { x: 91, y: 88 }];
  const verdict = assignDrawnStrokes(drawn, model, 25);
  assert.deepEqual(verdict.perStroke, ['right', 'right', 'right']);
  assert.equal(verdict.allRight, true);
});

test('assignDrawnStrokes flags swapped strokes and count mismatches', () => {
  const model = [{ x: 10, y: 10 }, { x: 50, y: 50 }];
  const swapped = assignDrawnStrokes([{ x: 50, y: 50 }, { x: 10, y: 10 }], model, 25);
  assert.deepEqual(swapped.perStroke, ['wrong', 'wrong']);
  assert.equal(swapped.allRight, false);
  const extra = assignDrawnStrokes([{ x: 10, y: 10 }, { x: 50, y: 50 }, { x: 70, y: 70 }], model, 25);
  assert.equal(extra.allRight, false);
  const partial = assignDrawnStrokes([{ x: 10, y: 10 }], model, 25);
  assert.deepEqual(partial.perStroke, ['right']);
  assert.equal(partial.allRight, false);
  const far = assignDrawnStrokes([{ x: 100, y: 100 }, { x: 50, y: 50 }], model, 25);
  assert.deepEqual(far.perStroke, ['wrong', 'right']);
});

test('toModelSpace scales canvas points to the 109 model space', () => {
  const scaled = toModelSpace({ x: 200, y: 100 }, 200);
  assert.ok(Math.abs(scaled.x - 109) < 1e-9 && Math.abs(scaled.y - 54.5) < 1e-9);
});
