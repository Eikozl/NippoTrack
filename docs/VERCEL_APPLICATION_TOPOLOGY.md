# Vercel application topology

## Scope

This document prepares JLT for a future Vercel deployment. It does not create a Vercel project, configure Vercel environment variables, set Supabase production redirect URLs, or deploy the application.

## Runtime shape

- Vite builds the browser application into `client/dist`.
- `api/index.js` exports the existing Express application for `/api`.
- `api/[...path].js` exports that same Express application for `/api/*`, preserving the path that Express routes and authorization middleware receive.
- `vercel.json` supplies a final SPA rewrite to `/index.html`; Vercel resolves functions and static files before this fallback.
- The browser uses its existing relative `/api/*` requests. `VITE_API_BASE_URL` must be unset or empty for the deployed same-origin topology.
- The serverless entrypoints export the Express application. They never call `listen()`, start Vite, or start Nodemon.

Vercel documents Node functions under `/api`, Express application exports, and SPA rewrites in its official documentation:

- https://vercel.com/docs/functions/runtimes/node-js
- https://vercel.com/docs/frameworks/backend/express
- https://vercel.com/docs/frameworks/frontend/vite
- https://vercel.com/docs/routing/rewrites

## Reproducible install and build

The Vercel configuration and the root `install:all` script use the committed lockfiles:

```powershell
npm.cmd run install:all
npm.cmd run build
```

The production build is only `npm --prefix client run build`. The root `start` command launches only the Express server for local production-like API checks; Vercel invokes the exported functions and does not use a long-lived Node process.

## Future Vercel environment variables

Set these only in Vercel project settings when deployment is explicitly approved:

| Purpose | Variables |
| --- | --- |
| Express authentication | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_AUTH_REDIRECT_URL` |
| Runtime PostgreSQL role | `POSTGRES_RUNTIME_HOST` (Supavisor transaction pooler), `POSTGRES_RUNTIME_PORT=6543`, `POSTGRES_RUNTIME_USER`, `POSTGRES_RUNTIME_PASSWORD`, `POSTGRES_RUNTIME_DB`, `POSTGRES_RUNTIME_SSL=verify-full`, `POSTGRES_RUNTIME_SSL_CA`, `POSTGRES_RUNTIME_POOL_MAX=2`, `POSTGRES_TIMEZONE=America/Santo_Domingo` |
| Browser Supabase client | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |

Never set migration credentials, Supabase secret/service-role keys, SMTP credentials, or `SUPABASE_INTEGRATION_SECRET_KEY` in the browser build or the Vercel runtime.

## Deferred production decisions

- Production site URL, Auth redirect URLs, confirmation URLs, recovery URLs, and SMTP configuration must wait for the approved Vercel domain/preview topology.
- D3 will re-audit CSP and the same-origin CORS policy after the topology is exercised in a Vercel preview.
