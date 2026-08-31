# Supabase runtime database security

JLT uses Express as its only database boundary. The browser never receives a PostgreSQL connection string, a Supabase service-role key, or a Supabase Data API key.

`postgres` is retained exclusively for migrations, validation, recovery, and administrative work. The application uses `jlt_runtime`, a non-superuser login with no role-management, database-creation, replication, bypass-RLS, ownership, or migration-history privileges.

All application tables have RLS enabled and forced. `anon` and `authenticated` have no privileges on the `public` schema, its application tables, functions, or sequences; they have no policies. `jlt_runtime` has one explicit CRUD RLS policy per application table because the current product is single-user and authorization occurs at Express before queries run. The role receives only `SELECT`, `INSERT`, `UPDATE`, `DELETE`, sequence `USAGE`/`SELECT`, and schema `USAGE`.

This is deliberately not a browser-to-Supabase architecture. If JLT later exposes the Data API or a browser Supabase client, it must add a new reviewed RLS policy and grant for that specific route; no existing policy should be widened.

Use `npm run postgres:provision-runtime-role` with the admin/migration environment to create or rotate `jlt_runtime`. Rotation alters only its password and role attributes; it does not recreate the role or change ownership. Set its distinct secret in `POSTGRES_RUNTIME_PASSWORD` for application runtime. Keep the admin and runtime environment files separate and ignored by Git. The runtime refuses to start unless its explicit `POSTGRES_RUNTIME_*` credentials exist; only the isolated test harness may use a test fallback.
