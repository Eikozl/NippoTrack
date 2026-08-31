# Supabase runtime database security

JLT uses Express as its only database boundary. The browser never receives a PostgreSQL connection string, a Supabase service-role key, or a Supabase Data API key.

`postgres` is retained exclusively for migrations, validation, recovery, and administrative work. The application uses `jlt_runtime`, a non-superuser login with no role-management, database-creation, replication, bypass-RLS, ownership, or migration-history privileges.

All application tables have RLS enabled and forced. `anon` and `authenticated` have no privileges on the `public` schema, its application tables, functions, or sequences; they have no policies. `jlt_runtime` has one explicit CRUD RLS policy per application table because the current product is single-user and authorization occurs at Express before queries run. The role receives only `SELECT`, `INSERT`, `UPDATE`, `DELETE`, sequence `USAGE`/`SELECT`, and schema `USAGE`.

This is deliberately not a browser-to-Supabase architecture. If JLT later exposes the Data API or a browser Supabase client, it must add a new reviewed RLS policy and grant for that specific route; no existing policy should be widened.

Use `npm run postgres:provision-runtime-role` with the admin/migration environment to create or rotate `jlt_runtime`. Rotation alters only its password and role attributes; it does not recreate the role or change ownership. Set its distinct secret in `POSTGRES_RUNTIME_PASSWORD` for application runtime. Keep the admin and runtime environment files separate and ignored by Git. The runtime refuses to start unless its explicit `POSTGRES_RUNTIME_*` credentials exist; only the isolated test harness may use a test fallback.

## Serverless runtime connection

Vercel must connect as `jlt_runtime` through Supavisor's **transaction pooler** on port `6543`, not through the direct database connection or the persistent session pooler. The runtime is intentionally limited to a small `POSTGRES_RUNTIME_POOL_MAX=2` because serverless instances can scale independently. JLT issues only unnamed, parameterized queries and explicit transactions; it does not rely on session-pinned state, temporary tables, or prepared statements.

TLS is mandatory. Production and CI set `POSTGRES_RUNTIME_SSL=verify-full` and supply the database CA certificate through `POSTGRES_RUNTIME_SSL_CA`; Node.js then verifies the certificate chain rather than disabling verification. The certificate is configuration, not source code: never commit it or print it in logs. The role-level `America/Santo_Domingo` setting and each connection's startup option retain the application's date behavior without executing `SET TIME ZONE` after checkout, which is unsafe with transaction pooling.

The separate migration/admin client also verifies TLS. It uses its own `POSTGRES_SSL_CA` when `POSTGRES_SSL=verify-full`; it must never share application runtime credentials.

GitHub Actions only runs the disposable Supabase integration job after `POSTGRES_RUNTIME_SSL_CA` is configured as a repository secret. Configure the same CA secret as a Vercel encrypted environment variable only after deployment approval.

Supabase documents transaction pooling for serverless connections and recommends verified TLS when SSL enforcement is enabled:

- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/platform/ssl-enforcement
