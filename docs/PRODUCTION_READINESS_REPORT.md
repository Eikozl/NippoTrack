# NippoTrack production-readiness report

Audit date: 2026-08-31
Scope: deployment hardening after the completed multi-user conversion. No Vercel project, production deployment, domain, or production Supabase setting was changed during this audit.

## Completed deployment safeguards

- The Vercel topology builds the Vite application and exports Express from `/api` without starting Vite, Nodemon, or a long-lived listener.
- The browser uses same-origin `/api/*` requests in production. Local Vite origins are explicitly allowlisted; private API CORS never uses `*`.
- Helmet keeps a CSP without `unsafe-inline`. The early theme bootstrap is now the static, same-origin `/theme-init.js` file.
- Supabase runtime access uses `jlt_runtime` through the transaction pooler on port `6543`, a maximum pool size of `2`, verified TLS, and the `America/Santo_Domingo` startup setting.
- Admin/migration and runtime credentials remain separate. The runtime fails closed when explicit runtime credentials are absent.
- CI runs isolated backend tests, the production frontend build, a high-severity runtime dependency audit, and conditionally runs the disposable Supabase Testing harness only when all required testing secrets are present.
- Dialogs now trap keyboard focus and restore focus to their invoking control when closed.

## Evidence collected

| Check | Result |
| --- | --- |
| Local regression suite | 52 passed, 1 intentionally skipped external-runtime test |
| Production frontend build | Passed |
| Runtime dependency audit | 0 high-severity runtime vulnerabilities in server and client |
| Supabase Testing runtime test | Passed with verified TLS, transaction pooler, authenticated API, transactions, Japanese/romaji behavior, dates and export |
| Runtime role/RLS verifier | Passed: 25 tables, 25 policies, forced RLS, 11 triggers, no failures |
| Multi-user ownership verifier | Passed: required ownership migrations present, no null root owners, no cross-user junction rows |
| PostgreSQL migration runner | Passed idempotently: 0 applied, 5 skipped |

## Deliberately deferred minor work

- The dark-mode logo, favicon, and main JavaScript chunk remain larger than ideal. They are a performance improvement opportunity, not a functional or security blocker for this deployment gate.
- No new UI redesign, product feature, database model change, or observability platform was added.

## Required manual deployment setup

Before deployment approval, the project owner must configure these values in the relevant services. Do not place any of them in Git:

1. In GitHub, add the Testing CA certificate as `POSTGRES_RUNTIME_SSL_CA` so the conditional Supabase integration job can run.
2. Once a Vercel project and site URL are explicitly approved, add its encrypted runtime variables: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_AUTH_REDIRECT_URL`, `POSTGRES_RUNTIME_HOST`, `POSTGRES_RUNTIME_PORT=6543`, `POSTGRES_RUNTIME_USER`, `POSTGRES_RUNTIME_PASSWORD`, `POSTGRES_RUNTIME_DB`, `POSTGRES_RUNTIME_SSL=verify-full`, `POSTGRES_RUNTIME_SSL_CA`, `POSTGRES_RUNTIME_POOL_MAX=2`, and `POSTGRES_TIMEZONE=America/Santo_Domingo`.
3. Configure the browser-only Vercel build variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Do not add a database credential or Supabase secret/service key to browser variables.
4. Configure Supabase Auth site URL and allowed confirmation/recovery redirects for the actual Vercel preview and production URLs, then run the documented preview smoke test.

Supabase recommends its transaction pooler for serverless workloads and verified TLS with SSL enforcement:

- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/platform/ssl-enforcement

## Conclusion

NOT READY FOR VERCEL DEPLOYMENT

The remaining blockers are deployment configuration and the required preview smoke test, not an unresolved application, database, TLS, authentication, or CI code defect. After those external settings are configured and explicitly approved, the deployment phase can begin without further product work.
