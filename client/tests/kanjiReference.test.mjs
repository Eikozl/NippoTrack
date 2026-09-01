import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPristineKanjiAutofill,
  isSingleHanCodePoint
} from '../src/kanjiReference.js';

test('recognizes exactly one Han Unicode code point', () => {
  assert.equal(isSingleHanCodePoint('日'), true);
  assert.equal(isSingleHanCodePoint('𠮟'), true);
  assert.equal(isSingleHanCodePoint('日本'), false);
  assert.equal(isSingleHanCodePoint('あ'), false);
});

test('autofill only changes pristine fields', () => {
  const fields = {
    meaning: { value: '' },
    onyomi: { value: '' },
    kunyomi: { value: 'manual reading' },
    jlpt_level: { value: '' }
  };

  applyPristineKanjiAutofill(fields, new Set(['kunyomi']), {
    meanings: ['day', 'sun'],
    onyomi: ['ニチ', 'ジツ'],
    kunyomi: ['ひ'],
    jlptLevel: 'N5'
  });

  assert.equal(fields.meaning.value, 'day, sun');
  assert.equal(fields.onyomi.value, 'ニチ, ジツ');
  assert.equal(fields.kunyomi.value, 'manual reading');
  assert.equal(fields.jlpt_level.value, 'N5');
});
