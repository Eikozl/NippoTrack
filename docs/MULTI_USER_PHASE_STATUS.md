# Multi-user phase status

## Completed

- Supabase Auth is the sole authentication provider for sign-up, email/password sign-in, session restoration, sign-out, verification-gated access, password recovery, and password update.
- Express verifies Supabase bearer tokens and derives `req.user.id` server-side for private API access.
- Existing JLT data was safely assigned to the confirmed owner without committing the owner UUID.
- Eight roots have required `user_id` FKs to `auth.users(id)`: vocabulary, kanji, grammar points, study sessions, goals, content entries, notes, and tags.
- Kanji, grammar points, and tags use per-user uniqueness. Ownership indexes are in place.
- Searches, lists, writes, dashboard/activity, review, links, and export scope data to the verified user.
- Cross-user relation targets are rejected inside their write transactions.
- The former custom single-password session implementation and obsolete environment variables were removed.
- Supabase runtime security verification passes: 25 forced-RLS tables, 25 runtime CRUD policies, and no unexpected grants or role privileges.
- Ownership verification passes: no null root ownership and no cross-user junction rows.
- Migration runner is idempotent.
- Regression suite: 49 passing, 1 explicit real-PostgreSQL integration test skipped unless its dedicated integration environment is supplied.
- Production client build passes.

## Deferred external validation

The two-user live isolation harness is intentionally deferred at the owner's request. It requires two confirmed Supabase Auth test accounts and verifies real authenticated API behavior (foreign read/write/delete, cross-user links, export isolation, and per-user uniqueness). The harness and instructions are ready in `server/scripts/test-multi-user-isolation.js` and `MULTI_USER_PHASE_6_OWNERSHIP_EXECUTION.md`.

## Remaining blockers before deployment hardening may resume

1. Execute the two-user live isolation harness successfully.
2. Verify a real sign-up confirmation email and that an unverified account cannot access private data.
3. Verify a real password-recovery email, redirect, password update, and expired-link behavior.
4. Configure and validate a non-test SMTP provider before production; its credentials and production redirect URLs must remain outside Git.
5. Run the explicitly configured real PostgreSQL/Supabase integration test environment.

No Vercel configuration or deployment work has been started.

NOT READY TO RESUME DEPLOYMENT HARDENING
