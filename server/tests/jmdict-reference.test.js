// CA-B1 unit tests: JMdict normalization, validation, identity, and audit
// helpers. Pure logic only — no database, no network, no filesystem beyond the
// committed sample fixture. Every test names the implementation bug that would
// make it fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  JMDICT_IMPORTER_VERSION,
  IMPORT_BATCH_SIZE,
  JMDICT_EVAL_SENSE_VALVE,
  JmdictImportError,
  normalizeJmdictForm,
  hasHanCharacter,
  normalizeJmdictWord,
  snapshotIdentity
} = require('../src/services/jmdictReference');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jmdict-sample.json'), 'utf8'));

function word(id) {
  return fixture.words.find((entry) => entry.id === id);
}

test('lookup key folds kana but preserves display-relevant marks', () => {
  // Bug guarded: NFKC/strip-happy normalizer corrupting identity (〜, ・, - are
  // legitimate in JMdict readings; normalizeJapaneseReading would strip them).
  assert.equal(normalizeJmdictForm('ガッコウ'), 'がっこう');
  assert.equal(normalizeJmdictForm('お〜'), 'お〜');
  assert.equal(normalizeJmdictForm('・'), '・');
  assert.throws(() => normalizeJmdictForm(''), JmdictImportError);
  assert.throws(() => normalizeJmdictForm(null), JmdictImportError);
});

test('orthographic detector separates keb-bearing from kana-only strings', () => {
  // Bug guarded: B2 identity-strategy helper disagreeing with importer keys.
  assert.equal(hasHanCharacter('行く'), true);
  assert.equal(hasHanCharacter('はし'), false);
  assert.equal(hasHanCharacter('タベル'), false);
});

test('basic noun normalizes with keb/reb forms and single sense', () => {
  // Bug guarded: ent_seq parsed as string, or kana-only entries rejected.
  const record = normalizeJmdictWord(word('1000001'));
  assert.equal(record.entSeq, 1000001);
  assert.equal(record.isCommon, true);
  assert.deepEqual(record.posSummary, ['n']);
  assert.equal(record.forms.length, 2);
  assert.deepEqual(record.forms[0], { surface: '学校', normalized: '学校', kind: 'keb', restr: [], isCommon: true, nokanji: false });
  assert.deepEqual(record.forms[1], { surface: 'がっこう', normalized: 'がっこう', kind: 'reb', restr: [], isCommon: true, nokanji: false });
  assert.equal(record.senses.length, 1);
  assert.deepEqual(record.senses[0].glossEn, ['school']);
  assert.match(record.checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(record.doc.id, '1000001');
});

test('verb keeps raw POS codes verbatim for the C1/B2 mapping table', () => {
  // Bug guarded: "helpful" POS rewriting at import time destroying the audit.
  const record = normalizeJmdictWord(word('1000002'));
  assert.deepEqual(record.senses[0].pos, ['v1', 'vt']);
  assert.deepEqual(record.senses[0].glossEn, ['to eat']);
});

test('stagk triple keeps per-sense spelling restrictions', () => {
  // Bug guarded: restriction flattening that would let あつい match any keb.
  const record = normalizeJmdictWord(word('1000003'));
  assert.deepEqual(record.senses.map((sense) => sense.stagk), [['暑い'], ['熱い'], ['厚い']]);
  assert.deepEqual(record.senses.map((sense) => sense.stagr), [[], [], []]);
  assert.deepEqual(record.senses.map((sense) => sense.glossEn), [['hot (weather)'], ['hot (object)'], ['thick']]);
});

test('stagr pair keeps per-sense reading restrictions', () => {
  // Bug guarded: reading-blind sense enumeration (ひらく vs あく collapse).
  const record = normalizeJmdictWord(word('1000004'));
  assert.deepEqual(record.senses.map((sense) => sense.stagr), [['ひらく'], ['あく']]);
  assert.deepEqual(record.forms.filter((form) => form.kind === 'reb').map((form) => form.surface), ['ひらく', 'あく']);
});

test('kana-only entry produces reb forms and no keb forms', () => {
  // Bug guarded: keb-key queries matching kana-only entries (H4 direction).
  const record = normalizeJmdictWord(word('1000005'));
  assert.equal(record.forms.some((form) => form.kind === 'keb'), false);
  assert.equal(record.forms.length, 1);
  assert.deepEqual(record.senses[0].pos, ['adv']);
});

test('applies-to-none reading is flagged nokanji but kept for kana matching', () => {
  // Bug guarded: dropping applies-to-none readings (recall loss) or leaving
  // them unrestricted (kanji observation claiming an impossible reading).
  const record = normalizeJmdictWord(word('1000007'));
  const flagged = record.forms.find((form) => form.surface === 'け');
  assert.deepEqual(flagged.restr, []);
  assert.equal(flagged.nokanji, true);
  const normal = record.forms.find((form) => form.surface === 'かり');
  assert.equal(normal.nokanji, false);
});

test('typed glosses fall back deterministically, gloss-less senses fail', () => {
  // Bug guarded: empty gloss_en rows (B2 would display/suggest nothing) or
  // silently preferring a figurative gloss over a translation.
  const base = word('1000001');
  const typed = JSON.parse(JSON.stringify(base));
  typed.sense[0].gloss = [
    { text: 'figurative school', lang: 'eng', type: 'figurative' },
    { text: 'school', lang: 'eng' }
  ];
  assert.deepEqual(normalizeJmdictWord(typed).senses[0].glossEn, ['school']);
  const onlyTyped = JSON.parse(JSON.stringify(base));
  onlyTyped.sense[0].gloss = [{ text: 'figurative school', lang: 'eng', type: 'figurative' }];
  assert.deepEqual(normalizeJmdictWord(onlyTyped).senses[0].glossEn, ['figurative school']);
  const none = JSON.parse(JSON.stringify(base));
  none.sense[0].gloss = [{ text: 'école', lang: 'fre' }];
  assert.throws(() => normalizeJmdictWord(none), /no English gloss/);
});

test('dangling restriction targets fail with entry context', () => {
  // Bug guarded: quiet restriction loss — the high-harm class that can later
  // manufacture false semantic certainty.
  const stagk = JSON.parse(JSON.stringify(word('1000003')));
  stagk.sense[0].appliesToKanji = ['存在しない'];
  assert.throws(() => normalizeJmdictWord(stagk), /stagk target has no keb/);
  const stagr = JSON.parse(JSON.stringify(word('1000004')));
  stagr.sense[0].appliesToKana = ['よみ'];
  assert.throws(() => normalizeJmdictWord(stagr), /stagr target has no reb/);
  const restr = JSON.parse(JSON.stringify(word('1000002')));
  restr.kana[0].appliesToKanji = ['存在しない'];
  assert.throws(() => normalizeJmdictWord(restr), /reading restriction target has no keb/);
  try {
    normalizeJmdictWord(stagk);
    assert.fail('expected entry-scoped error');
  } catch (error) {
    assert.equal(error.entryId, 1000003);
  }
});

test('malformed words fail loudly, never partially', () => {
  // Bug guarded: corrupt rows entering the snapshot (bad id, missing kana or
  // senses, non-array restriction fields).
  assert.throws(() => normalizeJmdictWord({ id: 'abc', kana: [{ text: 'あ' }], sense: [{ gloss: [{ text: 'x', lang: 'eng' }] }] }), /invalid id/);
  assert.throws(() => normalizeJmdictWord({ id: '1', kanji: [], kana: [], sense: [{ gloss: [{ text: 'x', lang: 'eng' }] }] }), /kana must be a non-empty array/);
  assert.throws(() => normalizeJmdictWord({ id: '1', kanji: [], kana: [{ text: 'あ' }], sense: [] }), /sense must be a non-empty array/);
  assert.throws(() => normalizeJmdictWord({ id: '1', kana: [{ text: 'あ', appliesToKanji: 'あ' }], sense: [{ gloss: [{ text: 'x', lang: 'eng' }] }] }), /must be an array/);
  const dup = JSON.parse(JSON.stringify(word('1000001')));
  dup.kana.push({ text: 'がっこう', common: false, tags: [], appliesToKanji: ['*'] });
  assert.throws(() => normalizeJmdictWord(dup), /duplicate reb/);
});

test('checksum is deterministic for identical input', () => {
  // Bug guarded: unstable integrity hashes (key order, spacing) making row
  // checksums unverifiable across runs.
  const first = normalizeJmdictWord(word('1000001'));
  const second = normalizeJmdictWord(JSON.parse(JSON.stringify(word('1000001'))));
  assert.equal(first.checksum, second.checksum);
});

test('snapshot identity refuses untraceable provenance', () => {
  // Bug guarded: importing a snapshot whose origin cannot be reproduced.
  assert.throws(() => snapshotIdentity({ converterVersion: 'x', sha256: '0'.repeat(64) }), /provenance/);
  assert.throws(() => snapshotIdentity({ fileDate: '2026-09-07', converterVersion: 'x', sha256: 'xyz' }), /64/);
  const identity = snapshotIdentity({ fileDate: '2026-09-07', converterVersion: '3.6.2', sha256: 'a'.repeat(64) });
  assert.equal(identity.sourceName, 'JMdict');
  assert.equal(identity.converter, 'jmdict-simplified');
});

test('importer constants match frozen architecture', () => {
  // Bug guarded: batch/valve drift from the frozen CA-A.2 contract.
  assert.equal(JMDICT_EVAL_SENSE_VALVE, 64);
  assert.ok(Number.isInteger(IMPORT_BATCH_SIZE) && IMPORT_BATCH_SIZE >= 1 && IMPORT_BATCH_SIZE <= 5000);
  assert.match(JMDICT_IMPORTER_VERSION, /^[a-z0-9.-]+$/);
});
