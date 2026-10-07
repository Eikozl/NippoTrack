import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSessionSubmitPayload,
  SESSION_FORM_FIELD_ORDER,
  sessionCardModel,
  submitPayloadOmitsHiddenFields
} from '../src/sessionHistory.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

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

test('Session UX: compact form order is Basic → Linked material → Writing → Notes', () => {
  assert.deepEqual(SESSION_FORM_FIELD_ORDER, [
    'category',
    'session_date',
    'duration_minutes',
    'resource',
    'vocabulary_ids',
    'kanji_ids',
    'grammar_ids',
    'writing_title',
    'writing_content',
    'notes'
  ]);
  assert.ok(!SESSION_FORM_FIELD_ORDER.includes('writing_notes'));
});

test('Session UX: payload without linking values omits linking IDs and writing notes (preserve on edit)', () => {
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
  for (const hidden of ['writing_notes']) {
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

test('Session UX: records without linking values keep links out of the payload (preserve on edit)', () => {
  // A record may carry vocabulary/kanji/grammar links and writing notes; a
  // payload built without linking values names no linking arrays, so the
  // backend preserves whatever is stored. Writing notes are never forwarded.
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

test('Session UX: supplied linking IDs pass through sanitized (replace on edit)', () => {
  const payload = buildSessionSubmitPayload({
    category: 'Vocabulary',
    session_date: '2026-09-01',
    duration_minutes: 30,
    resource: '',
    vocabulary_ids: [3, 1, 3, 0, -2],
    kanji_ids: [7],
    grammar_ids: [],
    notes: ''
  });
  assert.deepEqual(payload.vocabulary_ids, [3, 1]);
  assert.deepEqual(payload.kanji_ids, [7]);
  // Empty arrays travel explicitly: clearing every picker clears the links.
  assert.deepEqual(payload.grammar_ids, []);
  assert.equal(submitPayloadOmitsHiddenFields(payload), false);
  assert.ok(!('writing_notes' in payload), 'writing notes are never submitted');
});

test('Session UX: edit round-trips the record links instead of dropping them', () => {
  const record = {
    vocabulary: [{ id_vocabulary: 4 }, { id_vocabulary: 9 }],
    kanji: [{ id_kanji: 2 }],
    grammar: []
  };
  const payload = buildSessionSubmitPayload({
    category: 'Vocabulary',
    session_date: '2026-09-01',
    duration_minutes: 30,
    resource: '',
    vocabulary_ids: record.vocabulary.map((item) => item.id_vocabulary),
    kanji_ids: record.kanji.map((item) => item.id_kanji),
    grammar_ids: record.grammar.map((item) => item.id_grammar),
    notes: ''
  });
  assert.deepEqual(payload.vocabulary_ids, [4, 9]);
  assert.deepEqual(payload.kanji_ids, [2]);
  assert.deepEqual(payload.grammar_ids, []);
});

test('Session UX: form restores the compact optional linking section', () => {
  const source = readSource('src/pages/sessions.js');
  assert.ok(source.includes('Link studied items (optional)'), 'honest optional label, never auto-link claims');
  assert.ok(source.includes('Nothing is linked automatically'), 'no magical linking promised');
  assert.ok(source.includes('searchableMultiSelect'), 'compact pickers reuse the shared primitive');
  for (const name of ['vocabulary_ids', 'kanji_ids', 'grammar_ids']) {
    assert.ok(source.includes(`name: '${name}'`), `picker submits ${name}`);
  }
  assert.ok(source.includes('loadRelationshipOptions'), 'edit pre-selects current links for the round trip');
  assert.ok(source.includes('/api/vocabulary/options') && source.includes('/api/kanji/options') && source.includes('/api/grammar/options'), 'pickers reuse the existing options endpoints');
  assert.ok(source.includes('selectedNumbers(form.elements.vocabulary_ids)'), 'submit reads the picker selections');
});
