const { verifiedUserFromRequest } = require('../auth/supabase');

async function requireAuthentication(req, res, next) {
  try {
    const user = await verifiedUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Authentication is required.' });
    if (!user.email_confirmed_at) return res.status(403).json({ error: 'Please verify your email before accessing NippoTrack.', code: 'EMAIL_UNVERIFIED' });
    req.user = { id: user.id, email: user.email };
    return next();
  } catch {
    return res.status(503).json({ error: 'Authentication service is unavailable.' });
  }
}

async function sessionStatus(req, res) {
  try {
    const user = await verifiedUserFromRequest(req);
    return res.json({ authenticated: Boolean(user?.email_confirmed_at), emailVerified: Boolean(user?.email_confirmed_at), user: user?.email_confirmed_at ? { id: user.id, email: user.email } : null });
  } catch {
    return res.status(503).json({ error: 'Authentication service is unavailable.' });
  }
}

module.exports = { requireAuthentication, sessionStatus };
