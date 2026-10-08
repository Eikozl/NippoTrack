# NippoTrack

NippoTrack is a web app for recording Japanese study and review activity.

## Quickstart

Requires Node.js `^20.19.0 || >=22.12.0` (see root `package.json` `engines`).
All commands below are root `package.json` scripts — verified to exist, no guessing.

```powershell
npm.cmd run install:all        # install root + server + client (uses committed lockfiles)
npm.cmd run dev                # local disposable stack: API (server/.env.development) + Vite
npm.cmd run dev:integration    # disposable Supabase Testing stack (server/.env.integration)
npm.cmd run build              # production frontend build (client/dist)
npm.cmd run test               # backend test suite (server, uses server/.env.test)
```

More workflows (same `npm.cmd run <script>` pattern):

```powershell
npm.cmd run dev:server         # API only (nodemon)
npm.cmd run dev:client         # Vite only
npm.cmd run start:server       # API in production-like mode (local checks)
npm.cmd run db:check           # legacy MariaDB connectivity probe (see scripts/README.md)
npm.cmd run test:postgres-runtime        # Postgres runtime pool tests
npm.cmd run test:auth-flows              # Supabase auth-flow tests (disposable project)
npm.cmd run test:multi-user-isolation    # multi-user isolation tests (disposable project)
npm.cmd run supabase:start     # local Supabase CLI stack
npm.cmd run supabase:stop      # stop local Supabase CLI stack
npm.cmd run audit              # high-severity audit of server + client dependencies
```

## Environment files

Real credential files are gitignored; only `*.example` templates are committed.
Start here:

- Workflow, loader→file matrix, and naming mismatches: [`docs/ENVIRONMENT_WORKFLOW.md`](docs/ENVIRONMENT_WORKFLOW.md)
- Server templates: `server/.env.development.example`, `server/.env.postgres.example`
- Integration template (repo root → copy to `server/.env.integration`):
  `integration.env.example` (see [`docs/AUTOMATED_AUTH_AND_ISOLATION_TESTING.md`](docs/AUTOMATED_AUTH_AND_ISOLATION_TESTING.md))
- `npm run dev` never resolves to Production: `scripts/production-guard.js` refuses
  development-mode startup against the Production project (frontend/backend Auth projects
  must also match — cross-project JWTs never verify).

## Preview / Production

- Deployment topology (Vercel functions, SPA fallback, env-var policy):
  [`docs/VERCEL_APPLICATION_TOPOLOGY.md`](docs/VERCEL_APPLICATION_TOPOLOGY.md)
- Preview smoke procedure (health → auth/session → protected → static → rollback):
  [`docs/VERCEL_PREVIEW_SMOKE.md`](docs/VERCEL_PREVIEW_SMOKE.md)
- Archived audits and superseded plans: [`docs/archive/`](docs/archive/)

## Repo layout

- `client/` — Vite browser app (builds to `client/dist`)
- `server/` — Express API (`server/src/app`, Vercel entrypoints in `api/`)
- `scripts/` — root launchers and guards (`dev.js`, `scripts/production-guard.js`)
- `server/scripts/` — DB and import tooling (see [`scripts/README.md`](scripts/README.md))
- `docs/` — workflows, audits, topology; `docs/archive/` holds superseded docs
- `supabase/` — local CLI / migration support files

## Data Sources / Attribution

Kanji dictionary data is provided in part by KANJIDIC2 (EDRDG). JLPT reference data is provided in part by OpenJLPT and its documented upstream sources. See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for attribution and licensing details. JLPT classifications are community/reference data, not an official JLPT syllabus.
