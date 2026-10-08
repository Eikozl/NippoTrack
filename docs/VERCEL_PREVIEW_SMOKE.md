# Vercel Preview smoke procedure

Short, ordered, no implementation. Run against the Preview URL after every Preview deployment;
promote to Production only when all steps pass. Rollback is always "redeploy the previous
Production deployment" in the Vercel dashboard — no code, migration, or env change.

## Steps

1. **Build** — confirm the Preview deployment built with `npm --prefix client run build`
   (per `vercel.json` `buildCommand`) and serves `client/dist`. A failed build stops here.
2. **`/api/health`** — `GET <preview>/api/health` returns 2xx. Proves the serverless API
   entrypoint boots and the runtime Postgres/auth wiring resolves.
3. **Auth/session** — exercise the session endpoint flow (sign-in against the Preview-wired
   Supabase project, then the session/me read). Expect an authenticated identity; a
   cross-project token (frontend vs backend on different Supabase projects) failing here
   means the Preview env vars are misaligned, not that Auth is broken.
4. **Protected 401/404** — unauthenticated `GET` on a protected route returns 401; an
   authenticated `GET` on a nonexistent owned record returns 404. Proves authorization
   middleware and ownership scoping run in the serverless topology (not just locally).
5. **Static fallback** — `GET <preview>/some/client/route` returns the SPA (`index.html`,
   200) while `GET <preview>/api/health` still returns JSON. Proves the final rewrite only
   catches non-API paths (functions and static files resolve before the fallback).
6. **Rollback** — if any step fails, redeploy the previous Production deployment from the
   Vercel dashboard. Do not push a "fix forward" to Production; fix on the branch, get a
   green Preview, then promote.

## Companion notes (prose only — no implementation in this pass)

- **Dual `api/*.js` entrypoint.** `api/index.js` (query-param adapter restoring the Express
  path) and `api/[...path].js` (direct catch-all export) both exist, and `vercel.json`
  rewrites `/api/:path*` to `/api?__jlt_path=:path*`. Proposal: converge on a single
  entrypoint (keep the adapter or the catch-all, not both) so only one path-rewriting
  contract can drift. Not implemented here — runtime-owner decision.
- **`kuromoji` `includeFiles` risk.** `vercel.json` bundles
  `server/node_modules/@sglkc/kuromoji/dict/*.dat.gz` into every `api/*.js` function. If the
  dictionary grows or the glob misses (renamed package path, pruned files), cold starts bloat
  or tokenization 500s. Watch function size in the dashboard; consider lazy-loading or
  narrowing the include to the tokenizer actually used.
- **`maxDuration: 60` plan gate.** `vercel.json` sets `maxDuration: 60` on `api/*.js`. Sixty
  seconds requires a paid plan on Vercel — on Hobby the setting is rejected or capped
  (typically 10s). Confirm the plan before relying on long imports/MECAB-adjacent work in
  functions; otherwise budget serverless work under the Hobby ceiling.
- **Branch-strategy staleness (`dev` vs `master`).** Active work is on branch `dev`;
  `origin/HEAD` points at `master` and a `main` branch also exists, while older docs say
  "merge to `master` for Production". Until the release owner names the canonical release
  branch, treat any "merge to X creates Production" sentence as suspect and confirm the
  Vercel production-branch setting before promoting.
