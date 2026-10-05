// Vocab polish tests: spec-shape cloze sentences (all occurrences,
// original passthrough, JMdict fallback), tag shapes and strict tag
// validation. In-memory fake executor (no database).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClozeSentence,
  getClozeSentences,
  getVocabTags,
  replaceVocabTags,
  sanitizeTagList,
  suggestTags
} = require('../src/services/contextualVocab');

const ITEM = { id_vocabulary: 7, word: '食べる', reading: 'たべる', meaning: 'to eat' };

function fakeStore({ item = ITEM, examples = [], links = [], jmdict = [] } = {}) {
  const store = {
    tags: [{ id_tag: 1, name: 'verb' }],
    links: links.map((name) => ({ id_tag: 1, id_vocabulary: 7, name })),
    nextTagId: 2
  };
  return {
    async execute(sql, params) {
      if (/FROM vocabulary WHERE/.test(sql)) return [item ? [item] : []];
      if (/FROM usage_examples/.test(sql)) return [examples];
      if (/jmdict_entries/.test(sql)) return [jmdict];
      if (/INSERT INTO tags/.test(sql)) {
        const name = params[2];
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
      throw new Error(`unexpected SQL in vocab polish test: ${sql.slice(0, 60)}`);
    }
  };
}

test('cloze replaces every occurrence and keeps the original', async () => {
  const executor = fakeStore({
    examples: [{ id_usage_example: 3, sentence: 'パンをたべる。たべるのが好き。', translation: 'I eat bread.' }]
  });
  const sentences = await getClozeSentences(executor, 7, 'user-1');
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].cloze, 'パンを＿＿。＿＿のが好き。');
  assert.equal(sentences[0].original, 'パンをたべる。たべるのが好き。');
  assert.equal(sentences[0].translation, 'I eat bread.');
  assert.equal(sentences[0].source, 'user_example');
  assert.equal(buildClozeSentence('パンを食べる', '食べる', 'たべる'), 'パンを＿＿');
  assert.equal(buildClozeSentence('今日は良い天気。', 'パン', 'ぱん'), null);
});

test('no user examples falls back to JMdict (empty corpus) and missing items to null', async () => {
  const executor = fakeStore({ examples: [], jmdict: [] });
  assert.deepEqual(await getClozeSentences(executor, 7, 'user-1'), []);
  const missing = fakeStore({ item: null });
  assert.equal(await getClozeSentences(missing, 999, 'user-1'), null);
  assert.equal(await getVocabTags(missing, 999, 'user-1'), null);
  assert.equal(await replaceVocabTags(missing, 999, 'user-1', ['verb']), null);
});

test('tags shape carries current tags plus suggestions', async () => {
  const executor = fakeStore({ links: ['verb'] });
  const result = await getVocabTags(executor, 7, 'user-1');
  assert.deepEqual(result.tags, ['verb']);
  assert.ok(!result.suggestedTags.includes('verb'), 'assigned tags are not suggested again');
  assert.ok(Array.isArray(result.suggestedTags));
});

test('tag validation caps count, length and characters', () => {
  assert.equal(sanitizeTagList('nope').error, 'tags must be an array of names');
  assert.ok(sanitizeTagList(Array.from({ length: 11 }, (_, i) => `tag-${i}`)).error.includes('at most 10'));
  assert.ok(sanitizeTagList(['this-tag-name-is-way-too-long']).error.includes('20 characters'));
  assert.ok(sanitizeTagList(['good tag!']).error.includes('letters, numbers and hyphens'));
  assert.ok(sanitizeTagList(['UPPER', 'with space']).error.includes('letters, numbers and hyphens'));
  assert.deepEqual(sanitizeTagList([' Verb ', 'food', 'verb']).value, ['verb', 'food']);
});

test('tag replacement normalizes, swaps links and rejects invalid input', async () => {
  const executor = fakeStore({ links: ['verb'] });
  const assigned = await replaceVocabTags(executor, 7, 'user-1', ['food', 'Food']);
  assert.deepEqual(assigned, ['food']);
  const after = await getVocabTags(executor, 7, 'user-1');
  assert.deepEqual(after.tags, ['food']);
  await assert.rejects(replaceVocabTags(executor, 7, 'user-1', ['bad tag!']), /letters, numbers and hyphens/);
  await assert.rejects(
    replaceVocabTags(executor, 7, 'user-1', Array.from({ length: 11 }, (_, i) => `t-${i}`)),
    /at most 10/
  );
});

test('suggestions follow the documented heuristic', () => {
  assert.ok(suggestTags({ word: '食べる', reading: 'たべる', meaning: 'to eat' }).includes('verb'));
  assert.ok(suggestTags({ word: '本', reading: 'ほん', meaning: 'the book' }).includes('noun'));
  assert.ok(suggestTags({ word: 'きらきら', reading: 'きらきら', meaning: 'glittering' }).includes('onomatopoeia'));
  assert.ok(!suggestTags({ word: '本', reading: 'ほん', meaning: 'the book' }).includes('verb'));
});
