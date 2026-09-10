# Multi-user phase status

## Completed

- Supabase Auth is the sole authentication provider for sign-up, email/password sign-in, session restoration, sign-out, verification-gated access, password recovery, and password update.
- Express verifies Supabase bearer tokens and derives `req.user.id` server-side for private API access.
- Existing NippoTrack data was safely assigned to the confirmed owner without committing the owner UUID.
- Eight roots have required `user_id` FKs to `auth.users(id)`: vocabulary, kanji, grammar points, study sessions, goals, content entries, notes, and tags.
- Kanji, grammar points, and tags use per-user uniqueness. Ownership indexes are in place.
- Searches, lists, writes, dashboard/activity, review, links, and export scope data to the verified user.
- Cross-user relation targets are rejected inside their write transactions.
- The former custom single-password session implementation and obsolete environment variables were removed.
- Supabase runtime security verification passes: 25 forced-RLS tables, 25 runtime CRUD policies, and no unexpected grants or role privileges.
- Ownership verification passes: no null root ownership and no cross-user junction rows.
- Migration runner is idempotent.
- Phase 11 live isolation validation passed against the disposable `NippoTrack testing` Supabase project. It verified per-user uniqueness, search, dashboard/statistics, and export isolation, safe foreign read/update/delete behavior, and cross-user session/note relationship rejection. The harness uses only ephemeral Auth users and test records.
- Phase 12 automated Auth validation passed against `NippoTrack testing`: unconfirmed sign-in is blocked, confirmation enables private API access, recovery updates the password, the old password is rejected, and reused or invalid recovery tokens fail safely.
- A real `NippoTrack testing` signup email was delivered through the dedicated custom SMTP configuration. Its confirmation redirect established a valid session and opened the private dashboard; the ephemeral user was deleted after verification.
- The final Supabase project also delivered a real recovery email through its separate custom SMTP configuration, and the password update completed successfully. SMTP credentials remain outside Git.
- Browser bearer authentication now passes CORS preflight from the local Vite origin, with a regression test covering the `Authorization` header.
- Regression suite: 50 passing; the one explicit real-PostgreSQL test remains skipped in the isolated unit command and passed when explicitly enabled against `NippoTrack testing`.
- The authenticated PostgreSQL/Supabase runtime test passed against `NippoTrack testing`. It validates Japanese UTF-8, romaji search, transactional vocabulary/example creation, session relationships, America/Santo_Domingo dates, dashboard totals, and export output using an ephemeral confirmed user.
- Final Phase 15 checks passed: Auth flows, two-user isolation, runtime integration, ownership verification, runtime security verification (25 forced-RLS tables and policies), migration idempotency (`0 applied`, `5 skipped`), API runtime checks, and the production client build.

## Result

The multi-user authentication gate is complete. No Vercel configuration or deployment work has been started.

READY TO RESUME DEPLOYMENT HARDENING
