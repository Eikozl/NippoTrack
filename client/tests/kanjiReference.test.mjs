import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPristineKanjiAutofill,
  changedKanjiReferenceFields,
  isSingleHanCodePoint,
  kanjiReferenceRoute,
  parseKanjiReferenceRoute,
  transliteratedValue
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

test('identifies only canonical kanji fields changed from their original values', () => {
  assert.deepEqual(
    changedKanjiReferenceFields(
      { character_kanji: '日', meaning: 'day', onyomi: 'ニチ', kunyomi: 'ひ', jlpt_level: 'N5' },
      { character_kanji: '日', meaning: 'sun', onyomi: 'ニチ', kunyomi: 'ひ', jlpt_level: 'N4' }
    ),
    ['meaning', 'jlpt_level']
  );
});

test('round-trips an exact Han character through the reference route', () => {
  assert.equal(kanjiReferenceRoute('食'), 'kanji-reference/%E9%A3%9F');
  assert.equal(parseKanjiReferenceRoute('kanji-reference/%E9%A3%9F'), '食');
  assert.equal(kanjiReferenceRoute('日本'), null);
  assert.equal(parseKanjiReferenceRoute('kanji-reference/%E6%97%A5%E6%9C%AC'), null);
});

test('selects the requested kana script from a complete romaji transliteration', () => {
  assert.equal(transliteratedValue({ hiragana: 'しょく', katakana: 'ショク' }, 'hiragana'), 'しょく');
  assert.equal(transliteratedValue({ hiragana: 'しょく', katakana: 'ショク' }, 'katakana'), 'ショク');
  assert.equal(transliteratedValue(null, 'hiragana'), null);
});
