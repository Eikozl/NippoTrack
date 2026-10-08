# Environment workflow

NippoTrack uses one application codebase with explicit runtime configuration. Authentication
behavior is identical in every environment; only the configured Supabase and PostgreSQL
targets change.

> Loader reference (verified by reading, never executing): every entry below names the
> exact file/loader that reads each env file. Process environment always wins over files.

## Loader → file matrix

| Loader | File(s) read | Keys consumed | Target |
| --- | --- | --- | --- |
| `server/src/config/postgres.js` | `POSTGRES_ENV_FILE` \|\| `server/.env.postgres` (relative to `server/` cwd) | `POSTGRES_HOST/PORT/USER/PASSWORD/DB`, `POSTGRES_SSL/SSL_CA`, `POSTGRES_TIMEZONE` | Migration/admin pool only. Local disposable admin target for `postgres:migrate` / `postgres:check`. Never the app runtime. |
| `server/src/config/runtimeEnvironment.js` (via `postgresRuntime.js`) | base `POSTGRES_ENV_FILE` \|\| `server/.env.postgres`, layered with runtime `POSTGRES_RUNTIME_ENV_FILE` \|\| `server/.env.runtime`; merge order base < runtime file < process env | `POSTGRES_RUNTIME_HOST/PORT/USER/PASSWORD/DB/SSL/SSL_CA/POOL_MAX`, `POSTGRES_TIMEZONE` | App runtime pool. Missing vars fall back to compiled Production defaults (Supavisor pooler) — development guards refuse to start there (see below). `POSTGRES_*` fallbacks apply ONLY in test mode (`NODE_ENV=test` + `JLT_AUTH_BYPASS_FOR_TESTS=true`). |
| `scripts/development-environment.js` (`selectDevelopmentServices`, used by `dev.js`) | plain dev: `server/.env.development`; `--integration`: `server/.env.integration` (injected as `POSTGRES_RUNTIME_ENV_FILE`) | Full runtime shape (`POSTGRES_RUNTIME_*`, `SUPABASE_URL/PUBLISHABLE_KEY/AUTH_REDIRECT_URL`, `PORT`) | Plain dev = local disposable target; integration = disposable Supabase Testing project. `dev.js` also reads the same file for its `PORT` health-check probe only. |
| `dev.js` client spawn | plain dev: bare `vite` (development mode); `--integration`: `vite --mode integration` | — | Selects which `client/.env.*` Vite loads (see next row). |
| Vite (+ `scripts/production-guard.js` `resolveClientSupabaseUrl`, mirroring Vite precedence `.env` < `.env.local` < `.env.{mode}` < `.env.{mode}.local` < process env) | dev mode: `client/.env.development.local`; integration mode: `client/.env.integration` | `VITE_SUPABASE_URL/PUBLISHABLE_KEY`, `VITE_API_BASE_URL` (integration only, `http://127.0.0.1:3101`) | Disposable Testing project on both; Auth invariant: frontend and backend MUST use the SAME Supabase project (cross-project JWTs never verify; `assertAlignedEnvironments` aborts on mismatch). |

## Local development

```powershell
npm.cmd run dev
```

Starts the API with `server/.env.development` and Vite in development mode
(`client/.env.development.local`). `npm run dev` never resolves to Production: a fail-closed
guard (`scripts/production-guard.js`, enforced in `dev.js`, `server/index.js`, and
`client/vite.config.js`) refuses development-mode startup when the resolved database/auth
identity matches the Production project ref, or when no Supabase identity is configured at
all (the compiled fallbacks point at Production, so unknown means unsafe).

## Isolated integration environment

```powershell
npm.cmd run dev:integration
```

Starts the API with `server/.env.integration` and Vite in `integration` mode
(`client/.env.integration`). The two files must target the same isolated Supabase project.
Do not use production accounts or credentials in either integration file.

## Naming mismatches (known, docs fixed here — files NOT renamed)

1. Old revisions of this doc claimed plain dev loads `client/.env.local`. **No such file
   exists.** The real file is `client/.env.development.local` (gitignored, overrides per-mode).
2. Old revisions claimed integration loads `client/.env.integration.local`. **No such file
   exists.** The real file is `client/.env.integration` (gitignored, includes `VITE_API_BASE_URL`).
3. The integration template lives at repo root (`integration.env.example`) but its target lives
   in `server/` (`server/.env.integration`). `docs/AUTOMATED_AUTH_AND_ISOLATION_TESTING.md`
   already documents this root→`server/` copy step; the template is NOT duplicated.

## Missing-keys list (documentation only — do NOT create new `.env` files)

Compared against the loaders above and the live gitignored files' key shapes (values never
listed here). Template owners should add these as **commented placeholders**:

- `server/.env.development.example` lacks: `SUPABASE_SECRET_KEY` (server-only, avatar
  storage — see `docs/VERCEL_APPLICATION_TOPOLOGY.md` correction note),
  `JLT_DECK_SHARE_SECRET` (present in the live dev file, absent from the template),
  `POSTGRES_RUNTIME_SSL_CA` (optional TLS CA override).
- `server/.env.postgres.example` lacks: `POSTGRES_SSL`, `POSTGRES_SSL_CA` (both read by
  `server/src/config/postgres.js` via `postgresSslConfig`).
- `integration.env.example` lacks vs the live `server/.env.integration` shape:
  `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` mirror lines, `PORT`,
  `SUPABASE_INTEGRATION_TEST_EMAIL` / `SUPABASE_INTEGRATION_TEST_PASSWORD`,
  `SUPABASE_INTEGRATION_PROJECT_REF`, `JLT_LOCAL_AUTH_BYPASS` / `JLT_LOCAL_AUTH_USER_ID`.

## Vercel workflow

Once the Vercel project is connected to GitHub:

1. Push a branch to create a Vercel Preview deployment.
2. Smoke-test the Preview URL (see `docs/VERCEL_PREVIEW_SMOKE.md`).
3. Merge the approved change through the agreed branch strategy to create a Production
   deployment (this doc previously said `master`; the current working branch is `dev` and
   `origin/HEAD` points at `master` with a `main` branch also present — confirm the release
   target with the release owner before promoting; see the smoke doc's branch-strategy note).

Vercel environment variables remain outside Git. Browser variables are limited to
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; migration credentials and
Supabase admin keys must never be added to the browser build. Server-runtime key policy
(including `SUPABASE_SECRET_KEY` for avatar storage) is clarified in
`docs/VERCEL_APPLICATION_TOPOLOGY.md` — pending runtime-owner confirmation.
