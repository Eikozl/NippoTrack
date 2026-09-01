# Environment workflow

JLT uses one application codebase with explicit runtime configuration. Authentication
behavior is identical in every environment; only the configured Supabase and PostgreSQL
targets change.

## Local development

Run the normal local environment with:

```powershell
npm.cmd run dev
```

It uses `client/.env.local` and `server/.env.runtime`. These ignored files target the
development Supabase project and must use matching `SUPABASE_URL` and publishable-key
values.

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
