# Automated Auth and Multi-user Isolation Testing

## Boundaries

- Use a disposable Supabase integration project or the local Supabase stack only.
- Never point destructive tests at the existing NippoTrack Supabase DEV project or a future production project.
- `SUPABASE_INTEGRATION_SECRET_KEY` is an Auth-admin test secret. It is used only by the integration harness, never by NippoTrack's browser or Express runtime.
- The application still reads and writes learning data only through Express and `jlt_runtime`.

## Automated two-user harness

`server/scripts/test-multi-user-isolation.js` creates two confirmed users via Supabase Auth Admin, signs each in using the publishable key, exercises the API, then deletes the temporary records and users in `finally`.

It verifies:

- per-user uniqueness for the same vocabulary value;
- list/search isolation;
- foreign read, update, and delete attempts return `404`;
- session-to-foreign-vocabulary and note-to-foreign-vocabulary links return `400`;
- an export contains no rows owned by the other user.
- dashboard minutes and recent sessions remain private to their owner.

Create an ignored `server/.env.integration` from `integration.env.example`, using credentials for a dedicated integration target. Then run:

```powershell
$env:INTEGRATION_TEST_ENV_FILE = '.env.integration'
npm.cmd run postgres:test-multi-user-isolation
```

The explicit `JLT_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true` guard is mandatory. It prevents accidental execution without acknowledging temporary Auth-user creation/deletion.

## Authenticated PostgreSQL runtime harness

The real PostgreSQL runtime test creates a confirmed ephemeral Auth user and validates the Express/runtime path without relying on fixed rows from the former single-user database. It covers Japanese text, romaji search, transactional vocabulary/example creation, session relationships, Santo Domingo dates, dashboard totals, and export output. Run it only against the same disposable target:

```powershell
$env:INTEGRATION_TEST_ENV_FILE = '.env.integration'
$env:JLT_RUN_POSTGRES_INTEGRATION = 'true'
npm.cmd run postgres:test-runtime
```

`SUPABASE_INTEGRATION_PROJECT_REF` must match the Supabase URL and appear in either the PostgreSQL pooler host or its pooler username, preventing the Auth admin cleanup flow from running against a different database accidentally.

## Automated confirmation and recovery harness

The same disposable target can validate Supabase Auth confirmation and recovery without a second mailbox:

```powershell
$env:INTEGRATION_TEST_ENV_FILE = '.env.integration'
npm.cmd run postgres:test-auth-flows
```

It creates and deletes temporary Auth users, verifies that an unconfirmed user cannot sign in, consumes a generated Supabase confirmation token, verifies private API access after confirmation, verifies the non-enumerating recovery response, replaces a password through a recovery token, and rejects reused or invalid recovery tokens. `generateLink` is an Auth-admin test mechanism; it does not prove external mailbox delivery. Confirmation/recovery email delivery and production redirect URLs remain a separate production-readiness check requiring a configured test mailbox/SMTP.

## CI

The `multi-user-integration` GitHub Actions job runs the authentication, two-user isolation, and authenticated PostgreSQL runtime harnesses only when the following repository secrets are configured for the dedicated integration target:

- `SUPABASE_INTEGRATION_URL`
- `SUPABASE_INTEGRATION_PROJECT_REF`
- `SUPABASE_INTEGRATION_PUBLISHABLE_KEY`
- `SUPABASE_INTEGRATION_SECRET_KEY`
- `SUPABASE_AUTH_REDIRECT_URL`
- `POSTGRES_RUNTIME_HOST`, `POSTGRES_RUNTIME_PORT`, `POSTGRES_RUNTIME_USER`, `POSTGRES_RUNTIME_PASSWORD`, `POSTGRES_RUNTIME_DB`

The normal test/build job does not receive these secrets.

## Local auth email testing

The committed [supabase/config.toml](../supabase/config.toml) enables the local mail catcher. After Docker Desktop is running, use:

```powershell
npm.cmd run supabase:start
```

The local stack captures Auth emails rather than sending them externally. Its Mailpit inbox is available on `http://127.0.0.1:54324`, letting you verify confirmation and recovery messages without creating real mailboxes. Supabase documents local email capture through Mailpit and reserves production email for a configured SMTP provider. [Supabase local email testing](https://supabase.com/docs/guides/local-development/cli/testing-and-linting)

Before running NippoTrack against the local stack, apply the existing PostgreSQL baseline/migrations and provision `jlt_runtime` on that **local** database only. Never use `supabase db reset --linked` against NippoTrack DEV or production.

## Production SMTP

Production SMTP remains deliberately unconfigured. Add it only later through Supabase project settings with credentials outside Git and production-specific redirect URLs. The local mail catcher is development-only.
