const { COOKIE_NAME, cookieOptions, createSession, passwordMatches, readSession } = require('../auth/session');

function requireAuthentication(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Authentication is required.' });
  req.auth = session;
  return next();
}

function sessionStatus(req, res) {
  return res.json({ authenticated: Boolean(readSession(req)) });
}

function login(req, res) {
  if (!passwordMatches(req.body?.password)) return res.status(401).json({ error: 'Invalid password.' });
  res.cookie(COOKIE_NAME, createSession(), cookieOptions());
  return res.status(204).end();
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
  return res.status(204).end();
}

module.exports = { login, logout, requireAuthentication, sessionStatus };
