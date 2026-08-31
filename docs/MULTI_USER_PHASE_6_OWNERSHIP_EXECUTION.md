# Multi-user ownership migration — execution record

## Completed database work

- A fresh logical backup of the Supabase development database was written to the ignored `backups/` directory before schema work.
- `004_multi_user_ownership_stage_1.sql` added nullable `user_id uuid` foreign keys to `auth.users(id)` on the eight personal-data roots.
- The verified, confirmed existing owner was assigned through `JLT_OWNER_AUTH_USER_ID` at execution time. The UUID is not in source control or documentation.
- The parameterized backfill rejected any pre-existing foreign owner and validated no root retained a null owner before commit.
- `005_multi_user_ownership_stage_2.sql` made ownership required, replaced global kanji/grammar/tag uniqueness with user-scoped uniqueness, and added ownership indexes.

## Verified Supabase DEV state

- Both ownership migrations are present in `schema_migrations`.
- All eight roots have a non-null `user_id` FK to `auth.users(id)`.
- Existing root row counts were retained: vocabulary 41, kanji 47, grammar 9, study sessions 13, goals 2, content entries 1, notes 1, tags 0.
- All 13 junction types have zero cross-user rows.
- The existing runtime hardening still passes: 25 forced-RLS application tables, 25 `jlt_runtime_crud` policies, and no security-audit failures.

## Runtime isolation implementation

The verified `req.user.id` now scopes root lists, searches, details, writes, dashboard/activity data, goals and progress, review lookup/recording, content/notes/tags, links, and exports. Child resources are reached only through an owned root. Relationship replacement verifies every target belongs to the caller within its transaction. A foreign resource returns `404` rather than confirming its existence.

## Required integration-test environment (not committed)

Create two distinct, confirmed Supabase Auth test accounts and provide either an access token for each or email/password credentials only in an ignored local file such as `server/.env.multi-user-test`:

```bash
NODE_ENV=integration
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
JLT_MULTI_USER_TEST_A_EMAIL=...
JLT_MULTI_USER_TEST_A_PASSWORD=...
JLT_MULTI_USER_TEST_B_EMAIL=...
JLT_MULTI_USER_TEST_B_PASSWORD=...
```

Then run `$env:MULTI_USER_TEST_ENV_FILE='.env.multi-user-test'; npm.cmd run postgres:test-multi-user-isolation` from `server/`. The script creates temporary records through the Express API, verifies isolation and cross-user relationship rejection, and deletes its records in `finally`.
