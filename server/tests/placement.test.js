const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';
const THIRD_USER = '00000000-0000-4000-8000-000000000003';
const FOURTH_USER = '11111111-1111-4111-8111-111111111111';
const FIFTH_USER = '22222222-2222-4222-8222-222222222222';

// NippoTrack v5.1 — Quick Placement quiz (40-item bank v1, deterministic
// per-user stratified 10-question selection, N5..N3) + self-reported starting
// level. Same boot/auth-bypass/DB stub conventions as
// firstExperience.test.js: the pool is stubbed in-memory with transaction
// snapshot semantics. Ownership always derives from the auth bypass user
// (req.user.id); body/query user ids are never read.

const placementService = require('../src/services/placement');
const {
  assertPlacementCountsInRange,
  gradePlacement,
  normalizePlacementAnswers,
  scorePlacement,
  selectPlacementQuestions
} = placementService;
const { PLACEMENT_BANK } = placementService;
const { ValidationError } = require('../src/errors/http');

const BANK_MAP = new Map(PLACEMENT_BANK.map((question) => [question.id, question]));

function syntheticUser(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function answerFor(questionId, correct) {
  const question = BANK_MAP.get(questionId);
  if (!question) throw new Error(`unknown test question ${questionId}`);
  if (correct) return { questionId, optionId: question.correctOption };
  const wrong = question.options.find((option) => option.id !== question.correctOption);
  return { questionId, optionId: wrong.id };
}

function answersFor(ids, wrongIds = []) {
  const wrong = new Set(wrongIds);
  return ids.map((id) => answerFor(id, !wrong.has(id)));
}

function idsInBand(ids, band) {
  return ids.filter((id) => BANK_MAP.get(id).band === band);
}

// TEST_USER selection (deterministic; pinned exactly below). All quiz API
// fixtures answer this user's assigned set.
const QIDS = selectPlacementQuestions(TEST_USER);
const ALL_CORRECT = answersFor(QIDS, []);
const ALL_WRONG = answersFor(QIDS, QIDS);

function correctExcept(...wrongIds) {
  return answersFor(QIDS, wrongIds);
}

const COMPLETED_AT = '2026-09-09T00:00:00.000Z';

// Pinned regression vectors (bank v1, version 1): these exact selections must
// never change unless PLACEMENT_BANK_VERSION is bumped.
const PINNED_SELECTIONS = {
  [TEST_USER]: ['n5_vocab_02', 'n5_reading_02', 'n5_comp_02', 'n4_grammar_01', 'n4_vocab_01', 'n4_reading_04', 'n3_comp_03', 'n3_vocab_03', 'n3_reading_02', 'n3_grammar_04'],
  [OTHER_USER]: ['n5_reading_02', 'n5_vocab_04', 'n5_comp_02', 'n4_comp_01', 'n4_reading_04', 'n4_vocab_02', 'n3_reading_03', 'n3_comp_04', 'n3_grammar_04', 'n3_vocab_03'],
  [THIRD_USER]: ['n5_vocab_03', 'n5_grammar_02', 'n5_reading_02', 'n4_reading_03', 'n4_vocab_01', 'n4_comp_01', 'n3_reading_02', 'n3_vocab_01', 'n3_grammar_03', 'n3_comp_04'],
  [FOURTH_USER]: ['n5_vocab_02', 'n5_reading_03', 'n5_grammar_02', 'n4_reading_03', 'n4_vocab_01', 'n4_comp_01', 'n3_comp_02', 'n3_reading_04', 'n3_grammar_04', 'n3_vocab_04'],
  [FIFTH_USER]: ['n5_vocab_03', 'n5_reading_04', 'n5_comp_01', 'n4_reading_01', 'n4_vocab_02', 'n4_comp_01', 'n3_comp_01', 'n3_grammar_01', 'n3_reading_02', 'n3_vocab_04']
};

// Byte-frozen renames: old q01-q06 prompts/options (copied verbatim).
const FROZEN_CONTENT = {
  n5_reading_01: {
    prompt: { text: '「水をのみます。」水のよみ方は？', reading: 'みずをのみます', translation: 'How do you read 水? (Drink water.)' },
    options: [
      { id: 'a', text: 'みず', reading: 'みず', gloss: 'water' },
      { id: 'b', text: 'すい', reading: 'すい', gloss: 'On-reading' },
      { id: 'c', text: 'みす', reading: 'みす', gloss: 'non-word' },
      { id: 'd', text: 'むず', reading: 'むず', gloss: 'non-word' }
    ]
  },
  n5_grammar_01: {
    prompt: { text: '先生は教室__います。', reading: 'せんせいはきょうしつ__います', translation: 'The teacher is in the classroom.' },
    options: [
      { id: 'a', text: 'に', reading: 'に', gloss: 'location' },
      { id: 'b', text: 'を', reading: 'を', gloss: 'object' },
      { id: 'c', text: 'が', reading: 'が', gloss: 'subject' },
      { id: 'd', text: 'へ', reading: 'へ', gloss: 'direction' }
    ]
  },
  n4_vocab_01: {
    prompt: { text: 'この駅はとても便利です。', reading: 'このえきはとてもべんりです', translation: 'This station is very convenient.' },
    options: [
      { id: 'a', text: 'つかうのにいい', reading: 'つかうのにいい', gloss: 'convenient' },
      { id: 'b', text: 'ひとがおおい', reading: 'ひとがおおい', gloss: 'crowded' },
      { id: 'c', text: 'ゆうめいな', reading: 'ゆうめいな', gloss: 'famous' },
      { id: 'd', text: 'しずかな', reading: 'しずかな', gloss: 'quiet' }
    ]
  },
  n4_reading_01: {
    prompt: { text: '日曜日は休みです。', reading: 'にちようびはやすみです', translation: 'Sunday is a day off.' },
    options: [
      { id: 'a', text: 'やすみ', reading: 'やすみ', gloss: 'day-off' },
      { id: 'b', text: 'やすむ', reading: 'やすむ', gloss: 'to-rest' },
      { id: 'c', text: 'きゅうみ', reading: 'きゅうみ', gloss: 'invalid' },
      { id: 'd', text: 'おやすみ', reading: 'おやすみ', gloss: 'honorific-form' }
    ]
  },
  n3_grammar_01: {
    prompt: { text: '「いそがしい」の「たら」形は？', reading: '「いそがしい」の「たら」形は？', translation: 'What is the tara-form of いそがしい (busy)?' },
    options: [
      { id: 'a', text: 'いそがしかったら', reading: 'いそがしかったら', gloss: 'tara-form' },
      { id: 'b', text: 'いそがしければ', reading: 'いそがしければ', gloss: 'ba-form' },
      { id: 'c', text: 'いそがしいたら', reading: 'いそがしいたら', gloss: 'malformed' },
      { id: 'd', text: 'いそがしかったば', reading: 'いそがしかったば', gloss: 'malformed' }
    ]
  },
  n3_comp_01: {
    prompt: { text: 'メモ「ケーキは半分だけ食べてください。」正しい理解は？', reading: 'けーきははんぶんだけたべてください', translation: 'Memo: please eat only half the cake. Which understanding is correct?' },
    options: [
      { id: 'a', text: '半分食べてもいい', reading: 'はんぶんたべてもいい', gloss: 'may-eat-half' },
      { id: 'b', text: '全部食べてもいい', reading: 'ぜんぶたべてもいい', gloss: 'may-eat-all' },
      { id: 'c', text: '食べてはいけない', reading: 'たべてはいけない', gloss: 'must-not' },
      { id: 'd', text: '何も食べないほうがいい', reading: 'なにもたべないほうがいい', gloss: 'better-not' }
    ]
  }
};

function freshState(overrides = {}) {
  return { targets: {}, firstExp: {}, ...overrides };
}

function seedRow(overrides = {}) {
  return {
    onboarding_completed_at: null,
    study_sources: [],
    placement_status: 'not_started',
    placement_estimate: null,
    placement_source: null,
    placement_completed_at: null,
    placement_total_correct: null,
    placement_correct_n5: null,
    placement_correct_n4: null,
    placement_correct_n3: null,
    placement_correct_n2: null,
    placement_correct_n1: null,
    ...overrides
  };
}

function installPlacementStub(state) {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const seen = [];

  async function handleExecute(sql, params = []) {
    seen.push({ sql, params });
    if (/user_jlpt_target/i.test(sql)) {
      const userId = params[0];
      if (/^\s*SELECT/i.test(sql)) {
        const level = state.targets[userId];
        return level ? [[{ target_level: level }]] : [[]];
      }
      if (/^\s*INSERT/i.test(sql)) {
        state.targets[userId] = params[1];
        return [[{ target_level: params[1] }]];
      }
      if (/^\s*DELETE/i.test(sql)) {
        delete state.targets[userId];
        return [[]];
      }
    }
    if (/user_first_experience/i.test(sql)) {
      if (/^\s*SELECT/i.test(sql)) {
        const row = state.firstExp[params[0]];
        return row ? [[{ ...row, study_sources: [...row.study_sources] }]] : [[]];
      }
      if (/ON CONFLICT\s*\(user_id\)\s*DO NOTHING/i.test(sql)) {
        // Submit/self-report/skip ensure-then-lock step: creates an empty row only when absent.
        const userId = params[0];
        if (!state.firstExp[userId]) state.firstExp[userId] = seedRow();
        return [{ affectedRows: 0 }];
      }
      if (/^\s*UPDATE/i.test(sql)) {
        // Quiz submit write: params [estimate, total, n5, n4, n3, userId],
        // SQL carries placement_source='quiz' + vestigial n2/n1 = 0.
        // Self-report write: params [level, userId], SQL carries
        // placement_source='self_reported' + explicit NULL counts.
        // Skip write: params [userId]; completed rows are never downgraded
        // (mirrors the service guard; the service never issues a skip UPDATE
        // for completed rows, and the onboarding CASE guard below agrees).
        const userId = params[params.length - 1];
        const existing = state.firstExp[userId] || seedRow();
        if (/'completed'/i.test(sql) && /'quiz'/i.test(sql)) {
          state.firstExp[userId] = {
            ...existing,
            study_sources: [...existing.study_sources],
            placement_status: 'completed',
            placement_estimate: params[0],
            placement_source: 'quiz',
            placement_total_correct: params[1],
            placement_correct_n5: params[2],
            placement_correct_n4: params[3],
            placement_correct_n3: params[4],
            placement_correct_n2: 0,
            placement_correct_n1: 0,
            placement_completed_at: COMPLETED_AT
          };
        } else if (/'completed'/i.test(sql) && /self_reported/i.test(sql)) {
          state.firstExp[userId] = {
            ...existing,
            study_sources: [...existing.study_sources],
            placement_status: 'completed',
            placement_estimate: params[0],
            placement_source: 'self_reported',
            placement_total_correct: null,
            placement_correct_n5: null,
            placement_correct_n4: null,
            placement_correct_n3: null,
            placement_correct_n2: null,
            placement_correct_n1: null,
            placement_completed_at: COMPLETED_AT
          };
        } else if (/'skipped'/i.test(sql) && existing.placement_status !== 'completed') {
          state.firstExp[userId] = {
            ...existing,
            study_sources: [...existing.study_sources],
            placement_status: 'skipped'
          };
        }
        return [{ affectedRows: 1 }];
      }
      if (/^\s*INSERT/i.test(sql)) {
        // A.2 onboarding upserts: params [userId, studySources]. The CASE
        // guard preserves a completed placement (mirrors the real SQL);
        // source/estimate/counts survive via the spread (PUT never sets source).
        const userId = params[0];
        const existing = state.firstExp[userId] || seedRow();
        state.firstExp[userId] = {
          ...existing,
          onboarding_completed_at: '2026-09-09T00:00:00.000Z',
          study_sources: [...params[1]],
          placement_status: /'skipped'/i.test(sql) && existing.placement_status !== 'completed'
            ? 'skipped'
            : existing.placement_status
        };
        return [{ affectedRows: 1 }];
      }
    }
    return [[]];
  }

  pool.execute = handleExecute;
  pool.getConnection = async () => {
    let snapshot = null;
    return {
      execute: handleExecute,
      query: handleExecute,
      beginTransaction: async () => {
        snapshot = JSON.parse(JSON.stringify({ targets: state.targets, firstExp: state.firstExp }));
      },
      commit: async () => { snapshot = null; },
      rollback: async () => {
        if (snapshot) {
          state.targets = snapshot.targets;
          state.firstExp = snapshot.firstExp;
          snapshot = null;
        }
      },
      release: () => {}
    };
  };

  return { seen, restore() { pool.execute = originalExecute; pool.getConnection = originalGetConnection; } };
}

test.after(async () => {
  try {
    await require('../src/config/db').end();
  } catch {
    // Pool may already be ended; ignore.
  }
});

async function withServer(fn) {
  const app = require('../src/app');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(base, path, { method = 'GET', body, user = TEST_USER } = {}) {
  const stubUser = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = user;
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON error shape */ }
    return { status: response.status, body: payload };
  } finally {
    if (stubUser === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = stubUser;
  }
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      keys.push(key);
      collectKeys(value[key], keys);
    }
  }
  return keys;
}

// ---- Bank v1 shape (40 items: N5x12 / N4x12 / N3x16, N3-max) ----

test('Bank: 40 unique ids, distribution N5x12/N4x12/N3x16, no N2/N1 items', () => {
  const { PLACEMENT_BANK, PLACEMENT_BANDS, PLACEMENT_BANK_IDS, PLACEMENT_BANK_VERSION, PLACEMENT_SELECTION_SIZE } = placementService;
  assert.equal(PLACEMENT_BANK_VERSION, 1);
  assert.equal(PLACEMENT_SELECTION_SIZE, 10);
  assert.deepEqual(PLACEMENT_BANDS, ['N5', 'N4', 'N3']);
  assert.equal(PLACEMENT_BANK.length, 40);
  assert.equal(new Set(PLACEMENT_BANK.map((question) => question.id)).size, 40);
  assert.deepEqual([...PLACEMENT_BANK_IDS].sort(), PLACEMENT_BANK.map((question) => question.id).sort());
  const count = (band) => PLACEMENT_BANK.filter((question) => question.band === band).length;
  assert.equal(count('N5'), 12);
  assert.equal(count('N4'), 12);
  assert.equal(count('N3'), 16);
  assert.ok(!PLACEMENT_BANK.some((question) => question.band === 'N2' || question.band === 'N1'));
  const typeCount = (band, type) => PLACEMENT_BANK.filter((question) => question.band === band && question.type === type).length;
  assert.deepEqual([typeCount('N5', 'vocab'), typeCount('N5', 'reading'), typeCount('N5', 'grammar'), typeCount('N5', 'comp')], [4, 4, 2, 2]);
  assert.deepEqual([typeCount('N4', 'vocab'), typeCount('N4', 'reading'), typeCount('N4', 'grammar'), typeCount('N4', 'comp')], [4, 4, 2, 2]);
  assert.deepEqual([typeCount('N3', 'vocab'), typeCount('N3', 'reading'), typeCount('N3', 'grammar'), typeCount('N3', 'comp')], [4, 4, 4, 4]);
});

test('Bank: every item carries complete metadata and a resolvable correct option', () => {
  for (const question of PLACEMENT_BANK) {
    assert.match(question.id, /^n[543]_(vocab|reading|grammar|comp)_\d{2}$/, `malformed id ${question.id}`);
    assert.ok(['N5', 'N4', 'N3'].includes(question.band));
    assert.ok(['vocab', 'reading', 'grammar', 'comp'].includes(question.type));
    for (const field of ['text', 'reading', 'translation']) {
      assert.equal(typeof question.prompt[field], 'string', `${question.id}.prompt.${field}`);
      assert.ok(question.prompt[field].length > 0, `${question.id}.prompt.${field} must be non-empty`);
    }
    assert.equal(question.options.length, 4, `${question.id} must have 4 options`);
    assert.deepEqual(question.options.map((option) => option.id), ['a', 'b', 'c', 'd']);
    for (const option of question.options) {
      for (const field of ['text', 'reading', 'gloss']) {
        assert.equal(typeof option[field], 'string', `${question.id}.${option.id}.${field}`);
        assert.ok(option[field].length > 0, `${question.id}.${option.id}.${field} must be non-empty`);
      }
    }
    assert.ok(question.options.some((option) => option.id === question.correctOption), `${question.id} correctOption must exist`);
  }
});

test('Bank: q01-q06 content frozen under the stable ids (prompts/options verbatim)', () => {
  for (const [id, frozen] of Object.entries(FROZEN_CONTENT)) {
    const question = BANK_MAP.get(id);
    assert.ok(question, `expected bank item ${id}`);
    assert.deepEqual(question.prompt, frozen.prompt, `${id} prompt must be byte-identical`);
    assert.deepEqual(question.options, frozen.options, `${id} options must be byte-identical`);
    assert.equal(question.correctOption, 'a', `${id} correct option unchanged`);
  }
});

test('Bank: q07-q10 renames keep their validated prompts (おもい/ておく/ばほど/parking)', () => {
  assert.match(BANK_MAP.get('n5_vocab_01').prompt.text, /おもい/);
  assert.match(BANK_MAP.get('n4_grammar_01').prompt.text, /つけて __/);
  assert.match(BANK_MAP.get('n3_grammar_02').prompt.text, /練習 __/);
  assert.match(BANK_MAP.get('n3_comp_02').prompt.text, /駐車場/);
});

// ---- Selector: determinism, stability, diversity, structure ----

test('Selector: pinned regression vectors (same input -> identical output forever)', () => {
  for (const [userId, expected] of Object.entries(PINNED_SELECTIONS)) {
    assert.deepEqual(selectPlacementQuestions(userId), expected, `selection for ${userId} must never drift`);
  }
});

test('Selector: same user is identical across 500 calls', () => {
  const first = selectPlacementQuestions(TEST_USER);
  for (let call = 0; call < 500; call += 1) {
    assert.deepEqual(selectPlacementQuestions(TEST_USER), first, `call ${call} diverged`);
  }
});

test('Selector: stable across module reload (pure function of userId + version)', () => {
  const before = selectPlacementQuestions(THIRD_USER);
  const resolved = require.resolve('../src/services/placement');
  delete require.cache[resolved];
  try {
    const reloaded = require('../src/services/placement');
    assert.deepEqual(reloaded.selectPlacementQuestions(THIRD_USER), before);
    assert.equal(reloaded.PLACEMENT_BANK_VERSION, 1);
  } finally {
    delete require.cache[resolved];
    require('../src/services/placement');
  }
});

test('Selector: module uses no runtime entropy (hash-seeded only)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'placement.js'), 'utf8');
  for (const pattern of [/Math\.random/, /Date\.now\(\)/, /randomBytes/, /randomInt/, /randomUUID/, /hrtime/, /performance\.now/, /getRandomValues/, /new Date\(/]) {
    assert.ok(!pattern.test(source), `placement service must not use entropy source ${pattern}`);
  }
  assert.ok(/createHash/.test(source) && /sha256/.test(source), 'selector must be hash-seeded');
});

test('Selector: 100 synthetic users yield strong diversity (>=90 unique sets)', () => {
  const sets = new Set();
  for (let index = 0; index < 100; index += 1) {
    sets.add(JSON.stringify(selectPlacementQuestions(syntheticUser(index))));
  }
  assert.ok(sets.size >= 90, `expected >=90 unique sets, got ${sets.size}`);
});

test('Selector: structure 3/3/4 with type slots and no duplicates across 300 users', () => {
  for (let index = 0; index < 300; index += 1) {
    const userId = syntheticUser(index + 1000);
    const selected = selectPlacementQuestions(userId);
    assert.equal(selected.length, 10, `${userId}: must select 10`);
    assert.equal(new Set(selected).size, 10, `${userId}: no duplicates`);
    assert.ok(selected.every((id) => BANK_MAP.has(id)), `${userId}: all ids in bank`);
    const bands = selected.map((id) => BANK_MAP.get(id).band);
    assert.deepEqual(bands.slice(0, 3), ['N5', 'N5', 'N5'], `${userId}: positions 0-2 are N5`);
    assert.deepEqual(bands.slice(3, 6), ['N4', 'N4', 'N4'], `${userId}: positions 3-5 are N4`);
    assert.deepEqual(bands.slice(6, 10), ['N3', 'N3', 'N3', 'N3'], `${userId}: positions 6-9 are N3`);
    const typesIn = (ids) => ids.map((id) => BANK_MAP.get(id).type).sort();
    const n5Types = typesIn(selected.slice(0, 3));
    assert.ok(n5Types.includes('vocab') && n5Types.includes('reading'), `${userId}: N5 has vocab + reading`);
    assert.equal(n5Types.filter((type) => type === 'grammar' || type === 'comp').length, 1, `${userId}: N5 flex is grammar|comp`);
    const n4Types = typesIn(selected.slice(3, 6));
    assert.ok(n4Types.includes('vocab') && n4Types.includes('reading'), `${userId}: N4 has vocab + reading`);
    assert.equal(n4Types.filter((type) => type === 'grammar' || type === 'comp').length, 1, `${userId}: N4 flex is grammar|comp`);
    assert.deepEqual(typesIn(selected.slice(6, 10)), ['comp', 'grammar', 'reading', 'vocab'], `${userId}: N3 has vocab+reading+grammar+comp`);
  }
});

test('Selector: independent reimplementation of hash->PRNG->slots->order matches', () => {
  const crypto = require('node:crypto');
  function referenceSelect(userId) {
    const seed = crypto.createHash('sha256').update(`${userId}:1`, 'utf8').digest().readUInt32LE(0);
    let state = seed >>> 0;
    const next = () => {
      state |= 0;
      state = (state + 0x6D2B79F5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const slots = [
      ['N5', ['vocab']], ['N5', ['reading']], ['N5', ['grammar', 'comp']],
      ['N4', ['vocab']], ['N4', ['reading']], ['N4', ['grammar', 'comp']],
      ['N3', ['vocab']], ['N3', ['reading']], ['N3', ['grammar']], ['N3', ['comp']]
    ];
    const picked = new Set();
    const bands = { N5: [], N4: [], N3: [] };
    for (const [band, types] of slots) {
      const pool = PLACEMENT_BANK
        .filter((question) => question.band === band && types.includes(question.type))
        .map((question) => question.id)
        .sort()
        .filter((id) => !picked.has(id));
      const id = pool[Math.floor(next() * pool.length)];
      picked.add(id);
      bands[band].push(id);
    }
    for (const band of ['N5', 'N4', 'N3']) {
      const items = bands[band];
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }
    return [...bands.N5, ...bands.N4, ...bands.N3];
  }
  for (let index = 0; index < 20; index += 1) {
    const userId = syntheticUser(index + 5000);
    assert.deepEqual(selectPlacementQuestions(userId), referenceSelect(userId), `algorithm pin for ${userId}`);
  }
});

test('Selector: empty/non-string user scope is rejected', () => {
  for (const bad of ['', null, undefined, 42, {}, []]) {
    assert.throws(() => selectPlacementQuestions(bad), ValidationError);
    assert.throws(() => placementService.getPlacementQuestions(bad), ValidationError);
  }
  assert.throws(() => normalizePlacementAnswers({ answers: [] }, []), ValidationError);
  assert.throws(() => normalizePlacementAnswers({ answers: [] }, null), ValidationError);
});

// ---- Scoring unit tests (band-aware foundation gates on 3/3/4) ----

test('Scoring: all wrong answers yields N5', () => {
  assert.equal(scorePlacement(ALL_WRONG), 'N5');
});

test('Scoring: perfect 10/10 yields N3 (the maximum, never N2/N1)', () => {
  assert.equal(scorePlacement(ALL_CORRECT), 'N3');
});

test('Structural N3-max: every answer pattern scores in {N5,N4,N3} (exhaustive 2^10)', () => {
  const allowed = new Set(['N5', 'N4', 'N3']);
  for (let mask = 0; mask < 1024; mask += 1) {
    const answers = QIDS.map((questionId, index) => answerFor(questionId, Boolean((mask >> index) & 1)));
    const estimate = scorePlacement(answers);
    assert.ok(allowed.has(estimate), `pattern ${mask} returned ${estimate}`);
  }
});

test('Scoring: N4 threshold (4 of 6 foundation with an N4 question) qualifies', () => {
  // Correct all 3 N5 + first N4; wrong the other 2 N4 + all 4 N3.
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  assert.equal(scorePlacement(correctExcept(...n4.slice(1), ...n3)), 'N4');
});

test('Scoring: N4 boundary -1 (only 3 of 6 foundation) stays N5', () => {
  const n5 = idsInBand(QIDS, 'N5');
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  // Correct 2 N5 + 1 N4 only.
  assert.equal(scorePlacement(correctExcept(n5[2], ...n4.slice(1), ...n3)), 'N5');
});

test('Scoring: pure-N5 (3/3 N5, 0 N4) never promotes to N4', () => {
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  assert.equal(scorePlacement(correctExcept(...n4, ...n3)), 'N5');
});

test('Scoring: N3 threshold (7/10 with 2 N3) qualifies', () => {
  // Wrong 1 N4 + 2 N3: N5 3/3, N4 2/3, N3 2/4, total 7.
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  assert.equal(scorePlacement(correctExcept(n4[0], n3[0], n3[1])), 'N3');
});

test('Scoring: N3 needs strong cumulative (6/10 with 2 N3 falls back to N4)', () => {
  // Wrong 2 N4 + 2 N3: total 6, N3 = 2, foundation 4 + 1 N4.
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  assert.equal(scorePlacement(correctExcept(n4[0], n4[1], n3[0], n3[1])), 'N4');
});

test('Scoring: N3 needs >=2 N3 (7/10 with only 1 N3 falls back to N4)', () => {
  // Wrong 3 N3: total 7, only 1 correct among N3.
  const n3 = idsInBand(QIDS, 'N3');
  assert.equal(scorePlacement(correctExcept(n3[0], n3[1], n3[2])), 'N4');
});

test('Scoring: N3 answers with weak overall stay N5 (3/10 incl. 3 N3 is NOT N3)', () => {
  // Correct only 3 N3: total 3 despite 3/4 N3.
  const n5 = idsInBand(QIDS, 'N5');
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  assert.equal(scorePlacement(answersFor(QIDS, [...n5, ...n4, n3[3]])), 'N5');
});

test('Scoring: band-aware across users (constructed N4/N3 on another selection)', () => {
  const ids = selectPlacementQuestions(OTHER_USER);
  const n5 = idsInBand(ids, 'N5');
  const n4 = idsInBand(ids, 'N4');
  const n3 = idsInBand(ids, 'N3');
  assert.equal(scorePlacement(answersFor(ids, [])), 'N3');
  assert.equal(scorePlacement(answersFor(ids, ids)), 'N5');
  assert.equal(scorePlacement(answersFor(ids, [...n4.slice(1), ...n3])), 'N4');
  assert.equal(scorePlacement(answersFor(ids, [n4[0], n3[0], n3[1]])), 'N3');
});

test('Scoring: monotonic spot check (cumulative correct answers never regress)', () => {
  const order = ['N5', 'N4', 'N3'];
  const wrong = new Set(QIDS);
  let previous = 0;
  for (const id of QIDS) {
    wrong.delete(id);
    const estimate = scorePlacement(answersFor(QIDS, [...wrong]));
    const rank = order.indexOf(estimate);
    assert.ok(rank >= 0, `unknown estimate ${estimate}`);
    assert.ok(rank >= previous, `estimate regressed after correcting ${id}`);
    previous = rank;
  }
  assert.equal(scorePlacement(ALL_CORRECT), 'N3');
});

// ---- Foundation-gate scoring matrix (frozen rules) + abstention contract ----

// N4 iff foundation>=4 AND N5>=2 AND N4>=1; N3 iff total>=7 AND N5>=2 AND
// N4>=2 AND N3>=2; else N5. Highest qualifying wins. Math verification:
// N3 implies N4 (min foundation 2+2=4, N4 2>=1), so highest-wins is
// deterministic; no vector can satisfy N3 while failing N4.

function answersByBandCount(n5Correct, n4Correct, n3Correct, abstainIds = []) {
  const abstain = new Set(abstainIds);
  const n5 = idsInBand(QIDS, 'N5');
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  const correct = new Set([
    ...n5.slice(0, n5Correct),
    ...n4.slice(0, n4Correct),
    ...n3.slice(0, n3Correct)
  ]);
  return QIDS.map((id) => {
    if (abstain.has(id)) return { questionId: id, optionId: null };
    return answerFor(id, correct.has(id));
  });
}

const ALL_ABSTAIN = QIDS.map((id) => ({ questionId: id, optionId: null }));

test('Foundation gates: 0/10 yields N5', () => {
  assert.equal(scorePlacement(ALL_WRONG), 'N5');
  assert.deepEqual(gradePlacement(ALL_WRONG), {
    estimate: 'N5',
    totalCorrect: 0,
    byBand: { N5: 0, N4: 0, N3: 0 }
  });
});

test('Foundation gates: all-abstain yields N5 with denominators fixed at 3/3/4 over 10', () => {
  assert.equal(scorePlacement(ALL_ABSTAIN), 'N5');
  assert.deepEqual(gradePlacement(ALL_ABSTAIN), {
    estimate: 'N5',
    totalCorrect: 0,
    byBand: { N5: 0, N4: 0, N3: 0 }
  });
  // Denominator proof: the selection still holds 3 N5 + 3 N4 + 4 N3 = 10
  // regardless of abstentions (abstention is an answer value, never a
  // selection change), and the graded counts fit the fixed maxima.
  const bands = QIDS.map((id) => BANK_MAP.get(id).band);
  assert.equal(bands.filter((band) => band === 'N5').length, 3);
  assert.equal(bands.filter((band) => band === 'N4').length, 3);
  assert.equal(bands.filter((band) => band === 'N3').length, 4);
  assert.doesNotThrow(() => assertPlacementCountsInRange(0, { N5: 0, N4: 0, N3: 0 }));
});

test('Foundation gates: N5 2/3 + N4 2/3 + N3 0/4 (4/10) yields N4', () => {
  const answers = answersByBandCount(2, 2, 0);
  assert.equal(scorePlacement(answers), 'N4');
  assert.deepEqual(gradePlacement(answers), {
    estimate: 'N4',
    totalCorrect: 4,
    byBand: { N5: 2, N4: 2, N3: 0 }
  });
});

test('Foundation gates: N5 1/3 + N4 3/3 + N3 0/4 (4/10) stays N5 (NOT N4: N5 floor)', () => {
  const answers = answersByBandCount(1, 3, 0);
  assert.equal(scorePlacement(answers), 'N5');
  assert.notEqual(scorePlacement(answers), 'N4');
  assert.deepEqual(gradePlacement(answers).byBand, { N5: 1, N4: 3, N3: 0 });
});

test('Foundation gates: N5 2/3 + N4 2/3 + N3 3/4 (7/10) yields N3', () => {
  const answers = answersByBandCount(2, 2, 3);
  assert.equal(scorePlacement(answers), 'N3');
  assert.deepEqual(gradePlacement(answers), {
    estimate: 'N3',
    totalCorrect: 7,
    byBand: { N5: 2, N4: 2, N3: 3 }
  });
});

test('Foundation gates: N5 1/3 + N4 3/3 + N3 4/4 (8/10) is NOT N3 (weak foundation)', () => {
  const answers = answersByBandCount(1, 3, 4);
  assert.notEqual(scorePlacement(answers), 'N3');
  // N5 floor also blocks N4 (foundation 4 but N5 1 < 2), so this lands on N5.
  assert.equal(scorePlacement(answers), 'N5');
  assert.deepEqual(gradePlacement(answers).byBand, { N5: 1, N4: 3, N3: 4 });
});

test('Foundation gates: N5 3/3 + N4 3/3 + N3 1/4 (7/10) is NOT N3 (falls back to N4)', () => {
  const answers = answersByBandCount(3, 3, 1);
  assert.notEqual(scorePlacement(answers), 'N3');
  assert.equal(scorePlacement(answers), 'N4');
  assert.deepEqual(gradePlacement(answers).byBand, { N5: 3, N4: 3, N3: 1 });
});

test('Foundation gates: 10/10 yields N3', () => {
  assert.equal(scorePlacement(ALL_CORRECT), 'N3');
});

test('Foundation gates: never N2/N1 (exhaustive 2^10 over the caller selection)', () => {
  const allowed = new Set(['N5', 'N4', 'N3']);
  for (let mask = 0; mask < 1024; mask += 1) {
    const answers = QIDS.map((questionId, index) => answerFor(questionId, Boolean((mask >> index) & 1)));
    assert.ok(allowed.has(scorePlacement(answers)), `pattern ${mask} escaped the N3-max bound`);
  }
  // Structural: no N2/N1 literals on any estimate return path.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'placement.js'), 'utf8');
  assert.ok(!/return 'N2'/.test(source) && !/return 'N1'/.test(source), 'service must hold no N2/N1 return path');
});

test('Abstention contract (unit): null accepted with zero credit; bad ids rejected', () => {
  const expected = selectPlacementQuestions(TEST_USER);
  // null accepted, scores 0, denominators unchanged.
  const mixed = QIDS.map((id, index) => (
    index < 2 ? answerFor(id, true) : { questionId: id, optionId: null }
  ));
  assert.deepEqual(normalizePlacementAnswers({ answers: mixed }, expected), mixed);
  assert.deepEqual(gradePlacement(mixed), {
    estimate: 'N5',
    totalCorrect: 2,
    byBand: { N5: 2, N4: 0, N3: 0 }
  });
  const onlyAbstainN5 = QIDS.map((id) => (
    BANK_MAP.get(id).band === 'N5' ? { questionId: id, optionId: null } : answerFor(id, true)
  ));
  assert.deepEqual(gradePlacement(onlyAbstainN5).byBand, { N5: 0, N4: 3, N3: 4 });
  // Rejected: unknown strings, empty string, wrong types, missing optionId.
  for (const bad of ['unknown', '', 'e', 'A', 1, true, {}, [], undefined]) {
    const answers = [...ALL_CORRECT.slice(0, 9), { questionId: QIDS[9], optionId: bad }];
    assert.throws(() => normalizePlacementAnswers({ answers }, expected), ValidationError, `optionId ${JSON.stringify(bad)} must be rejected`);
  }
  // Rejected: option id not offered by its own question (per-question
  // membership). The v1 bank offers only a/b/c/d per question, so any
  // outside-canonical id exercises this path; null is the sole exception.
  const notOffered = [...ALL_CORRECT.slice(0, 9), { questionId: QIDS[9], optionId: 'z' }];
  assert.throws(() => normalizePlacementAnswers({ answers: notOffered }, expected), ValidationError);
  // Rejected: outside-set id, duplicate, short (9) and long (11) arrays.
  const selectedSet = new Set(QIDS);
  const outsider = PLACEMENT_BANK.find((question) => !selectedSet.has(question.id));
  assert.ok(outsider, 'bank must hold an unselected item');
  const outside = [{ questionId: outsider.id, optionId: outsider.correctOption }, ...ALL_CORRECT.slice(1)];
  assert.throws(() => normalizePlacementAnswers({ answers: outside }, expected), ValidationError);
  const dupe = [...ALL_CORRECT.slice(0, 9), { ...ALL_CORRECT[0] }];
  assert.throws(() => normalizePlacementAnswers({ answers: dupe }, expected), ValidationError);
  assert.throws(() => normalizePlacementAnswers({ answers: ALL_CORRECT.slice(0, 9) }, expected), ValidationError);
  assert.throws(() => normalizePlacementAnswers({ answers: [...ALL_CORRECT, { ...ALL_CORRECT[0] }] }, expected), ValidationError);
});

test('Abstention contract (API): mixed null+valid accepted with correct counts persisted', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      // Correct the first 2 N5, abstain on everything else: total 2, N5.
      const n5 = idsInBand(QIDS, 'N5');
      const answers = QIDS.map((id) => (
        n5.slice(0, 2).includes(id) ? answerFor(id, true) : { questionId: id, optionId: null }
      ));
      const { status, body } = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers }
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { estimate: 'N5', placement: { status: 'completed', estimate: 'N5' } });
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N5',
        source: 'quiz',
        completedAt: COMPLETED_AT,
        result: { totalCorrect: 2, byBand: { N5: 2, N4: 0, N3: 0 } }
      });
    });
  } finally {
    stub.restore();
  }
});

test('Abstention contract (API): all-abstain accepted, persists N5 with zero counts', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_ABSTAIN }
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { estimate: 'N5', placement: { status: 'completed', estimate: 'N5' } });
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N5',
        source: 'quiz',
        completedAt: COMPLETED_AT,
        result: { totalCorrect: 0, byBand: { N5: 0, N4: 0, N3: 0 } }
      });
    });
  } finally {
    stub.restore();
  }
});

test('Abstention contract (API): "unknown" / "" / outside-set / dupe / 9 / 11 rejected with 400', async () => {
  const stub = installPlacementStub(freshState());
  const selectedSet = new Set(QIDS);
  const outsider = PLACEMENT_BANK.find((question) => !selectedSet.has(question.id));
  assert.ok(outsider, 'bank must hold an unselected item');
  try {
    await withServer(async (base) => {
      const cases = [
        ['unknown-string', [...ALL_CORRECT.slice(0, 9), { questionId: QIDS[9], optionId: 'unknown' }]],
        ['empty-string', [...ALL_CORRECT.slice(0, 9), { questionId: QIDS[9], optionId: '' }]],
        ['not-offered-option', [...ALL_CORRECT.slice(0, 9), { questionId: QIDS[9], optionId: 'z' }]],
        ['outside-set', [{ questionId: outsider.id, optionId: outsider.correctOption }, ...ALL_CORRECT.slice(1)]],
        ['duplicate', [...ALL_CORRECT.slice(0, 9), { ...ALL_CORRECT[0] }]],
        ['short-9', ALL_CORRECT.slice(0, 9)],
        ['long-11', [...ALL_CORRECT, { ...ALL_CORRECT[0] }]]
      ];
      for (const [name, answers] of cases) {
        const { status } = await requestJson(base, '/api/first-experience/placement/submit', {
          method: 'POST',
          body: { answers }
        });
        assert.equal(status, 400, `expected 400 for ${name}`);
      }
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
    });
  } finally {
    stub.restore();
  }
});

// ---- Grading unit tests (server-side breakdown; 3/3/4 bands) ----

test('Grading: all correct yields total 10 with 3/3/4 per band', () => {
  assert.deepEqual(gradePlacement(ALL_CORRECT), {
    estimate: 'N3',
    totalCorrect: 10,
    byBand: { N5: 3, N4: 3, N3: 4 }
  });
});

test('Grading: all wrong yields total 0 with 0 per band', () => {
  assert.deepEqual(gradePlacement(ALL_WRONG), {
    estimate: 'N5',
    totalCorrect: 0,
    byBand: { N5: 0, N4: 0, N3: 0 }
  });
});

test('Grading: partial answers attribute misses to the right bands', () => {
  // 1 N5 + 1 N4 + 2 N3 wrong: 6/10, foundation 4 + N4.
  const n5 = idsInBand(QIDS, 'N5');
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  assert.deepEqual(gradePlacement(correctExcept(n5[0], n4[0], n3[0], n3[1])), {
    estimate: 'N4',
    totalCorrect: 6,
    byBand: { N5: 2, N4: 2, N3: 2 }
  });
});

test('Range validation (maxima N5 0..3, N4 0..3, N3 0..4): overflows rejected', () => {
  const max = { N5: 3, N4: 3, N3: 4 };
  assert.throws(() => assertPlacementCountsInRange(11, max), ValidationError);
  assert.throws(() => assertPlacementCountsInRange(-1, max), ValidationError);
  assert.throws(() => assertPlacementCountsInRange(10.5, max), ValidationError);
  assert.throws(() => assertPlacementCountsInRange(10, { ...max, N5: 4 }), ValidationError);
  assert.throws(() => assertPlacementCountsInRange(10, { ...max, N4: 4 }), ValidationError);
  assert.throws(() => assertPlacementCountsInRange(10, { ...max, N3: 5 }), ValidationError);
  assert.throws(() => assertPlacementCountsInRange(10, { ...max, N3: null }), ValidationError);
  assert.throws(() => assertPlacementCountsInRange(10, { ...max, N3: '4' }), ValidationError);
  assert.doesNotThrow(() => assertPlacementCountsInRange(0, { N5: 0, N4: 0, N3: 0 }));
  assert.doesNotThrow(() => assertPlacementCountsInRange(10, max));
});

// ---- Quiz API tests ----

test('API: questions payload is the caller\'s selected set with exact public shape and no answer key', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience/placement/questions');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body), 'questions response must be an array');
      assert.equal(body.length, 10);
      assert.deepEqual(body.map((question) => question.id), PINNED_SELECTIONS[TEST_USER]);
      assert.deepEqual(body.map((question) => question.id), selectPlacementQuestions(TEST_USER));
      for (const question of body) {
        assert.deepEqual(Object.keys(question).sort(), ['id', 'options', 'prompt']);
        assert.deepEqual(Object.keys(question.prompt).sort(), ['reading', 'text', 'translation']);
        assert.equal(question.options.length, 4);
        assert.deepEqual(question.options.map((option) => option.id), ['a', 'b', 'c', 'd']);
        for (const option of question.options) {
          assert.deepEqual(Object.keys(option).sort(), ['gloss', 'id', 'reading', 'text']);
        }
      }
      const keys = collectKeys(body);
      for (const forbidden of ['band', 'correct', 'correctOption', 'answer', 'answerKey', 'estimate', 'bankVersion', 'type']) {
        assert.ok(!keys.includes(forbidden), `response must not contain key "${forbidden}"`);
      }
      const serialized = JSON.stringify(body);
      assert.ok(!/correctOption/i.test(serialized), 'serialized payload must not leak the answer key');
      assert.ok(!/"band"/i.test(serialized), 'serialized payload must not leak bands');
      assert.ok(!/bankVersion/i.test(serialized), 'serialized payload must not leak the bank version');
    });
    assert.ok(!stub.seen.some((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql)), 'questions GET must be read-only');
  } finally {
    stub.restore();
  }
});

test('API: questions derive from req.user.id only (query/body user ids ignored)', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const expected = selectPlacementQuestions(TEST_USER);
      assert.notDeepEqual(selectPlacementQuestions(OTHER_USER), expected, 'fixture users must have different sets');
      const viaQuery = await requestJson(base, `/api/first-experience/placement/questions?userId=${OTHER_USER}&user_id=${OTHER_USER}`);
      assert.equal(viaQuery.status, 200);
      assert.deepEqual(viaQuery.body.map((question) => question.id), expected);
      const other = await requestJson(base, '/api/first-experience/placement/questions', { user: OTHER_USER });
      assert.equal(other.status, 200);
      assert.deepEqual(other.body.map((question) => question.id), selectPlacementQuestions(OTHER_USER));
    });
  } finally {
    stub.restore();
  }
});

test('API: submit happy path persists completed quiz estimate with source quiz', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_CORRECT }
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { estimate: 'N3', placement: { status: 'completed', estimate: 'N3' } });
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, {
        onboarding: { completed: false, studySources: [] },
        placement: {
          status: 'completed',
          estimate: 'N3',
          source: 'quiz',
          completedAt: COMPLETED_AT,
          result: { totalCorrect: 10, byBand: { N5: 3, N4: 3, N3: 4 } }
        },
        targetLevel: null
      });
    });
    const completion = stub.seen.find((entry) => /UPDATE[^;]*'completed'/i.test(entry.sql));
    assert.ok(/'quiz'/i.test(completion.sql), 'quiz submit must persist source quiz');
  } finally {
    stub.restore();
  }
});

test('API: submit accepts the selected set in any order (order-insensitive)', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const shuffled = [...ALL_CORRECT].reverse();
      assert.notDeepEqual(shuffled.map((entry) => entry.questionId), QIDS);
      const { status, body } = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: shuffled }
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { estimate: 'N3', placement: { status: 'completed', estimate: 'N3' } });
    });
  } finally {
    stub.restore();
  }
});

test('API: submit ignores query/body user ids (ownership is req.user.id)', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, `/api/first-experience/placement/submit?userId=${OTHER_USER}`, {
        method: 'POST',
        body: { answers: ALL_CORRECT, user_id: OTHER_USER, userId: OTHER_USER }
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { estimate: 'N3', placement: { status: 'completed', estimate: 'N3' } });
      const other = await requestJson(base, '/api/first-experience', { user: OTHER_USER });
      assert.deepEqual(other.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
    });
  } finally {
    stub.restore();
  }
});

test('API: submit preserves existing onboarding state and sources', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const put = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N4', studySources: ['manga', 'apps'] }
      });
      assert.equal(put.status, 200);
      const submit = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_WRONG }
      });
      assert.equal(submit.status, 200);
      assert.deepEqual(submit.body, { estimate: 'N5', placement: { status: 'completed', estimate: 'N5' } });
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, {
        onboarding: { completed: true, studySources: ['manga', 'apps'] },
        placement: {
          status: 'completed',
          estimate: 'N5',
          source: 'quiz',
          completedAt: COMPLETED_AT,
          result: { totalCorrect: 0, byBand: { N5: 0, N4: 0, N3: 0 } }
        },
        targetLevel: 'N4'
      });
    });
  } finally {
    stub.restore();
  }
});

test('API: in-bank-but-not-selected questionId is rejected with 400 and persists nothing', async () => {
  const stub = installPlacementStub(freshState());
  // Swap one selected id for another bank id of the same band+type.
  const selectedSet = new Set(QIDS);
  const first = BANK_MAP.get(QIDS[0]);
  const outsider = PLACEMENT_BANK.find((question) => question.band === first.band && question.type === first.type && !selectedSet.has(question.id));
  assert.ok(outsider, 'bank must hold an unselected same-band+type item');
  try {
    await withServer(async (base) => {
      const forged = [{ questionId: outsider.id, optionId: outsider.correctOption }, ...ALL_CORRECT.slice(1)];
      const { status } = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: forged }
      });
      assert.equal(status, 400);
      // Another user's valid selection is equally forged for this caller.
      const otherIds = selectPlacementQuestions(OTHER_USER);
      assert.notDeepEqual(otherIds, QIDS);
      const crossUser = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: answersFor(otherIds, []) }
      });
      assert.equal(crossUser.status, 400);
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
    });
  } finally {
    stub.restore();
  }
});

test('API: unknown questionId is rejected with 400 and persists nothing', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const answers = [...ALL_CORRECT.slice(0, 9), { questionId: 'q99', optionId: 'a' }];
      const { status } = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers }
      });
      assert.equal(status, 400);
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
    });
  } finally {
    stub.restore();
  }
});

test('API: duplicate questionId is rejected with 400 and persists nothing', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const answers = [...ALL_CORRECT.slice(0, 9), { ...ALL_CORRECT[0] }];
      const { status } = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers }
      });
      assert.equal(status, 400);
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
    });
  } finally {
    stub.restore();
  }
});

test('API: invalid optionId values are rejected with 400', async () => {
  const stub = installPlacementStub(freshState());
  // null is the explicit abstention signal and is ACCEPTED (see abstention
  // contract tests below); everything else outside a/b/c/d is a 400.
  const badOptions = ['e', 'A', 'unknown', '', 1, undefined, {}, []];
  try {
    await withServer(async (base) => {
      for (const optionId of badOptions) {
        const answers = [...ALL_CORRECT.slice(0, 9), { questionId: QIDS[9], optionId }];
        const { status } = await requestJson(base, '/api/first-experience/placement/submit', {
          method: 'POST',
          body: { answers }
        });
        assert.equal(status, 400, `expected 400 for optionId ${JSON.stringify(optionId)}`);
      }
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
    });
  } finally {
    stub.restore();
  }
});

test('API: missing answers (9 of 10) and extras (11 entries) are rejected with 400', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const short = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_CORRECT.slice(0, 9) }
      });
      assert.equal(short.status, 400);
      const extra = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: [...ALL_CORRECT, { ...ALL_CORRECT[0] }] }
      });
      assert.equal(extra.status, 400);
      const noAnswers = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: {}
      });
      assert.equal(noAnswers.status, 400);
      const notArray = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: `${QIDS[0]}-a` }
      });
      assert.equal(notArray.status, 400);
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
    });
  } finally {
    stub.restore();
  }
});

test('API: spoofed estimate and result counts are ignored (all wrong + N3 claims stores N5 with 0s)', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: {
          answers: ALL_WRONG,
          estimate: 'N3',
          source: 'self_reported',
          placement: { status: 'completed', estimate: 'N3' },
          result: { totalCorrect: 10, byBand: { N5: 3, N4: 3, N3: 4 } }
        }
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { estimate: 'N5', placement: { status: 'completed', estimate: 'N5' } });
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N5',
        source: 'quiz',
        completedAt: COMPLETED_AT,
        result: { totalCorrect: 0, byBand: { N5: 0, N4: 0, N3: 0 } }
      });
    });
  } finally {
    stub.restore();
  }
});

// ---- Self-report API tests ----

test('Self-report: N5 persists completed self_reported with NULL counts, returns GET shape', async () => {
  const state = freshState();
  const stub = installPlacementStub(state);
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N5' }
      });
      assert.equal(status, 200);
      assert.deepEqual(body, {
        onboarding: { completed: false, studySources: [] },
        placement: {
          status: 'completed',
          estimate: 'N5',
          source: 'self_reported',
          completedAt: COMPLETED_AT,
          result: null
        },
        targetLevel: null
      });
    });
    const row = state.firstExp[TEST_USER];
    assert.ok(row, 'expected persisted row');
    assert.equal(row.placement_status, 'completed');
    assert.equal(row.placement_estimate, 'N5');
    assert.equal(row.placement_source, 'self_reported');
    assert.equal(row.placement_total_correct, null);
    assert.equal(row.placement_correct_n5, null);
    assert.equal(row.placement_correct_n4, null);
    assert.equal(row.placement_correct_n3, null);
  } finally {
    stub.restore();
  }
});

test('Self-report: N3 and N1 persist per-user with NULL counts', async () => {
  const state = freshState();
  const stub = installPlacementStub(state);
  try {
    await withServer(async (base) => {
      const n3 = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N3' }
      });
      assert.equal(n3.status, 200);
      assert.equal(n3.body.placement.estimate, 'N3');
      assert.equal(n3.body.placement.source, 'self_reported');
      assert.equal(n3.body.placement.result, null);
      const n1 = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N1', user_id: OTHER_USER },
        user: OTHER_USER
      });
      assert.equal(n1.status, 200);
      assert.equal(n1.body.placement.estimate, 'N1');
      assert.equal(n1.body.placement.source, 'self_reported');
      assert.equal(n1.body.placement.result, null);
      const n5 = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N5' },
        user: THIRD_USER
      });
      assert.equal(n5.status, 200);
      assert.equal(n5.body.placement.estimate, 'N5');
    });
    for (const user of [TEST_USER, OTHER_USER, THIRD_USER]) {
      const row = state.firstExp[user];
      assert.ok(row, `expected persisted row for ${user}`);
      assert.equal(row.placement_status, 'completed');
      assert.equal(row.placement_source, 'self_reported');
      assert.equal(row.placement_total_correct, null);
      assert.equal(row.placement_correct_n5, null);
      assert.equal(row.placement_correct_n4, null);
      assert.equal(row.placement_correct_n3, null);
    }
    assert.equal(state.firstExp[TEST_USER].placement_estimate, 'N3');
    assert.equal(state.firstExp[OTHER_USER].placement_estimate, 'N1');
    assert.equal(state.firstExp[THIRD_USER].placement_estimate, 'N5');
  } finally {
    stub.restore();
  }
});

test('Self-report: invalid levels are rejected with 400 and persist nothing', async () => {
  const stub = installPlacementStub(freshState());
  const badBodies = [
    {},
    { level: 'N6' },
    { level: 'n3' },
    { level: '' },
    { level: null },
    { level: 3 },
    { level: ['N3'] },
    { level: 'N0' },
    { estimate: 'N3' },
    null,
    'N3',
    []
  ];
  try {
    await withServer(async (base) => {
      for (const body of badBodies) {
        const { status } = await requestJson(base, '/api/first-experience/placement/self-report', {
          method: 'POST',
          body
        });
        assert.equal(status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
    });
  } finally {
    stub.restore();
  }
});

test('Self-report: spoofed estimate/source/result fields are ignored', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: {
          level: 'N4',
          estimate: 'N1',
          source: 'quiz',
          placement: { status: 'completed', estimate: 'N1' },
          result: { totalCorrect: 10, byBand: { N5: 3, N4: 3, N3: 4 } },
          answers: ALL_CORRECT,
          user_id: OTHER_USER,
          userId: OTHER_USER
        }
      });
      assert.equal(status, 200);
      assert.equal(body.placement.estimate, 'N4');
      assert.equal(body.placement.source, 'self_reported');
      assert.equal(body.placement.result, null);
      const other = await requestJson(base, '/api/first-experience', { user: OTHER_USER });
      assert.deepEqual(other.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
    });
  } finally {
    stub.restore();
  }
});

// ---- One-time across both sources ----

test('One-time: quiz submit after self-report is 409, self-reported result kept', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const first = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N2' }
      });
      assert.equal(first.status, 200);
      const second = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_CORRECT }
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'PLACEMENT_ALREADY_COMPLETED');
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N2',
        source: 'self_reported',
        completedAt: COMPLETED_AT,
        result: null
      });
    });
  } finally {
    stub.restore();
  }
});

test('One-time: self-report after quiz submit is 409, quiz result kept', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const first = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_WRONG }
      });
      assert.equal(first.status, 200);
      const second = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N1' }
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'PLACEMENT_ALREADY_COMPLETED');
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N5',
        source: 'quiz',
        completedAt: COMPLETED_AT,
        result: { totalCorrect: 0, byBand: { N5: 0, N4: 0, N3: 0 } }
      });
    });
  } finally {
    stub.restore();
  }
});

test('One-time: second self-report is 409, first level kept', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const first = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N4' }
      });
      assert.equal(first.status, 200);
      const second = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N1' }
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'PLACEMENT_ALREADY_COMPLETED');
      const got = await requestJson(base, '/api/first-experience');
      assert.equal(got.body.placement.estimate, 'N4');
      assert.equal(got.body.placement.source, 'self_reported');
    });
  } finally {
    stub.restore();
  }
});

test('One-time: questions after self-report is 409', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const before = await requestJson(base, '/api/first-experience/placement/questions');
      assert.equal(before.status, 200);
      const report = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N3' }
      });
      assert.equal(report.status, 200);
      const { status, body } = await requestJson(base, '/api/first-experience/placement/questions');
      assert.equal(status, 409);
      assert.equal(body.code, 'PLACEMENT_ALREADY_COMPLETED');
    });
  } finally {
    stub.restore();
  }
});

// ---- Skip / one-time / isolation ----

test('API: skip on a fresh account creates a skipped row with null estimate and null source', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience/placement/skip', {
        method: 'POST',
        body: {}
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { estimate: null, placement: { status: 'skipped', estimate: null } });
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, {
        onboarding: { completed: false, studySources: [] },
        placement: { status: 'skipped', estimate: null, source: null, completedAt: null, result: null },
        targetLevel: null
      });
    });
  } finally {
    stub.restore();
  }
});

test('One-time: skip after quiz completion stays completed with source quiz (never downgrades), 200', async () => {
  const stub = installPlacementStub(freshState());
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  try {
    await withServer(async (base) => {
      const submit = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: correctExcept(n4[0], n3[0], n3[1]) }
      });
      assert.equal(submit.status, 200);
      assert.equal(submit.body.estimate, 'N3');
      const { status, body } = await requestJson(base, '/api/first-experience/placement/skip', {
        method: 'POST',
        body: {}
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { estimate: 'N3', placement: { status: 'completed', estimate: 'N3' } });
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N3',
        source: 'quiz',
        completedAt: COMPLETED_AT,
        result: { totalCorrect: 7, byBand: { N5: 3, N4: 2, N3: 2 } }
      });
    });
    assert.ok(!stub.seen.some((entry) => /UPDATE[^;]*'skipped'/i.test(entry.sql) || /INSERT[^;]*'skipped'/i.test(entry.sql)),
      'skip-after-completed must issue no skipped write');
  } finally {
    stub.restore();
  }
});

test('One-time: skip after self-report stays completed with source self_reported (never downgrades), 200', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const report = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N1' }
      });
      assert.equal(report.status, 200);
      const { status, body } = await requestJson(base, '/api/first-experience/placement/skip', {
        method: 'POST',
        body: {}
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { estimate: 'N1', placement: { status: 'completed', estimate: 'N1' } });
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N1',
        source: 'self_reported',
        completedAt: COMPLETED_AT,
        result: null
      });
    });
    assert.ok(!stub.seen.some((entry) => /UPDATE[^;]*'skipped'/i.test(entry.sql) || /INSERT[^;]*'skipped'/i.test(entry.sql)),
      'skip-after-self-report must issue no skipped write');
  } finally {
    stub.restore();
  }
});

test('One-time: second submit (even different answers) is 409, first result kept', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const first = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_WRONG }
      });
      assert.deepEqual(first.body, { estimate: 'N5', placement: { status: 'completed', estimate: 'N5' } });
      const second = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_CORRECT }
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'PLACEMENT_ALREADY_COMPLETED');
      assert.match(second.body.error, /already been completed/);
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N5',
        source: 'quiz',
        completedAt: COMPLETED_AT,
        result: { totalCorrect: 0, byBand: { N5: 0, N4: 0, N3: 0 } }
      });
    });
  } finally {
    stub.restore();
  }
});

test('One-time: rejected second submit runs inside the row-locked transaction (no write after FOR UPDATE)', async () => {
  // The in-memory stub cannot emulate PostgreSQL row locks, so true
  // concurrency is verified by code-level reasoning (ensure-then-lock:
  // INSERT ... DO NOTHING + SELECT ... FOR UPDATE serializes concurrent
  // submits on the single-user row; the loser rolls back with 409). This
  // test pins the transactional path: the rejected attempt must SELECT ...
  // FOR UPDATE inside a transaction and issue no completion UPDATE.
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const first = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_WRONG }
      });
      assert.equal(first.status, 200);
      const seenBefore = stub.seen.length;
      const second = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_CORRECT }
      });
      assert.equal(second.status, 409);
      const attempt = stub.seen.slice(seenBefore);
      const lockIndex = attempt.findIndex((entry) => /SELECT[^;]*FOR UPDATE/i.test(entry.sql));
      assert.ok(lockIndex >= 0, 'rejected submit must SELECT ... FOR UPDATE');
      assert.ok(!attempt.some((entry) => /UPDATE[^;]*'completed'/i.test(entry.sql)),
        'rejected submit must not issue the completion UPDATE');
      const success = stub.seen.slice(0, seenBefore);
      const successLock = success.findIndex((entry) => /SELECT[^;]*FOR UPDATE/i.test(entry.sql));
      const successWrite = success.findIndex((entry) => /UPDATE[^;]*'completed'/i.test(entry.sql));
      assert.ok(successLock >= 0 && successWrite > successLock,
        'successful submit must lock the row before writing the completion');
    });
  } finally {
    stub.restore();
  }
});

test('One-time: questions after quiz completion is 409, result stays available via GET', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const before = await requestJson(base, '/api/first-experience/placement/questions');
      assert.equal(before.status, 200);
      assert.equal(before.body.length, 10);
      const submit = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_CORRECT }
      });
      assert.equal(submit.status, 200);
      const { status, body } = await requestJson(base, '/api/first-experience/placement/questions');
      assert.equal(status, 409);
      assert.equal(body.code, 'PLACEMENT_ALREADY_COMPLETED');
      const got = await requestJson(base, '/api/first-experience');
      assert.equal(got.status, 200);
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N3',
        source: 'quiz',
        completedAt: COMPLETED_AT,
        result: { totalCorrect: 10, byBand: { N5: 3, N4: 3, N3: 4 } }
      });
    });
  } finally {
    stub.restore();
  }
});

test('API: placement rows are isolated per user across both sources', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const mine = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_CORRECT, user_id: OTHER_USER, userId: OTHER_USER }
      });
      assert.equal(mine.status, 200);
      assert.equal(mine.body.estimate, 'N3');
      const other = await requestJson(base, '/api/first-experience', { user: OTHER_USER });
      assert.deepEqual(other.body.placement, { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
      const theirs = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N1' },
        user: OTHER_USER
      });
      assert.equal(theirs.status, 200);
      assert.equal(theirs.body.placement.source, 'self_reported');
      const first = await requestJson(base, '/api/first-experience');
      assert.deepEqual(first.body.placement, {
        status: 'completed',
        estimate: 'N3',
        source: 'quiz',
        completedAt: COMPLETED_AT,
        result: { totalCorrect: 10, byBand: { N5: 3, N4: 3, N3: 4 } }
      });
    });
  } finally {
    stub.restore();
  }
});

test('API: raw answers are never persisted', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_CORRECT }
      });
      await requestJson(base, '/api/first-experience/placement/skip', { method: 'POST', body: {} });
    });
    const stub2 = installPlacementStub(freshState());
    try {
      await withServer(async (base) => {
        await requestJson(base, '/api/first-experience/placement/self-report', {
          method: 'POST',
          body: { level: 'N2' }
        });
      });
      for (const entry of stub2.seen) {
        const serialized = JSON.stringify(entry.params);
        assert.ok(!/questionId/i.test(serialized), 'raw answers must never reach the database');
        assert.ok(!/optionId/i.test(serialized), 'raw answers must never reach the database');
      }
    } finally {
      stub2.restore();
    }
    for (const entry of stub.seen) {
      const serialized = JSON.stringify(entry.params);
      assert.ok(!/questionId/i.test(serialized), 'raw answers must never reach the database');
      assert.ok(!/optionId/i.test(serialized), 'raw answers must never reach the database');
    }
  } finally {
    stub.restore();
  }
});

test('API: onboarding PUT still works and preserves quiz placement with source (no A.2 regression)', async () => {
  const stub = installPlacementStub(freshState());
  const n4 = idsInBand(QIDS, 'N4');
  const n3 = idsInBand(QIDS, 'N3');
  try {
    await withServer(async (base) => {
      const put = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N3', studySources: ['textbooks'] }
      });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body, {
        onboarding: { completed: true, studySources: ['textbooks'] },
        placement: { status: 'not_started', estimate: null, source: null, completedAt: null, result: null },
        targetLevel: 'N3'
      });
      await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: correctExcept(n4[0], n3[0], n3[1]) }
      });
      const again = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N2', studySources: ['apps'] }
      });
      assert.equal(again.status, 200);
      assert.deepEqual(again.body, {
        onboarding: { completed: true, studySources: ['apps'] },
        placement: {
          status: 'completed',
          estimate: 'N3',
          source: 'quiz',
          completedAt: COMPLETED_AT,
          result: { totalCorrect: 7, byBand: { N5: 3, N4: 2, N3: 2 } }
        },
        targetLevel: 'N2'
      });
      const target = await requestJson(base, '/api/level/target');
      assert.deepEqual(target.body, { targetLevel: 'N2' });
    });
    const writes = stub.seen.filter((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql));
    assert.ok(writes.every((entry) => /user_jlpt_target|user_first_experience/i.test(entry.sql)),
      'writes must stay inside user_jlpt_target / user_first_experience');
  } finally {
    stub.restore();
  }
});

test('API: onboarding PUT preserves self-reported placement with source (never sets source)', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const report = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N4' }
      });
      assert.equal(report.status, 200);
      const put = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N4', studySources: ['apps'] }
      });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body.placement, {
        status: 'completed',
        estimate: 'N4',
        source: 'self_reported',
        completedAt: COMPLETED_AT,
        result: null
      });
      assert.ok(!stub.seen.some((entry) => /placement_source/i.test(entry.sql) && /^\s*INSERT/i.test(entry.sql) && /study_sources/i.test(entry.sql)),
        'onboarding PUT must never write placement_source');
    });
  } finally {
    stub.restore();
  }
});

test('GET result null cases: skipped, pre-breakdown, and self_reported rows return result:null', async () => {
  const stub = installPlacementStub(freshState({
    firstExp: {
      // Pre-source completed row: no breakdown columns exist (backfill impossible).
      [OTHER_USER]: seedRow({
        onboarding_completed_at: '2026-09-01T00:00:00.000Z',
        study_sources: ['manga'],
        placement_status: 'completed',
        placement_estimate: 'N3',
        placement_completed_at: '2026-09-02T00:00:00.000Z'
      })
    }
  }));
  // NOTE: seedRow defaults the counts and source to null (same as pre-015
  // NULL columns and pre-016 NULL source), so the seeded legacy row
  // exercises the pre-breakdown/pre-source path.
  try {
    await withServer(async (base) => {
      const legacy = await requestJson(base, '/api/first-experience', { user: OTHER_USER });
      assert.equal(legacy.status, 200);
      assert.deepEqual(legacy.body.placement, {
        status: 'completed',
        estimate: 'N3',
        source: null,
        completedAt: '2026-09-02T00:00:00.000Z',
        result: null
      });
      const fresh = await requestJson(base, '/api/first-experience');
      assert.deepEqual(fresh.body.placement,
        { status: 'not_started', estimate: null, source: null, completedAt: null, result: null });
      await requestJson(base, '/api/first-experience/placement/skip', { method: 'POST', body: {} });
      const skipped = await requestJson(base, '/api/first-experience');
      assert.deepEqual(skipped.body.placement,
        { status: 'skipped', estimate: null, source: null, completedAt: null, result: null });
      await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N2' },
        user: THIRD_USER
      });
      const reported = await requestJson(base, '/api/first-experience', { user: THIRD_USER });
      assert.deepEqual(reported.body.placement, {
        status: 'completed',
        estimate: 'N2',
        source: 'self_reported',
        completedAt: COMPLETED_AT,
        result: null
      });
    });
  } finally {
    stub.restore();
  }
});

test('GET history: legacy rows with vestigial n2/n1 counts surface the N5/N4/N3 subset only (no mutation)', async () => {
  // Completed rows persist counts only (never question ids), so the bank
  // rename cannot orphan them; even a hypothetical row with nonzero n2/n1
  // reads as the N5/N4/N3 subset because toPlacementResult drops n2/n1.
  const stub = installPlacementStub(freshState({
    firstExp: {
      [OTHER_USER]: seedRow({
        placement_status: 'completed',
        placement_estimate: 'N4',
        placement_source: 'quiz',
        placement_completed_at: '2026-09-02T00:00:00.000Z',
        placement_total_correct: 6,
        placement_correct_n5: 2,
        placement_correct_n4: 2,
        placement_correct_n3: 2,
        placement_correct_n2: 2,
        placement_correct_n1: 1
      })
    }
  }));
  try {
    await withServer(async (base) => {
      const got = await requestJson(base, '/api/first-experience', { user: OTHER_USER });
      assert.equal(got.status, 200);
      assert.deepEqual(got.body.placement, {
        status: 'completed',
        estimate: 'N4',
        source: 'quiz',
        completedAt: '2026-09-02T00:00:00.000Z',
        result: { totalCorrect: 6, byBand: { N5: 2, N4: 2, N3: 2 } }
      });
    });
    assert.ok(!stub.seen.some((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql)), 'history GET must be read-only');
  } finally {
    stub.restore();
  }
});

test('One-time: onboarding PUT skip after quiz completion stays completed (never downgrades)', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const submit = await requestJson(base, '/api/first-experience/placement/submit', {
        method: 'POST',
        body: { answers: ALL_WRONG }
      });
      assert.equal(submit.status, 200);
      const put = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N5', studySources: ['apps'], placementStatus: 'skipped' }
      });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body, {
        onboarding: { completed: true, studySources: ['apps'] },
        placement: {
          status: 'completed',
          estimate: 'N5',
          source: 'quiz',
          completedAt: COMPLETED_AT,
          result: { totalCorrect: 0, byBand: { N5: 0, N4: 0, N3: 0 } }
        },
        targetLevel: 'N5'
      });
    });
  } finally {
    stub.restore();
  }
});

test('One-time: onboarding PUT skip after self-report stays completed (never downgrades)', async () => {
  const stub = installPlacementStub(freshState());
  try {
    await withServer(async (base) => {
      const report = await requestJson(base, '/api/first-experience/placement/self-report', {
        method: 'POST',
        body: { level: 'N3' }
      });
      assert.equal(report.status, 200);
      const put = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N3', studySources: ['apps'], placementStatus: 'skipped' }
      });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body.placement, {
        status: 'completed',
        estimate: 'N3',
        source: 'self_reported',
        completedAt: COMPLETED_AT,
        result: null
      });
    });
  } finally {
    stub.restore();
  }
});
