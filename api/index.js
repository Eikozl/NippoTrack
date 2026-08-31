// Vercel's /api function entrypoint. The Express app is exported without
// listening on a port so the serverless runtime owns the request lifecycle.
module.exports = require('../server/src/app');
