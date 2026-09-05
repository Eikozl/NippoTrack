# Environment workflow

JLT uses one application codebase with explicit runtime configuration. Authentication
behavior is identical in every environment; only the configured Supabase and PostgreSQL
targets change.

## Local development

Run the normal local environment with:

```powershell
npm.cmd run dev
```

It starts the API with `server/.env.development` (safe local PostgreSQL;
see `server/.env.development.example`) and Vite with `client/.env.local`.
`npm run dev` never resolves to Production: a fail-closed guard
(`scripts/production-guard.js`, enforced in `dev.js` and `server/index.js`)
refuses development-mode startup when the resolved database/auth identity
matches the Production project. The local database only has the legacy
baseline schema, so features needing Supabase-auth migrations (Phase 11+)
require the integration workflow below.

## Production safety

- `npm.cmd run dev` = safe local workflow (local PostgreSQL).
- `npm.cmd run dev:integration` = disposable Supabase-compatible workflow.
- Production must never be used for normal smoke testing.
- Auth invariant: for any non-Production workflow the frontend and backend
  must use the SAME Supabase project (cross-project JWTs never verify).
  Plain dev uses `server/.env.development` (backend) plus
  `client/.env.development.local` (frontend, overrides `client/.env.local`
  in development mode); both point at the disposable project.
- `server/.env.runtime` is no longer loaded by `npm run dev`. If a legacy
  `.env.runtime` file points at Production, development startup aborts with
  "Refusing to start development server against Production" instead of
  connecting. The Vite config (`client/vite.config.js`) and the root
  launcher (`dev.js`) enforce the same fail-closed rule for the frontend
  Supabase URL and for frontend/backend project mismatch. Intentional
  production startup is `NODE_ENV=production`
  with explicit production configuration (Vercel deployments use
  `api/index.js` with platform environment variables and are unaffected
  by the development guard).

## Isolated integration environment

Run the disposable integration environment with:

```powershell
npm.cmd run dev:integration
```

The command starts the API with `server/.env.integration` and starts Vite in
`integration` mode, which loads `client/.env.integration.local`. The two files must
target the same isolated Supabase project. Do not use production accounts or credentials
in either integration file.

## Vercel workflow

Once the Vercel project is connected to GitHub:

1. Push a branch to create a Vercel Preview deployment.
2. Smoke-test the Preview URL.
3. Merge or push the approved change to `master` to create a Production deployment.

Vercel environment variables remain outside Git. Browser variables are limited to
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; migration credentials and
Supabase admin keys must never be added to Vercel.
