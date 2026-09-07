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
  BULK_CHUNK_ROWS,
  JMDICT_EVAL_SENSE_VALVE,
  JmdictImportError,
  normalizeJmdictForm,
  hasHanCharacter,
  normalizeJmdictWord,
  insertNormalizedBatch,
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
  assert.ok(Number.isInteger(BULK_CHUNK_ROWS) && BULK_CHUNK_ROWS >= 100);
  assert.match(JMDICT_IMPORTER_VERSION, /^[a-z0-9.-]+$/);
});

function syntheticWord(id, formCount, senseCount) {
  const kana = [];
  for (let index = 0; index < formCount; index += 1) {
    kana.push({ text: `よみ${id}-${index}`, common: false, tags: [], appliesToKanji: ['*'] });
  }
  const sense = [];
  for (let index = 0; index < senseCount; index += 1) {
    sense.push({
      partOfSpeech: ['n'], appliesToKanji: ['*'], appliesToKana: ['*'],
      related: [], antonym: [], field: [], dialect: [], misc: [], info: [], loanwordSource: [],
      gloss: [{ text: `sense ${id}-${index} "quoted" \\ backslash`, lang: 'eng' }]
    });
  }
  return { id: String(id), kanji: [], kana, sense };
}

function countingClient() {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    }
  };
}

test('bulk batch issues a constant number of statements regardless of child counts', async () => {
  // Bug guarded: the old per-row importer (1 entry INSERT + 2 DELETEs + one
  // INSERT per form/sense). For 10 entries x 6 forms x 4 senses the old shape
  // needed 10*3+60+40 = 130 round trips; the bulk shape needs exactly 5.
  // This test fails against the old implementation (130 !== 5).
  const records = [];
  for (let id = 2000001; id <= 2000010; id += 1) {
    records.push(normalizeJmdictWord(syntheticWord(id, 6, 4)));
  }
  const client = countingClient();
  const stats = await insertNormalizedBatch(client, 424242, records);
  assert.equal(client.calls.length, 5);
  assert.deepEqual(stats, { entries: 10, forms: 60, senses: 40, statements: 5 });
  const [entryCall, deleteForms, insertForms, deleteSenses, insertSenses] = client.calls;
  assert.match(entryCall.text, /jsonb_to_recordset/);
  assert.match(entryCall.text, /ON CONFLICT \(source_id, ent_seq\) DO UPDATE/);
  assert.match(deleteForms.text, /DELETE FROM jmdict_forms WHERE source_id = \$1 AND entry_id = ANY\(\$2::bigint\[\]\)/);
  assert.deepEqual(deleteForms.params[1].length, 10);
  assert.match(insertForms.text, /jsonb_to_recordset/);
  assert.equal(JSON.parse(insertForms.params[1]).length, 60);
  assert.match(deleteSenses.text, /DELETE FROM jmdict_senses WHERE source_id = \$1 AND entry_id = ANY\(\$2::bigint\[\]\)/);
  assert.match(insertSenses.text, /jsonb_to_recordset/);
  assert.equal(JSON.parse(insertSenses.params[1]).length, 40);
  // Hostile payload text (quotes, backslashes) survives the JSON envelope.
  assert.ok(insertSenses.params[1].includes('sense 2000001-0'));
});

test('bulk child payloads chunk deterministically past the chunk bound', async () => {
  // Bug guarded: one giant statement for a pathological batch (parameter /
  // query-size pathology on remote refresh). 2001 forms must split into two
  // bounded INSERTs; senses still fit in one.
  const records = [normalizeJmdictWord(syntheticWord(2000100, BULK_CHUNK_ROWS + 1, 1))];
  const client = countingClient();
  const stats = await insertNormalizedBatch(client, 424242, records);
  assert.equal(stats.forms, BULK_CHUNK_ROWS + 1);
  assert.equal(client.calls.length, 6);
  const formInserts = client.calls.filter((call) => /INSERT INTO jmdict_forms/.test(call.text));
  assert.equal(formInserts.length, 2);
  assert.equal(JSON.parse(formInserts[0].params[1]).length, BULK_CHUNK_ROWS);
  assert.equal(JSON.parse(formInserts[1].params[1]).length, 1);
});

test('reading appliesToKanji maps re_nokanji, unrestricted, and explicit restriction', () => {
  // Bug guarded: the false "re_nokanji is dropped" claim — jmdict-simplified
  // encodes XML <re_nokanji/> as appliesToKanji: [], ["*"] as unrestricted,
  // and explicit lists as re_restr targets. All three must map exactly.
  const base = JSON.parse(JSON.stringify(word('1000001')));
  const none = JSON.parse(JSON.stringify(base));
  none.kana[0].appliesToKanji = [];
  const noneForm = normalizeJmdictWord(none).forms.find((form) => form.kind === 'reb');
  assert.equal(noneForm.nokanji, true);
  assert.deepEqual(noneForm.restr, []);
  const all = JSON.parse(JSON.stringify(base));
  all.kana[0].appliesToKanji = ['*'];
  const allForm = normalizeJmdictWord(all).forms.find((form) => form.kind === 'reb');
  assert.equal(allForm.nokanji, false);
  assert.deepEqual(allForm.restr, []);
  const explicit = JSON.parse(JSON.stringify(base));
  explicit.kana[0].appliesToKanji = ['学校'];
  const explicitForm = normalizeJmdictWord(explicit).forms.find((form) => form.kind === 'reb');
  assert.equal(explicitForm.nokanji, false);
  assert.deepEqual(explicitForm.restr, ['学校']);
});
