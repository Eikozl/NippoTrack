# Account deletion — decided semantics (V6.2-B)

**Decision: keep `RESTRICT` on user-rooted learning data; deletion is an
app-owned ordered purge, never a bare `auth.users` delete.** No DDL change
ships with this decision. Rationale: silent `CASCADE` on learning rows
(vocabulary, kanji, sessions, reading progress…) would destroy study history
without a trace; `RESTRICT` forces the explicit order below and fails loudly
instead of half-wiping an account.

## What each family does today (verified against 001–044)

- **RESTRICT (blocks `auth.users` delete until purged):** vocabulary,
  kanji, grammar_points, study_sessions, goals, content_entries, notes,
  tags, reading_texts, user_reading_progress, immersion_sessions,
  kanji_encounters, review_sessions, weekly_insights, reading_study_days,
  shared references (jmdict).
- **CASCADE (vanish with the user once roots are gone):** user_profile,
  user_first_experience, user_jlpt_target, smart_goals,
  user_review_preferences, review_patterns, deck_publications (+ items via
  deck), deck_follows, deck_collections (+ links), deck_suggestions,
  reading_publications, user_follows, community_posts (+ likes, comments),
  notifications, content_reports, user_blocks, review/immersion session
  items, story_review_links.
- **SET NULL (attribution-preserving):** reading_texts.source_id,
  review_events.id_review_session, community_posts.deck_id/reading_id (044),
  notifications.actor_id, deck_suggestions.decided_by.
- **Storage (outside Postgres FKs):** `avatars/<userId>/avatar.jpg` must be
  removed via the Storage API (service key) — deleting the Auth user does
  NOT remove it. Always delete the object first.

## Ordered purge procedure (testing project only unless a prod runbook is approved)

1. Delete the avatar object (`avatars/<userId>/avatar.jpg`; ignore not-found).
2. Delete RESTRICT-owned rows in any order: vocabulary, kanji,
   grammar_points, study_sessions (+ link tables, which CASCADE from them),
   goals, content_entries, notes (+ links), tags (+ links), reading_texts,
   user_reading_progress, immersion_sessions, kanji_encounters,
   review_sessions, weekly_insights, reading_study_days.
3. Delete the `auth.users` row (dashboard). CASCADE/SET NULL complete the rest.
4. Verify with the orphan queries below (all must return 0).

## Orphan-report queries (read-only, run pre/post)

```sql
SELECT COUNT(*) FROM community_posts p
  LEFT JOIN deck_publications d ON d.id_deck_publication = p.deck_id
  WHERE p.deck_id IS NOT NULL AND d.id_deck_publication IS NULL;
SELECT COUNT(*) FROM community_posts p
  LEFT JOIN reading_publications t ON t.id_reading_publication = p.reading_id
  WHERE p.reading_id IS NOT NULL AND t.id_reading_publication IS NULL;
```

## Explicit non-goals

- No `CASCADE` migration for learning tables (one-way data-loss door).
- No self-service "delete my account" endpoint (does not exist; adding one
  is a V6.3 product decision, not a hardening task).
- No `CHECK` changes as part of this decision.
