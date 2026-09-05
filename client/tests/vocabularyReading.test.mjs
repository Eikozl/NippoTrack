import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VOCAB_READING_NOTICE,
  buildKanjiImportPayload,
  formatKanjiContextEntry,
  getContextKanji,
  getReadingContext,
  hasClaimedSegment
} from '../src/vocabularyReading.js';

function kyouItem() {
  return {
    word: '今日',
    reading: 'きょう',
    meaning: 'today',
    kanji: [
      { id_kanji: 1, character_kanji: '今', meaning: 'now' },
      { id_kanji: 2, character_kanji: '日', meaning: 'day' }
    ],
    readingContext: {
      wordReading: { value: 'きょう', provenance: 'authoritative' },
      kanji: [
        {
          idKanji: 1, character: '今', meaning: 'now', userOnyomi: 'コン', userKunyomi: 'いま',
          userProvenance: 'user',
          reference: { onyomi: ['コン'], kunyomi: ['いま'], meanings: ['now'], provenance: 'reference', contextualOnly: true },
          readingSegment: null, readingProvenance: 'unverified'
        },
        {
          idKanji: 2, character: '日', meaning: 'day', userOnyomi: 'ニチ', userKunyomi: 'ひ',
          userProvenance: 'user',
          reference: { onyomi: ['ニチ'], kunyomi: ['ひ'], meanings: ['day'], provenance: 'reference', contextualOnly: true },
          readingSegment: null, readingProvenance: 'unverified'
        }
      ],
      notice: VOCAB_READING_NOTICE
    }
  };
}

test('word reading stays authoritative and no per-kanji segment is claimed', () => {
  const item = kyouItem();
  const context = getReadingContext(item);
  assert.equal(context.wordReading.value, 'きょう');
  assert.equal(context.wordReading.provenance, 'authoritative');
  for (const entry of getContextKanji(item)) {
    assert.equal(hasClaimedSegment(entry), false);
    assert.equal(entry.readingProvenance, 'unverified');
  }
});

test('reference readings format as context-only inventories', () => {
  const formatted = formatKanjiContextEntry(kyouItem().readingContext.kanji[0]);
  assert.equal(formatted.character, '今');
  assert.equal(formatted.userOnyomi, 'コン');
  assert.equal(formatted.referenceOnyomi, 'コン');
  assert.equal(formatted.referenceKunyomi, 'いま');
  assert.equal(formatted.readingSegment, null);
  assert.equal(formatted.unverified, true);
});

test('legacy payloads without readingContext degrade gracefully', () => {
  assert.equal(getReadingContext(null), null);
  assert.equal(getReadingContext({ word: '今日' }), null);
  assert.deepEqual(getContextKanji({ word: '今日' }), []);
  assert.equal(hasClaimedSegment(null), false);
  assert.equal(hasClaimedSegment({ readingSegment: '' }), false);
  assert.equal(hasClaimedSegment({ readingSegment: '   ' }), false);
  assert.ok(VOCAB_READING_NOTICE.includes('not derived'));
});

test('irregular words never expose split fragments (大人/明日)', () => {
  const otona = {
    word: '大人', reading: 'おとな',
    readingContext: {
      wordReading: { value: 'おとな', provenance: 'authoritative' },
      kanji: [
        { character: '大', readingSegment: null, readingProvenance: 'unverified', reference: { onyomi: ['ダイ'], kunyomi: ['おお'], meanings: ['large'] } },
        { character: '人', readingSegment: null, readingProvenance: 'unverified', reference: { onyomi: ['ジン'], kunyomi: ['ひと'], meanings: ['person'] } }
      ],
      notice: VOCAB_READING_NOTICE
    }
  };
  const serialized = JSON.stringify(otona.readingContext);
  // Forbidden artificial fragments must not exist as claimed segments.
  for (const entry of otona.readingContext.kanji) assert.equal(hasClaimedSegment(entry), false);
  assert.doesNotMatch(serialized, /"readingSegment":"[^"]+"/);
  assert.equal(getReadingContext(otona).wordReading.value, 'おとな');
});

function ashitaPartialItem() {
  return {
    word: '明日', reading: 'あした',
    readingContext: {
      wordReading: { value: 'あした', provenance: 'authoritative' },
      kanji: [
        {
          character: '明', inUserCollection: false, userKanji: null,
          userOnyomi: null, userKunyomi: null, userProvenance: 'user',
          reference: { onyomi: ['メイ'], kunyomi: ['あ'], meanings: ['bright'], jlptLevel: 'N4', provenance: 'reference', contextualOnly: true },
          readingSegment: null, readingProvenance: 'unverified'
        },
        {
          character: '日', inUserCollection: true,
          userKanji: { idKanji: 2, meaning: 'day', jlptLevel: 'N5', status: 'New', onyomi: 'ニチ', kunyomi: 'ひ' },
          userOnyomi: 'ニチ', userKunyomi: 'ひ', userProvenance: 'user',
          reference: { onyomi: ['ニチ'], kunyomi: ['ひ'], meanings: ['day'], jlptLevel: 'N5', provenance: 'reference', contextualOnly: true },
          readingSegment: null, readingProvenance: 'unverified'
        }
      ],
      notice: VOCAB_READING_NOTICE
    }
  };
}

test('partial collection marks 明 missing and 日 collected (明日/あした)', () => {
  const entries = getContextKanji(ashitaPartialItem()).map(formatKanjiContextEntry);
  assert.deepEqual(entries.map((entry) => entry.character), ['明', '日']);
  const mei = entries.find((entry) => entry.character === '明');
  assert.equal(mei.inUserCollection, false);
  assert.equal(mei.userKanji, null);
  assert.equal(mei.hasReference, true);
  assert.equal(mei.referenceMeanings, 'bright');
  assert.equal(mei.importable, true);
  assert.equal(mei.readingSegment, null);
  const nichi = entries.find((entry) => entry.character === '日');
  assert.equal(nichi.inUserCollection, true);
  assert.equal(nichi.importable, false);
  assert.equal(nichi.userOnyomi, 'ニチ');
});

test('import payload follows kanji creation conventions and never splits readings', () => {
  const [mei, nichi] = ashitaPartialItem().readingContext.kanji;
  assert.deepEqual(buildKanjiImportPayload(mei), {
    character_kanji: '明',
    meaning: 'bright',
    onyomi: 'メイ',
    kunyomi: 'あ',
    jlpt_level: 'N4',
    status: 'New'
  });
  // Already-collected kanji are not importable.
  assert.equal(buildKanjiImportPayload(nichi), null);
  // No reference data (unknown Han) is not importable as-is.
  assert.equal(buildKanjiImportPayload({ character: '𠮟', inUserCollection: false, userKanji: null, reference: null, readingSegment: null }), null);
  assert.equal(formatKanjiContextEntry({ character: '𠮟', inUserCollection: false, reference: null, readingSegment: null }).hasReference, false);
  // Reference without meanings cannot satisfy required kanji meaning.
  assert.equal(buildKanjiImportPayload({ character: '明', inUserCollection: false, reference: { onyomi: ['メイ'], kunyomi: [], meanings: [] }, readingSegment: null }), null);
});
