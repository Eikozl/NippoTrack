const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: process.env.MULTI_USER_TEST_ENV_FILE });

if (process.env.NODE_ENV === 'test') throw new Error('Run multi-user isolation with NODE_ENV=integration, never the test auth bypass.');

const app = require('../src/app');

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required integration environment variable: ${name}`);
  return value;
}

async function accessToken(label) {
  const token = process.env[`JLT_MULTI_USER_TEST_${label}_ACCESS_TOKEN`];
  if (token) return token;
  const email = required(`JLT_MULTI_USER_TEST_${label}_EMAIL`);
  const password = required(`JLT_MULTI_USER_TEST_${label}_PASSWORD`);
  const client = createClient(required('SUPABASE_URL'), required('SUPABASE_PUBLISHABLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token || !data.user?.email_confirmed_at) throw new Error(`Unable to establish a confirmed test session for account ${label}.`);
  return data.session.access_token;
}

async function main() {
  const [tokenA, tokenB] = await Promise.all([accessToken('A'), accessToken('B')]);
  const instance = app.listen(0);
  await new Promise((resolve) => instance.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${instance.address().port}`;
  const created = { aVocabulary: null, bVocabulary: null, aSession: null };

  async function api(token, path, { method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { response, data: await response.json() };
  }

  try {
    const marker = `__isolation_${Date.now()}`;
    const [createdA, createdB] = await Promise.all([
      api(tokenA, '/api/vocabulary', { method: 'POST', body: { word: marker, meaning: 'account A isolation record' } }),
      api(tokenB, '/api/vocabulary', { method: 'POST', body: { word: marker, meaning: 'account B isolation record' } })
    ]);
    assert.equal(createdA.response.status, 201);
    assert.equal(createdB.response.status, 201);
    created.aVocabulary = createdA.data.id_vocabulary;
    created.bVocabulary = createdB.data.id_vocabulary;
    assert.notEqual(created.aVocabulary, created.bVocabulary);

    const [listA, listB] = await Promise.all([
      api(tokenA, `/api/vocabulary?search=${encodeURIComponent(marker)}`),
      api(tokenB, `/api/vocabulary?search=${encodeURIComponent(marker)}`)
    ]);
    assert.deepEqual(listA.data.items.map((item) => item.id_vocabulary), [created.aVocabulary]);
    assert.deepEqual(listB.data.items.map((item) => item.id_vocabulary), [created.bVocabulary]);

    const [foreignRead, foreignUpdate, foreignDelete] = await Promise.all([
      api(tokenB, `/api/vocabulary/${created.aVocabulary}`),
      api(tokenB, `/api/vocabulary/${created.aVocabulary}`, { method: 'PUT', body: { meaning: 'attempted cross-user update' } }),
      api(tokenB, `/api/vocabulary/${created.aVocabulary}`, { method: 'DELETE' })
    ]);
    assert.equal(foreignRead.response.status, 404);
    assert.equal(foreignUpdate.response.status, 404);
    assert.equal(foreignDelete.response.status, 404);

    const session = await api(tokenA, '/api/sessions', { method: 'POST', body: { session_date: new Date().toISOString().slice(0, 10), duration_minutes: 1, category: 'Vocabulary' } });
    assert.equal(session.response.status, 201);
    created.aSession = session.data.id_session;
    const crossLink = await api(tokenA, `/api/sessions/${created.aSession}`, { method: 'PUT', body: { vocabulary_ids: [created.bVocabulary] } });
    assert.equal(crossLink.response.status, 400);

    const exportB = await api(tokenB, '/api/export');
    assert.equal(exportB.response.status, 200);
    assert.equal(exportB.data.data.vocabulary.some((item) => item.id_vocabulary === created.aVocabulary), false);
    assert.equal(exportB.data.data.vocabulary.some((item) => item.id_vocabulary === created.bVocabulary), true);
    console.log(JSON.stringify({ isolation: 'passed', checks: ['per-user duplicate values', 'list isolation', 'foreign read/update/delete return 404', 'cross-user relationship rejected', 'export isolation'] }, null, 2));
  } finally {
    if (created.aSession) await api(tokenA, `/api/sessions/${created.aSession}`, { method: 'DELETE' }).catch(() => undefined);
    if (created.aVocabulary) await api(tokenA, `/api/vocabulary/${created.aVocabulary}`, { method: 'DELETE' }).catch(() => undefined);
    if (created.bVocabulary) await api(tokenB, `/api/vocabulary/${created.bVocabulary}`, { method: 'DELETE' }).catch(() => undefined);
    await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => { console.error('Multi-user isolation test failed.'); console.error(error.message); process.exitCode = 1; });
