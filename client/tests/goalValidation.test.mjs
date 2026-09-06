// Goal Target Amount frontend contract — direct unit tests over the
// DOM-free validator plus source assertions for the input control itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TARGET_AMOUNT_ERROR, attachDigitGuard, isValidTargetAmount } from '../src/goalValidation.js';

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

// Minimal input double: only what attachDigitGuard touches.
function makeGuardedInput(value = '') {
  const listeners = new Map();
  const input = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    dataset: {},
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    fire(type, event = {}) {
      let prevented = false;
      for (const fn of listeners.get(type) || []) fn({ ...event, preventDefault() { prevented = true; } });
      return prevented;
    },
    handlerCount(type) { return (listeners.get(type) || []).length; }
  };
  return input;
}

test('digit guard prevents a fourth digit while keeping the valid value', () => {
  const input = makeGuardedInput('999');
  assert.equal(attachDigitGuard(input), true);
  const prevented = input.fire('beforeinput', { inputType: 'insertText', data: '4' });
  assert.equal(prevented, true, 'fourth digit blocked');
  assert.equal(input.value, '999', 'previous valid value unchanged');
});

test('digit guard blocks every non-digit character class', () => {
  for (const data of ['a', 'e', 'E', '+', '-', '.', ',', ' ', 'abc', 'あ']) {
    const input = makeGuardedInput('12');
    attachDigitGuard(input);
    const prevented = input.fire('beforeinput', { inputType: 'insertText', data });
    assert.equal(prevented, true, `${JSON.stringify(data)} blocked`);
    assert.equal(input.value, '12', 'field unchanged');
  }
});

test('digit guard rejects invalid pastes wholesale instead of reinterpreting', () => {
  for (const [initial, data] of [['', '1234'], ['', '12abc'], ['', '-5'], ['', '1.5'], ['99', '99']]) {
    const input = makeGuardedInput(initial);
    attachDigitGuard(input);
    const prevented = input.fire('beforeinput', { inputType: 'insertFromPaste', data });
    assert.equal(prevented, true, `paste ${JSON.stringify(data)} rejected`);
    assert.equal(input.value, initial, 'no reinterpreted residue left behind');
  }
});

test('digit guard allows valid typing, pasting, and deletions', () => {
  const typing = makeGuardedInput('12');
  attachDigitGuard(typing);
  assert.equal(typing.fire('beforeinput', { inputType: 'insertText', data: '0' }), false, 'third digit allowed');
  const pasting = makeGuardedInput('');
  attachDigitGuard(pasting);
  assert.equal(pasting.fire('beforeinput', { inputType: 'insertFromPaste', data: '123' }), false, 'valid paste allowed');
  const deleting = makeGuardedInput('120');
  attachDigitGuard(deleting);
  assert.equal(deleting.fire('beforeinput', { inputType: 'deleteContentBackward', data: null }), false, 'deletion allowed');
});

test('digit guard attaches once and cleans bypass sources', () => {
  const input = makeGuardedInput('');
  assert.equal(attachDigitGuard(input), true);
  assert.equal(attachDigitGuard(input), true, 'idempotent');
  assert.equal(input.handlerCount('beforeinput'), 1, 'single handler');
  input.value = 'a1b2c3d4';
  input.fire('input', {});
  assert.equal(input.value, '123', 'input-event net strips non-digits and truncates');
});
