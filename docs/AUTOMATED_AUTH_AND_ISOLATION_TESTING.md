# Automated Auth and Multi-user Isolation Testing

## Boundaries

- Use a disposable Supabase integration project or the local Supabase stack only.
- Never point destructive tests at the existing JLT Supabase DEV project or a future production project.
- `SUPABASE_INTEGRATION_SECRET_KEY` is an Auth-admin test secret. It is used only by the integration harness, never by JLT's browser or Express runtime.
- The application still reads and writes learning data only through Express and `jlt_runtime`.

## Automated two-user harness

`server/scripts/test-multi-user-isolation.js` creates two confirmed users via Supabase Auth Admin, signs each in using the publishable key, exercises the API, then deletes the temporary records and users in `finally`.

It verifies:

- per-user uniqueness for the same vocabulary value;
- list/search isolation;
- foreign read, update, and delete attempts return `404`;
- session-to-foreign-vocabulary and note-to-foreign-vocabulary links return `400`;
- an export contains no rows owned by the other user.

Create an ignored `server/.env.integration` from `integration.env.example`, using credentials for a dedicated integration target. Then run:

```powershell
$env:INTEGRATION_TEST_ENV_FILE = '.env.integration'
npm.cmd run postgres:test-multi-user-isolation
```

The explicit `JLT_ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true` guard is mandatory. It prevents accidental execution without acknowledging temporary Auth-user creation/deletion.

## CI

The `multi-user-integration` GitHub Actions job runs only when the following repository secrets are configured for the dedicated integration target:

- `SUPABASE_INTEGRATION_URL`
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

Before running JLT against the local stack, apply the existing PostgreSQL baseline/migrations and provision `jlt_runtime` on that **local** database only. Never use `supabase db reset --linked` against JLT DEV or production.

## Production SMTP

Production SMTP remains deliberately unconfigured. Add it only later through Supabase project settings with credentials outside Git and production-specific redirect URLs. The local mail catcher is development-only.
