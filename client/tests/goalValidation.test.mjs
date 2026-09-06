// Goal Target Amount frontend contract — direct unit tests over the
// DOM-free validator plus source assertions for the input control itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TARGET_AMOUNT_ERROR, isValidTargetAmount } from '../src/goalValidation.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('validator accepts whole numbers 1–999 only', () => {
  for (const value of ['1', '30', '120', '999', 1, 30, 999]) {
    assert.equal(isValidTargetAmount(value), true, `${JSON.stringify(value)} valid`);
  }
});

test('validator rejects magnitudes, signs, decimals, and non-numbers', () => {
  for (const value of ['0', '1000', '931939193', '-5', '-100', '1.5', '2.7', 'abc', '12abc', '', '  ', '000', null, undefined]) {
    assert.equal(isValidTargetAmount(value), false, `${JSON.stringify(value)} invalid`);
  }
});

test('rejection explains the contract without clamping', () => {
  assert.equal(TARGET_AMOUNT_ERROR, 'Enter a whole number from 1 to 999.');
  assert.equal(isValidTargetAmount('1000'), false, 'never converts 1000 to 999');
  assert.equal(isValidTargetAmount('0'), false, 'never converts 0 to 1');
});

test('target amount control physically limits entry to three digits', () => {
  const source = readSource('src/pages/v2Pages.js');
  assert.ok(source.includes("type: 'text'"), 'text control (maxlength is unreliable on number inputs)');
  assert.ok(source.includes('maxLength: 3'), 'maxlength blocks a fourth digit while typing');
  assert.ok(source.includes("inputmode: 'numeric'"), 'mobile numeric keyboard preserved');
  assert.ok(source.includes('isValidTargetAmount(raw)'), 'submit guard rejects the rest');
});
