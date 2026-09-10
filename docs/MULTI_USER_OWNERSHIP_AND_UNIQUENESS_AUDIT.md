# Multi-user ownership and uniqueness audit

Status: design audit only. No schema, data, Supabase Auth, or application query was changed while producing this document.

## Scope and decision

NippoTrack has 25 application tables (excluding `schema_migrations`). None is a global/shared product entity: vocabulary, kanji, grammar, tags, and all learning records are personal study data. Ownership is therefore modelled by a direct `user_id uuid` only on the eight user-owned roots below. All children and junction rows derive ownership through their existing foreign keys. This avoids redundant ownership columns and makes relationship validation explicit.

| Table | Class | Direct `user_id` | Ownership path | Existing FK / unique and index facts | Query files / dependencies |
| --- | --- | --- | --- | --- | --- |
| `vocabulary` | A root | Yes | `vocabulary.user_id` | PK `id_vocabulary`; non-unique `word`; indexes `jlpt_level`, `status`, `word` | `vocabularyController`, `sessionsController`, `kanjiController`, `reviewController`, `dashboardController`, `exportController`, `v2Controller`, `helpers`; search, dashboard, goals, review, export |
| `kanji` | A root | Yes | `kanji.user_id` | PK; globally unique `character_kanji` **must become** `(user_id, character_kanji)`; JLPT/status indexes | `kanjiController`, `vocabularyController`, `sessionsController`, `reviewController`, `dashboardController`, `exportController`, `v2Controller`, `helpers`; search, dashboard, goals, review, export |
| `grammar_points` | A root | Yes | `grammar_points.user_id` | PK; globally unique `grammar_point` **must become** `(user_id, grammar_point)`; JLPT/status indexes | `grammarController`, `sessionsController`, `reviewController`, `dashboardController`, `exportController`, `v2Controller`, `helpers`; search, dashboard, goals, review, export |
| `study_sessions` | A root | Yes | `study_sessions.user_id` | PK; date/category indexes | `sessionsController`, `dashboardController`, `exportController`, `v2Controller`, `helpers`; calendar, streak, dashboard, statistics, goals, links, export |
| `goals` | A root | Yes | `goals.user_id` | PK; `(is_active,due_date)`, `(goal_type,period_type)` indexes | `v2Controller`; goal progress aggregates sessions/vocabulary/kanji/grammar |
| `content_entries` | A root | Yes | `content_entries.user_id` | PK; date and `(content_type,content_date)` indexes | `v2Controller`; content search/list and session links |
| `notes` | A root | Yes | `notes.user_id` | PK; `(category,updated_at)` index | `v2Controller`; note search/list and all note links |
| `tags` | A root | Yes | `tags.user_id` | PK; globally unique `normalized_name` **must become** `(user_id, normalized_name)` | `v2Controller`; tag search/list and all tag links |
| `session_writings` | B child | No | `session_writings.id_session -> study_sessions.user_id` | PK; unique `id_session` retains one writing per session | `sessionsController`; session detail/write transaction and export scope through session |
| `usage_examples` | B child | No | `usage_examples.id_vocabulary -> vocabulary.user_id` | PK; FK vocabulary; `(id_vocabulary,id_usage_example)` index | `vocabularyController`; vocabulary detail and example CRUD |
| `review_items` | B child | No | Exactly one of its vocabulary, kanji, or grammar FKs; each parent is user-owned | PK; three target FKs; each target FK remains unique, enforcing one review item per owned target; due-date index | `reviewController`, creation paths in vocabulary/kanji/grammar; review queue |
| `review_events` | B child | No | `review_events.id_review_item -> review_items -> target root -> user_id` | PK; FK review item; `(id_review_item,reviewed_at)` index | `reviewController`; review history/transactions |
| `kanji_vocabulary` | C junction | No | Both `id_kanji` and `id_vocabulary` must resolve to the same user | composite PK; reverse vocabulary index | `kanjiController`, `vocabularyController`; details and link validation |
| `session_grammar` | C junction | No | session and grammar must share user | composite PK; reverse grammar index | `sessionsController`; session write/read |
| `session_kanji` | C junction | No | session and kanji must share user | composite PK; reverse kanji index | `sessionsController`; session write/read |
| `session_vocabulary` | C junction | No | session and vocabulary must share user | composite PK; reverse vocabulary index | `sessionsController`; session write/read |
| `content_entry_sessions` | C junction | No | content entry and session must share user | composite PK; reverse session index | `v2Controller`; content links |
| `note_study_sessions` | C junction | No | note and session must share user | composite PK; reverse session index | `v2Controller`; note links |
| `note_vocabulary` | C junction | No | note and vocabulary must share user | composite PK; reverse vocabulary index | `v2Controller`; note links |
| `note_kanji` | C junction | No | note and kanji must share user | composite PK; reverse kanji index | `v2Controller`; note links |
| `note_grammar` | C junction | No | note and grammar must share user | composite PK; reverse grammar index | `v2Controller`; note links |
| `tag_study_sessions` | C junction | No | tag and session must share user | composite PK; reverse session index | `v2Controller`; tag links |
| `tag_vocabulary` | C junction | No | tag and vocabulary must share user | composite PK; reverse vocabulary index | `v2Controller`; tag links |
| `tag_kanji` | C junction | No | tag and kanji must share user | composite PK; reverse kanji index | `v2Controller`; tag links |
| `tag_grammar` | C junction | No | tag and grammar must share user | composite PK; reverse grammar index | `v2Controller`; tag links |

## Required isolation rules for later implementation

- Root reads, writes, search, dashboard/statistics, calendar/streak, goal progress, review discovery, and export must bind the verified `req.user.id`; a browser-supplied user ID is never accepted.
- A child operation must first prove its parent root belongs to the caller. Review-item reads/writes must prove ownership through the one populated target FK.
- Every junction replacement must validate all supplied target IDs belong to the caller inside the same transaction that deletes/inserts the links. This prevents cross-user links even with manipulated IDs.
- A missing owned resource and another user's resource both return a safe `404` after authentication.
- The current forced RLS policy remains a runtime-role boundary only. Per-user authorization is enforced in Express and scoped SQL because PostgreSQL observes `jlt_runtime`, not the end user's Supabase role.

## UNIQUE constraint audit

| Current constraint | Decision | Exact future definition |
| --- | --- | --- |
| `kanji(character_kanji)` | Change: a learner's tracked kanji are personal records. | Drop `kanji_character_kanji_key`; add `UNIQUE (user_id, character_kanji)`. |
| `grammar_points(grammar_point)` | Change: grammar entries/notes are personal learning records. | Drop `grammar_points_grammar_point_key`; add `UNIQUE (user_id, grammar_point)`. |
| `tags(normalized_name)` | Change: tag vocabulary is personal. | Drop `tags_normalized_name_key`; add `UNIQUE (user_id, normalized_name)`. |
| `review_items(id_vocabulary)` / `(id_kanji)` / `(id_grammar)` | Retain. Each globally identified owned target has at most one review item. | No change. |
| `session_writings(id_session)` | Retain. One writing per owned session. | No change. |
| All junction composite primary keys | Retain. Global primary IDs plus parent ownership checks preserve per-user relation uniqueness. | No change. |
| All surrogate primary keys | Retain. They are identifiers, not user-visible value uniqueness. | No change. |
| `vocabulary.word` | No current unique constraint; do not introduce one. The product presently permits repeated vocabulary entries for one learner. | No change. |

## Index plan for the ownership migration

The composite unique constraints for kanji, grammar, and tags cover common equality filtering by user. The following additional indexes are justified by existing user-scoped list/dashboard/query patterns; exact ordering can be finalized against `EXPLAIN` after data migration.

| Root table | Proposed index | Reason |
| --- | --- | --- |
| `vocabulary` | `(user_id, id_vocabulary DESC)` | default paginated list and ownership filter |
| `kanji` | `(user_id, id_kanji DESC)` | default paginated list and ownership filter |
| `grammar_points` | `(user_id, id_grammar DESC)` | default paginated list and ownership filter |
| `study_sessions` | `(user_id, session_date DESC, id_session DESC)` | history, dashboard, calendar, streak, date filtering |
| `goals` | `(user_id, is_active, due_date)` | active-goal list and deadline ordering |
| `content_entries` | `(user_id, content_date DESC, id_content_entry DESC)` | content listing/history |
| `notes` | `(user_id, updated_at DESC, id_note DESC)` | note list/search baseline |

No direct `user_id` index is added to child/junction tables because their existing parent/reverse-FK indexes plus root ownership predicates support the planned joins without redundant data or indexes.

## Implementation gate

Before Stage 1 ownership columns, obtain the owner's confirmed Supabase Auth UUID through the execution environment only. The UUID must never be committed. No database migration is authorized by this audit alone.
