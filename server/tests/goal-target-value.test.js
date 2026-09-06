// Goals Target Amount contract: whole numbers 1–999 only. The server stays
// authoritative — the frontend mirrors the same range and never clamps.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const { goalValues } = require('../src/controllers/v2Controller');
const { ValidationError } = require('../src/errors/http');

function baseBody(targetValue) {
  return {
    title: 'Study more',
    goal_type: 'study_minutes',
    target_value: targetValue,
    period_type: 'weekly',
    start_date: '2026-01-01',
    due_date: '',
    target_jlpt_level: '',
    target_status: '',
    is_active: '1'
  };
}

test('goalValues accepts boundary values 1 and 999', () => {
  for (const value of [1, 999, 30, 120, '1', '30', '999']) {
    const values = goalValues(baseBody(value));
    assert.equal(values[2], Number(value), `target_value ${JSON.stringify(value)} stored as number`);
  }
});

test('goalValues rejects 0, negatives, and values above 999', () => {
  for (const value of [0, -1, -100, 1000, 931939193, '0', '-5', '1000']) {
    assert.throws(() => goalValues(baseBody(value)), ValidationError, `target_value ${JSON.stringify(value)} rejected`);
  }
});

test('goalValues rejects decimals and non-numbers without clamping', () => {
  for (const value of [1.5, 2.7, '1.5', 'abc', '12abc', '  ', 'NaN']) {
    assert.throws(() => goalValues(baseBody(value)), ValidationError, `target_value ${JSON.stringify(value)} rejected`);
  }
});

test('goalValues rejection explains the contract', () => {
  assert.throws(() => goalValues(baseBody(0)), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.message, 'target_value must be an integer between 1 and 999.');
    return true;
  });
});
