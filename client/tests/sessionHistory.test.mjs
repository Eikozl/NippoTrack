import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSessionSubmitPayload,
  SESSION_FORM_FIELD_ORDER,
  sessionCardModel,
  submitPayloadOmitsHiddenFields
} from '../src/sessionHistory.js';

test('Session UX: card with writing title/content shows a useful preview', () => {
  const model = sessionCardModel({
    id_session: 1,
    session_date: '2026-09-01',
    duration_minutes: 30,
    category: 'Writing',
    resource: 'Genki Ch. 4',
    notes: 'Felt good.',
    writing_title: 'My weekend',
    writing_excerpt: '今日は学校に行く。とても楽しかったです。',
    vocabulary_count: 3,
    kanji_count: 2,
    grammar_count: 0
  });
  assert.equal(model.badge, 'Writing');
  assert.equal(model.durationLabel, '30 min');
  assert.equal(model.title, 'My weekend');
  assert.equal(model.preview, '今日は学校に行く。とても楽しかったです。');
  assert.deepEqual(model.meta.map((row) => row.label), ['Resource', 'Vocabulary', 'Kanji']);
  assert.ok(model.meta.find((row) => row.label === 'Resource').text.includes('Genki'));
});

test('Session UX: missing resource renders no placeholder and falls back cleanly', () => {
  const model = sessionCardModel({
    id_session: 2,
    session_date: '2026-09-02',
    duration_minutes: 15,
    category: 'Reading',
    resource: null,
    notes: null,
    writing_title: null,
    writing_excerpt: null,
    vocabulary_count: 0,
    kanji_count: 0,
    grammar_count: 0
  });
  assert.equal(model.title, 'Reading session');
  assert.equal(model.preview, null);
  assert.deepEqual(model.meta, []);
  assert.doesNotMatch(JSON.stringify(model), /No resource recorded/);
  assert.doesNotMatch(JSON.stringify(model), /No .* recorded/);
});

test('Session UX: empty optional metadata is omitted, present metadata shown', () => {
  const model = sessionCardModel({
    category: 'Vocabulary',
    duration_minutes: 20,
    session_date: '2026-09-03',
    resource: '  ',
    notes: 'reviewed N5 words',
    vocabulary_count: 1,
    kanji_count: 0,
    grammar_count: 2
  });
  assert.deepEqual(model.meta.map((row) => [row.label, row.text]), [
    ['Vocabulary', '1 item'],
    ['Grammar', '2 items']
  ]);
  // Notes preview is used only when no writing excerpt exists.
  assert.equal(model.preview, 'reviewed N5 words');
});

test('Session UX: metadata stays as separate entries for the card renderer', () => {
  const model = sessionCardModel({
    category: 'Writing',
    duration_minutes: 30,
    session_date: '2026-09-01',
    resource: 'JLT review',
    vocabulary_count: 7,
    kanji_count: 0,
    grammar_count: 0
  });
  // The card renders one element per entry with its own separator; the model
  // must never pre-concatenate entries into a single string.
  assert.ok(Array.isArray(model.meta));
  assert.deepEqual(model.meta.map((row) => row.key), ['resource', 'vocabulary_count']);
  for (const row of model.meta) {
    assert.ok(typeof row.label === 'string' && typeof row.text === 'string');
    assert.ok(!row.text.includes('Vocabulary') && !row.text.includes('Resource'));
  }
  assert.doesNotMatch(JSON.stringify(model.meta), /·/);
});

test('Session UX: malformed sessions degrade without crashing', () => {
  assert.deepEqual(sessionCardModel(null).meta, []);
  assert.equal(sessionCardModel(null).title, 'Study session');
  assert.equal(sessionCardModel({}).preview, null);
  assert.equal(sessionCardModel(undefined).badge, 'Session');
});

test('Session UX: simplified form order is Basic → Resource → Writing → Notes', () => {
  assert.deepEqual(SESSION_FORM_FIELD_ORDER, [
    'category',
    'session_date',
    'duration_minutes',
    'resource',
    'writing_title',
    'writing_content',
    'notes'
  ]);
  assert.ok(!SESSION_FORM_FIELD_ORDER.includes('writing_notes'));
  assert.ok(!SESSION_FORM_FIELD_ORDER.some((name) => name.endsWith('_ids')));
});

test('Session UX: submit payload hides linking IDs and writing notes (edit-safe)', () => {
  const payload = buildSessionSubmitPayload({
    category: 'Writing',
    session_date: '2026-09-01',
    duration_minutes: '30',
    resource: 'Genki',
    writing_title: 'My weekend',
    writing_content: '今日は学校に行く',
    notes: 'Good session.'
  });
  assert.equal(payload.writing_title, 'My weekend');
  assert.equal(payload.writing_content, '今日は学校に行く');
  assert.equal(payload.notes, 'Good session.');
  assert.equal(submitPayloadOmitsHiddenFields(payload), true);
  for (const hidden of ['vocabulary_ids', 'kanji_ids', 'grammar_ids', 'writing_notes']) {
    assert.ok(!(hidden in payload), `${hidden} must never be submitted`);
  }
});

test('Session UX: empty writing travels nothing, notes still save', () => {
  const payload = buildSessionSubmitPayload({
    category: 'Reading',
    session_date: '2026-09-02',
    duration_minutes: 15,
    resource: '',
    writing_title: '  ',
    writing_content: '',
    notes: 'Read two pages.'
  });
  assert.ok(!('writing_title' in payload) && !('writing_content' in payload));
  assert.equal(payload.notes, 'Read two pages.');
  assert.equal(submitPayloadOmitsHiddenFields(payload), true);
});

test('Session UX: legacy records with hidden data keep it out of the payload by construction', () => {
  // A record may carry vocabulary/kanji/grammar links and writing notes;
  // the simplified form only forwards visible values, so a PUT built from
  // it cannot clear what it never names.
  const record = {
    vocabulary: [{ id_vocabulary: 1 }],
    kanji: [{ id_kanji: 2 }],
    grammar: [{ id_grammar: 3 }],
    writing: { title: 'T', content: 'C', notes: 'hidden writing notes' }
  };
  const payload = buildSessionSubmitPayload({
    category: 'Writing',
    session_date: '2026-09-01',
    duration_minutes: 30,
    resource: '',
    writing_title: record.writing.title,
    writing_content: record.writing.content,
    notes: ''
  });
  assert.equal(submitPayloadOmitsHiddenFields(payload), true);
  assert.equal(payload.writing_content, 'C');
});
