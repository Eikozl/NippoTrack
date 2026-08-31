const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: process.env.INTEGRATION_TEST_ENV_FILE });

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required integration environment variable: ${name}`);
  return value;
}

const integration = {
  url: required('SUPABASE_INTEGRATION_URL'),
  publishableKey: required('SUPABASE_INTEGRATION_PUBLISHABLE_KEY'),
  secretKey: required('SUPABASE_INTEGRATION_SECRET_KEY')
};
if (process.env.JLT_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS !== 'true') {
  throw new Error('Set JLT_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true only for the disposable integration project.');
}

process.env.NODE_ENV = 'integration';
process.env.SUPABASE_URL = integration.url;
process.env.SUPABASE_PUBLISHABLE_KEY = integration.publishableKey;
process.env.SUPABASE_AUTH_REDIRECT_URL ||= 'http://127.0.0.1:5173';
const app = require('../src/app');

const admin = createClient(integration.url, integration.secretKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
const publicAuth = createClient(integration.url, integration.publishableKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });

async function createTestUser(label) {
  const nonce = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const email = `jlt-${label.toLowerCase()}-${nonce}@integration.invalid`;
  const password = crypto.randomBytes(24).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user?.id) throw new Error(`Unable to create integration user ${label}.`);
  const session = await publicAuth.auth.signInWithPassword({ email, password });
  if (session.error || !session.data.session?.access_token) throw new Error(`Unable to sign in integration user ${label}.`);
  return { id: data.user.id, token: session.data.session.access_token };
}

async function main() {
  const users = [];
  const created = { aVocabulary: null, bVocabulary: null, aSession: null, aNote: null };
  const instance = app.listen(0);
  await new Promise((resolve) => instance.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${instance.address().port}`;

  async function api(token, path, { method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { response, data: await response.json() };
  }

  try {
    const userA = await createTestUser('A');
    users.push(userA);
    const userB = await createTestUser('B');
    users.push(userB);
    const marker = `__isolation_${Date.now()}`;
    const [createdA, createdB] = await Promise.all([
      api(userA.token, '/api/vocabulary', { method: 'POST', body: { word: marker, meaning: 'account A isolation record' } }),
      api(userB.token, '/api/vocabulary', { method: 'POST', body: { word: marker, meaning: 'account B isolation record' } })
    ]);
    assert.equal(createdA.response.status, 201);
    assert.equal(createdB.response.status, 201);
    created.aVocabulary = createdA.data.id_vocabulary;
    created.bVocabulary = createdB.data.id_vocabulary;
    assert.notEqual(created.aVocabulary, created.bVocabulary);

    const [listA, listB] = await Promise.all([api(userA.token, `/api/vocabulary?search=${encodeURIComponent(marker)}`), api(userB.token, `/api/vocabulary?search=${encodeURIComponent(marker)}`)]);
    assert.deepEqual(listA.data.items.map((item) => item.id_vocabulary), [created.aVocabulary]);
    assert.deepEqual(listB.data.items.map((item) => item.id_vocabulary), [created.bVocabulary]);

    const [foreignRead, foreignUpdate, foreignDelete] = await Promise.all([
      api(userB.token, `/api/vocabulary/${created.aVocabulary}`),
      api(userB.token, `/api/vocabulary/${created.aVocabulary}`, { method: 'PUT', body: { meaning: 'cross-user mutation' } }),
      api(userB.token, `/api/vocabulary/${created.aVocabulary}`, { method: 'DELETE' })
    ]);
    assert.equal(foreignRead.response.status, 404);
    assert.equal(foreignUpdate.response.status, 404);
    assert.equal(foreignDelete.response.status, 404);

    const session = await api(userA.token, '/api/sessions', { method: 'POST', body: { session_date: new Date().toISOString().slice(0, 10), duration_minutes: 1, category: 'Vocabulary' } });
    assert.equal(session.response.status, 201);
    created.aSession = session.data.id_session;
    assert.equal((await api(userA.token, `/api/sessions/${created.aSession}`, { method: 'PUT', body: { vocabulary_ids: [created.bVocabulary] } })).response.status, 400);

    const note = await api(userA.token, '/api/notes', { method: 'POST', body: { body: marker, category: 'General' } });
    assert.equal(note.response.status, 201);
    created.aNote = note.data.id_note;
    assert.equal((await api(userA.token, `/api/notes/${created.aNote}/links`, { method: 'PUT', body: { vocabulary: [created.bVocabulary] } })).response.status, 400);

    const exportB = await api(userB.token, '/api/export');
    assert.equal(exportB.response.status, 200);
    assert.equal(exportB.data.data.vocabulary.some((item) => item.id_vocabulary === created.aVocabulary), false);
    assert.equal(exportB.data.data.vocabulary.some((item) => item.id_vocabulary === created.bVocabulary), true);
    console.log(JSON.stringify({ isolation: 'passed', users: 'ephemeral-and-cleaned', checks: ['per-user uniqueness', 'search isolation', 'foreign read/update/delete', 'session and note link rejection', 'export isolation'] }, null, 2));
  } finally {
    const [userA, userB] = users;
    if (userA && created.aNote) await api(userA.token, `/api/notes/${created.aNote}`, { method: 'DELETE' }).catch(() => undefined);
    if (userA && created.aSession) await api(userA.token, `/api/sessions/${created.aSession}`, { method: 'DELETE' }).catch(() => undefined);
    if (userA && created.aVocabulary) await api(userA.token, `/api/vocabulary/${created.aVocabulary}`, { method: 'DELETE' }).catch(() => undefined);
    if (userB && created.bVocabulary) await api(userB.token, `/api/vocabulary/${created.bVocabulary}`, { method: 'DELETE' }).catch(() => undefined);
    for (const user of users) await admin.auth.admin.deleteUser(user.id).catch(() => undefined);
    await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => { console.error('Multi-user isolation test failed.'); console.error(error.message); process.exitCode = 1; });
