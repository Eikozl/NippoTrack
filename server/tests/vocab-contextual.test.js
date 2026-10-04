// Contextual vocabulary tests: cloze building, tag suggestions and tag
// replacement against an in-memory fake executor (no database).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCloze,
  getClozeSentences,
  getVocabTags,
  replaceVocabTags,
  suggestTags
} = require('../src/services/contextualVocab');

const ITEM = { id_vocabulary: 7, word: '食べる', reading: 'たべる', meaning: 'to eat' };

function fakeStore({ item = ITEM, examples = [], links = [] } = {}) {
  const store = {
    tags: [{ id_tag: 1, name: 'verb' }],
    links: links.map((name) => ({ id_tag: 1, id_vocabulary: 7, name })),
    nextTagId: 2
  };
  return {
    async execute(sql, params) {
      if (/FROM vocabulary WHERE/.test(sql)) return [item ? [item] : []];
      if (/FROM usage_examples/.test(sql)) return [examples];
      if (/INSERT INTO tags/.test(sql)) {
        const name = params[1];
        if (!store.tags.some((tag) => tag.name === name)) {
          store.tags.push({ id_tag: store.nextTagId++, name });
        }
        return [[{ affectedRows: 1 }]];
      }
      if (/DELETE FROM tag_vocabulary/.test(sql)) {
        store.links = store.links.filter((link) => link.id_vocabulary !== params[0]);
        return [[{ affectedRows: 1 }]];
      }
      if (/INSERT INTO tag_vocabulary/.test(sql)) {
        const tag = store.tags.find((entry) => entry.name === params[1]);
        if (tag && !store.links.some((link) => link.id_tag === tag.id_tag && link.id_vocabulary === params[0])) {
          store.links.push({ id_tag: tag.id_tag, id_vocabulary: params[0], name: tag.name });
        }
        return [[{ affectedRows: 1 }]];
      }
      if (/JOIN tag_vocabulary/.test(sql)) {
        return [store.links
          .filter((link) => link.id_vocabulary === params[0])
          .map((link) => ({ id_tag: link.id_tag, name: link.name }))
          .sort((a, b) => (a.name < b.name ? -1 : 1))];
      }
      throw new Error(`unexpected SQL in contextual vocab test: ${sql.slice(0, 60)}`);
    }
  };
}

test('cloze replaces the word form with a blank', async () => {
  const executor = fakeStore({
    examples: [{ id_usage_example: 3, sentence: '朝ごはんを食べる。', translation: 'I eat breakfast.' }]
  });
  const result = await getClozeSentences(executor, 7, 'user-1');
  assert.equal(result.item.word, '食べる');
  assert.equal(result.sentences.length, 1);
  assert.equal(result.sentences[0].cloze, '朝ごはんを＿＿。');
  assert.equal(result.sentences[0].translation, 'I eat breakfast.');
  assert.equal(result.sentences[0].source, 'example');
});

test('cloze falls back to the reading and skips sentences without either form', async () => {
  const executor = fakeStore({
    examples: [
      { id_usage_example: 4, sentence: 'たべるのが好き。', translation: null },
      { id_usage_example: 5, sentence: '今日は良い天気。', translation: null }
    ]
  });
  const result = await getClozeSentences(executor, 7, 'user-1');
  assert.equal(result.sentences.length, 1);
  assert.equal(result.sentences[0].cloze, '＿＿のが好き。');
  assert.equal(buildCloze('今日は良い天気。', '食べる', 'たべる'), null);
});

test('missing entries resolve to null (controller maps to 404)', async () => {
  const executor = fakeStore({ item: null });
  assert.equal(await getClozeSentences(executor, 999, 'user-1'), null);
  assert.equal(await getVocabTags(executor, 999, 'user-1'), null);
  assert.equal(await replaceVocabTags(executor, 999, 'user-1', ['verb']), null);
});

test('tag suggestions follow the documented heuristic', () => {
  assert.ok(suggestTags({ word: '食べる', reading: 'たべる', meaning: 'to eat' }).includes('verb'));
  assert.ok(suggestTags({ word: '本', reading: 'ほん', meaning: 'the book' }).includes('noun'));
  assert.ok(suggestTags({ word: 'きらきら', reading: 'きらきら', meaning: 'glittering' }).includes('onomatopoeia'));
  assert.ok(suggestTags({ word: 'です', reading: 'です', meaning: 'polite copula' }).includes('polite'));
  assert.ok(!suggestTags({ word: '本', reading: 'ほん', meaning: 'the book' }).includes('verb'));
});

test('tag replacement normalizes, swaps links and hides assigned suggestions', async () => {
  const executor = fakeStore({ links: ['verb'] });
  const before = await getVocabTags(executor, 7, 'user-1');
  assert.deepEqual(before.assigned.map((entry) => entry.name), ['verb']);
  assert.ok(!before.suggested.includes('verb'), 'assigned tags are not suggested again');
  const assigned = await replaceVocabTags(executor, 7, 'user-1', [' Verb ', 'FOOD', 'verb']);
  assert.deepEqual(assigned.map((entry) => entry.name), ['food', 'verb']);
  const after = await getVocabTags(executor, 7, 'user-1');
  assert.deepEqual(after.assigned.map((entry) => entry.name), ['food', 'verb']);
});
