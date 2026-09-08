import test from 'node:test';
import assert from 'node:assert/strict';

import { counterValue } from '../src/landing/interactions.js';

test('progress counters interpolate deterministically and finish exactly', () => {
  assert.equal(counterValue(312, 0, 1600), 0);
  assert.equal(counterValue(312, 800, 1600), 156);
  assert.equal(counterValue(312, 1600, 1600), 312);
  assert.equal(counterValue(312, 2400, 1600), 312);
});
