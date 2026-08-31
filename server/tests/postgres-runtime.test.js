const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

if (process.env.INTEGRATION_TEST_ENV_FILE) dotenv.config({ path: process.env.INTEGRATION_TEST_ENV_FILE });

const integrationEnabled = process.env.JLT_RUN_POSTGRES_INTEGRATION === 'true';
const app = require('../src/app');
const pool = require('../src/config/db');

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required integration environment variable: ${name}`);
  return value;
}

function assertDisposableTarget(url, projectRef) {
  if (process.env.JLT_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS !== 'true') {
    throw new Error('Set JLT_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true only for the disposable integration project.');
  }
  if (new URL(url).hostname !== `${projectRef}.supabase.co`) {
    throw new Error('SUPABASE_INTEGRATION_URL does not match SUPABASE_INTEGRATION_PROJECT_REF.');
  }
  const runtimeTarget = `${required('POSTGRES_RUNTIME_HOST')} ${required('POSTGRES_RUNTIME_USER')}`;
  if (!runtimeTarget.includes(projectRef)) {
    throw new Error('PostgreSQL runtime is not connected to the declared disposable integration project.');
  }
}

function santoDomingoDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

async function startServer() {
  const instance = app.listen(0);
  await new Promise((resolve) => instance.once('listening', resolve));
  return instance;
}

test('PostgreSQL/Supabase runtime preserves authenticated core API contracts', { skip: !integrationEnabled }, async () => {
  const url = required('SUPABASE_INTEGRATION_URL');
  const publishableKey = required('SUPABASE_INTEGRATION_PUBLISHABLE_KEY');
  const secretKey = required('SUPABASE_INTEGRATION_SECRET_KEY');
  const projectRef = required('SUPABASE_INTEGRATION_PROJECT_REF');
  assertDisposableTarget(url, projectRef);

  process.env.NODE_ENV = 'integration';
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_PUBLISHABLE_KEY = publishableKey;

  const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  const publicAuth = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  const nonce = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const identity = { email: `jlt-runtime-${nonce}@integration.invalid`, password: crypto.randomBytes(24).toString('base64url') };
  const created = { userId: null, vocabularyId: null, sessionId: null };
  const instance = await startServer();
  const baseUrl = `http://127.0.0.1:${instance.address().port}`;

  async function api(path, { method = 'GET', body, token } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { response, data: await response.json() };
  }

  try {
    const health = await api('/api/health');
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.data, { ok: true, status: 'healthy', database: 'jlt' });

    const createdUser = await admin.auth.admin.createUser({ ...identity, email_confirm: true });
    assert.equal(createdUser.error, null);
    created.userId = createdUser.data.user?.id;
    assert.ok(created.userId);

    const signedIn = await publicAuth.auth.signInWithPassword(identity);
    assert.equal(signedIn.error, null);
    const token = signedIn.data.session?.access_token;
    assert.ok(token);

    const emptyDashboard = await api('/api/dashboard', { token });
    assert.equal(emptyDashboard.response.status, 200);
    assert.equal(emptyDashboard.data.vocabularyCount, 0);
    assert.deepEqual(emptyDashboard.data.recentSessions, []);

    const vocabulary = await api('/api/vocabulary', {
      method: 'POST', token,
      body: {
        word: '日本語', reading: 'にほんご', meaning: 'Japanese language',
        example_sentence: '日本語を勉強します。', example_translation: 'I study Japanese.'
      }
    });
    assert.equal(vocabulary.response.status, 201);
    created.vocabularyId = vocabulary.data.id_vocabulary;
    assert.ok(created.vocabularyId);

    const vocabularyDetail = await api(`/api/vocabulary/${created.vocabularyId}`, { token });
    assert.equal(vocabularyDetail.response.status, 200);
    assert.equal(vocabularyDetail.data.word, '日本語');
    assert.equal(vocabularyDetail.data.examples[0].sentence, '日本語を勉強します。');

    const options = await api('/api/vocabulary/options?search=nihongo', { token });
    assert.equal(options.response.status, 200);
    assert.equal(options.data.items[0].id_vocabulary, created.vocabularyId);
    assert.equal(options.data.items[0].word, '日本語');

    const sessionDate = santoDomingoDate();
    const session = await api('/api/sessions', {
      method: 'POST', token,
      body: { session_date: sessionDate, duration_minutes: 17, category: 'Vocabulary', vocabulary_ids: [created.vocabularyId] }
    });
    assert.equal(session.response.status, 201);
    created.sessionId = session.data.id_session;
    assert.ok(created.sessionId);

    const sessionDetail = await api(`/api/sessions/${created.sessionId}`, { token });
    assert.equal(sessionDetail.response.status, 200);
    assert.equal(String(sessionDetail.data.session_date).slice(0, 10), sessionDate);
    assert.deepEqual(sessionDetail.data.vocabulary.map((item) => item.id_vocabulary), [created.vocabularyId]);

    const dashboard = await api('/api/dashboard', { token });
    assert.equal(dashboard.response.status, 200);
    assert.equal(dashboard.data.vocabularyCount, 1);
    assert.equal(dashboard.data.minutesToday, 17);
    assert.equal(dashboard.data.recentSessions[0].id_session, created.sessionId);

    const exported = await api('/api/export', { token });
    assert.equal(exported.response.status, 200);
    assert.equal(exported.data.data.vocabulary[0].word, '日本語');
    assert.deepEqual(exported.data.data.sessionVocabulary, [{ id_session: created.sessionId, id_vocabulary: created.vocabularyId }]);
  } finally {
    let cleanupError;
    const signIn = await publicAuth.auth.signInWithPassword(identity).catch(() => ({ data: {} }));
    const cleanupToken = signIn.data?.session?.access_token;
    try {
      if (cleanupToken && created.sessionId) {
        assert.equal((await api(`/api/sessions/${created.sessionId}`, { method: 'DELETE', token: cleanupToken })).response.status, 200);
      }
      if (cleanupToken && created.vocabularyId) {
        assert.equal((await api(`/api/vocabulary/${created.vocabularyId}`, { method: 'DELETE', token: cleanupToken })).response.status, 200);
      }
      if (created.userId) assert.equal((await admin.auth.admin.deleteUser(created.userId)).error, null);
    } catch (error) {
      cleanupError = error;
    }
    await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
    if (cleanupError) throw cleanupError;
  }
});

test.after(async () => pool.end());
