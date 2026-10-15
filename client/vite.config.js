import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { assertSafeClientEnvironment } = require('../scripts/production-guard.js');
const clientDir = dirname(fileURLToPath(import.meta.url));
const clientPackage = require('./package.json');

export default defineConfig(({ mode }) => {
  // Fail closed: a non-production Vite mode must never resolve Supabase Auth
  // to the Production project (the client's compiled fallback is Production,
  // and client/.env.local overrides general development files).
  assertSafeClientEnvironment({ mode, clientDir, env: process.env });

  return {
    plugins: [tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || clientPackage.version || 'dev')
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': 'http://127.0.0.1:3000'
      }
    }
  };
});
