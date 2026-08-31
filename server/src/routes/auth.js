const express = require('express');
const { authClient, authRedirectUrl } = require('../auth/supabase');
const { sessionStatus } = require('../middleware/authentication');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const signInRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many authentication attempts. Please try again later.' });
const recoveryRateLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 3, message: 'Too many recovery requests. Please try again later.' });

function credentials(body = {}) {
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return null;
  return { email, password };
}

router.get('/session', sessionStatus);
router.post('/sign-up', signInRateLimit, async (req, res) => {
  const values = credentials(req.body);
  if (!values || values.password.length < 8) return res.status(400).json({ error: 'Enter a valid email and a password of at least 8 characters.' });
  try {
    await authClient().auth.signUp({ ...values, options: { emailRedirectTo: authRedirectUrl(req) } });
    return res.status(202).json({ message: 'If the address can receive email, check it to confirm your account.' });
  } catch {
    return res.status(503).json({ error: 'Unable to create the account right now.' });
  }
});
router.post('/sign-in', signInRateLimit, async (req, res) => {
  const values = credentials(req.body);
  if (!values) return res.status(401).json({ error: 'Invalid email or password.' });
  try {
    const { data, error } = await authClient().auth.signInWithPassword(values);
    if (error || !data.session || !data.user?.email_confirmed_at) return res.status(401).json({ error: 'Invalid email or password, or email not confirmed.' });
    return res.json({ session: data.session });
  } catch {
    return res.status(503).json({ error: 'Authentication service is unavailable.' });
  }
});
router.post('/forgot-password', recoveryRateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  try { if (email) await authClient().auth.resetPasswordForEmail(email, { redirectTo: authRedirectUrl(req) }); } catch { /* Keep the response non-enumerating. */ }
  return res.status(202).json({ message: 'If an account exists for that email, recovery instructions have been sent.' });
});
router.post('/logout', (_req, res) => res.status(204).end());

module.exports = router;
