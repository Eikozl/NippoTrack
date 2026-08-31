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

if (process.env.JLT_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS !== 'true') {
  throw new Error('Set JLT_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true only for the disposable integration project.');
}

const integration = {
  url: required('SUPABASE_INTEGRATION_URL'),
  publishableKey: required('SUPABASE_INTEGRATION_PUBLISHABLE_KEY'),
  secretKey: required('SUPABASE_INTEGRATION_SECRET_KEY')
};

process.env.NODE_ENV = 'integration';
process.env.SUPABASE_URL = integration.url;
process.env.SUPABASE_PUBLISHABLE_KEY = integration.publishableKey;
process.env.SUPABASE_AUTH_REDIRECT_URL ||= 'http://127.0.0.1:5173';

const app = require('../src/app');
const admin = createClient(integration.url, integration.secretKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });

function authClient() {
  return createClient(integration.url, integration.publishableKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
}

function testIdentity(label) {
  const nonce = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  return {
    email: `jlt-${label.toLowerCase()}-${nonce}@integration.invalid`,
    password: crypto.randomBytes(24).toString('base64url')
  };
}

async function main() {
  const userIds = [];
  const instance = app.listen(0);
  await new Promise((resolve) => instance.once('listening', resolve));
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
    const signup = testIdentity('signup');
    const signupLink = await admin.auth.admin.generateLink({ type: 'signup', ...signup, options: { redirectTo: process.env.SUPABASE_AUTH_REDIRECT_URL } });
    if (signupLink.error || !signupLink.data.user?.id || !signupLink.data.properties?.hashed_token) throw new Error('Unable to generate a confirmation link for the integration user.');
    userIds.push(signupLink.data.user.id);

    const beforeConfirmation = await api('/api/auth/sign-in', { method: 'POST', body: signup });
    assert.equal(beforeConfirmation.response.status, 401);

    const confirmationClient = authClient();
    const confirmation = await confirmationClient.auth.verifyOtp({ type: 'signup', token_hash: signupLink.data.properties.hashed_token });
    assert.equal(confirmation.error, null);
    assert.ok(confirmation.data.session?.access_token);

    const afterConfirmation = await api('/api/auth/sign-in', { method: 'POST', body: signup });
    assert.equal(afterConfirmation.response.status, 200);
    assert.ok(afterConfirmation.data.session?.access_token);

    const privateData = await api('/api/dashboard', { token: confirmation.data.session.access_token });
    assert.equal(privateData.response.status, 200);

    const recovery = testIdentity('recovery');
    const createdRecoveryUser = await admin.auth.admin.createUser({ ...recovery, email_confirm: true });
    if (createdRecoveryUser.error || !createdRecoveryUser.data.user?.id) throw new Error('Unable to create the confirmed recovery integration user.');
    userIds.push(createdRecoveryUser.data.user.id);

    // An empty address deliberately skips delivery while proving the public
    // endpoint remains non-enumerating. Actual SMTP delivery is validated
    // separately with a configured test mailbox.
    const recoveryRequest = await api('/api/auth/forgot-password', { method: 'POST', body: { email: '' } });
    assert.equal(recoveryRequest.response.status, 202);
    assert.deepEqual(recoveryRequest.data, { message: 'If an account exists for that email, recovery instructions have been sent.' });

    const recoveryLink = await admin.auth.admin.generateLink({ type: 'recovery', email: recovery.email, options: { redirectTo: process.env.SUPABASE_AUTH_REDIRECT_URL } });
    if (recoveryLink.error || !recoveryLink.data.properties?.hashed_token) throw new Error('Unable to generate a recovery link for the integration user.');
    const recoveryClient = authClient();
    const recoverySession = await recoveryClient.auth.verifyOtp({ type: 'recovery', token_hash: recoveryLink.data.properties.hashed_token });
    assert.equal(recoverySession.error, null);
    assert.ok(recoverySession.data.session?.access_token);

    const replacementPassword = crypto.randomBytes(24).toString('base64url');
    const updated = await recoveryClient.auth.updateUser({ password: replacementPassword });
    assert.equal(updated.error, null);

    const oldPassword = await authClient().auth.signInWithPassword(recovery);
    assert.ok(oldPassword.error || !oldPassword.data.session);
    const newPassword = await authClient().auth.signInWithPassword({ email: recovery.email, password: replacementPassword });
    assert.equal(newPassword.error, null);
    assert.ok(newPassword.data.session?.access_token);

    const reusedRecoveryLink = await authClient().auth.verifyOtp({ type: 'recovery', token_hash: recoveryLink.data.properties.hashed_token });
    assert.ok(reusedRecoveryLink.error);
    const invalidRecoveryLink = await authClient().auth.verifyOtp({ type: 'recovery', token_hash: crypto.randomBytes(32).toString('hex') });
    assert.ok(invalidRecoveryLink.error);

    console.log(JSON.stringify({ authFlows: 'passed', users: 'ephemeral-and-cleaned', checks: ['unconfirmed sign-in blocked', 'confirmation token enables private API', 'non-enumerating recovery response', 'recovery token updates password', 'old password rejected', 'reused and invalid recovery tokens rejected'] }, null, 2));
  } finally {
    for (const id of userIds) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => { console.error('Supabase authentication flow test failed.'); console.error(error.message); process.exitCode = 1; });
