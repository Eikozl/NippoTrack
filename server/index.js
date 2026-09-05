const path = require('node:path');
const { assertSafeDevelopmentEnvironment } = require('../scripts/production-guard');

const app = require('./src/app');

// Fail closed for development entry only: refuse to listen when the
// resolved database/auth identity is Production (or unconfigured, since
// the compiled fallbacks point at Production). Explicit production
// startup (NODE_ENV=production) is never blocked, and Vercel never
// executes this file (it uses api/index.js), so deployments are
// unaffected.
assertSafeDevelopmentEnvironment({
  env: process.env,
  serverDir: __dirname,
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development'
});

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`JLT API listening on http://localhost:${port}`);
});
