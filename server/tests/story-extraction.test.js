// Story extraction tests: preview shaping, validation and enroll wiring
// against a fake executor (no database). The real kuromoji engine runs;
// reference/ownership lookups are stubbed empty.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enrollStoryItems,
  fetchStory,
  previewExtraction,
  validateStoryText
} = require('../src/services/storyExtraction');

const STORY = { id_content_entry: 11, user_id: 'user-1', title: 'Test', source_text: '学校に行く。' };

function fakeStore({ story = STORY, reviewItemId = 301 } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push(sql);
      if (/FROM content_entries WHERE id_content_entry/.test(sql)) return [story ? [story] : []];
      if (/INSERT INTO vocabulary/.test(sql)) return [{ insertId: 201 }];
      if (/INSERT INTO kanji/.test(sql)) return [{ insertId: 202 }];
      if (/INSERT INTO grammar_points/.test(sql)) return [{ insertId: 203 }];
      if (/INSERT INTO review_items/.test(sql)) return [[{ affectedRows: 1 }]];
      if (/FROM review_items WHERE/.test(sql)) return [[{ id_review_item: reviewItemId }]];
      if (/INSERT INTO story_review_links/.test(sql)) return [[{ affectedRows: 1 }]];
      if (/UPDATE content_entries SET/.test(sql)) return [[{ affectedRows: 1 }]];
      if (/^\s*SELECT/i.test(sql)) return [[]];
      throw new Error(`unexpected SQL in story test: ${sql.slice(0, 60)}`);
    }
  };
}

test('preview shapes kanji frequency plus vocab and grammar', async () => {
  const preview = await previewExtraction(fakeStore(), 'user-1', '学校に行く。学校が好き。');
  const gakkou = preview.kanji.find((entry) => entry.char === '学');
  assert.ok(gakkou, 'kanji detected');
  assert.equal(gakkou.frequency, 2, 'repeat occurrences counted');
  assert.ok(preview.vocab.length > 0, 'vocabulary candidates present');
  assert.ok(Array.isArray(preview.grammar), 'grammar array present');
});

test('preview validates text boundaries', async () => {
  await assert.rejects(previewExtraction(fakeStore(), 'user-1', '   '), /must not be empty/);
  await assert.rejects(previewExtraction(fakeStore(), 'user-1', 'あ'.repeat(5001)), /maximum length/);
  assert.throws(() => validateStoryText(null), /must not be empty/);
});

test('fetchStory returns null for foreign or missing stories', async () => {
  assert.ok(await fetchStory(fakeStore(), 11, 'user-1'), 'owned story returned');
  assert.equal(await fetchStory(fakeStore({ story: null }), 999, 'user-1'), null);
});

test('enroll intersects fresh analysis, ensures entities and links review items', async () => {
  const store = fakeStore();
  // Real candidate ids from a fresh analysis instead of guessing.
  const { runAnalysis } = require('../src/services/immersionPipeline');
  const analysis = await runAnalysis(store, 'user-1', STORY.source_text);
  const ids = [
    ...analysis.candidates.vocabulary.slice(0, 2).map((candidate) => candidate.id),
    ...analysis.candidates.kanji.slice(0, 2).map((candidate) => candidate.id)
  ];
  assert.ok(ids.length > 0, 'analysis yields selectable candidates');
  const result = await enrollStoryItems(store, 'user-1', 11, ids);
  assert.ok(result.created > 0, 'review items created');
  assert.equal(result.reviewItems.length, result.created);
  assert.ok(store.calls.some((sql) => /INSERT INTO story_review_links/.test(sql)), 'story linked');
  assert.ok(store.calls.some((sql) => /UPDATE content_entries SET/.test(sql)), 'extracted_json stored');
});

test('enroll rejects missing text, empty selection and foreign stories', async () => {
  const noText = fakeStore({ story: { ...STORY, source_text: null } });
  await assert.rejects(enrollStoryItems(noText, 'user-1', 11, ['vocabulary::x::']), /no text to extract/);
  await assert.rejects(enrollStoryItems(fakeStore(), 'user-1', 11, []), /non-empty array/);
  const unknown = await enrollStoryItems(fakeStore(), 'user-1', 11, ['not-a-candidate']);
  assert.equal(unknown.created, 0, 'unknown ids intersect to a graceful no-op');
  assert.equal(await enrollStoryItems(fakeStore({ story: null }), 'user-1', 999, ['a']), null);
});
