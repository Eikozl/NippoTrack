# JLT V2 Phase 0: Database Architecture Proposal

Status: **Phase 0 approved with revisions; schema migrations applied on 2026-08-30**. A verified logical backup was created before the first migration. V2 modules for structured writing, usage examples, goals, content, notes, tags, their approved relationships, review, streaks, and the activity calendar are implemented.

## Approved revisions

1. The eight V1 tables remain unchanged.
2. First release excludes `note_content_entries`, `tag_content_entries`, and `tag_notes`.
3. Review uses the approved minimal rules: new vocabulary, kanji, and grammar entries enter the queue due today; `Again`, `Hard`, and `Good` schedule the next review in 1, 3, and 7 days respectively. Review never changes the V1 status automatically.
4. Streaks, calendar/history, advanced filtering, Quick Add, and goal progress remain derived rather than persisted.
5. Migrations will be applied one at a time only after final approval and a verified backup.
6. Live MariaDB confirms that V1 already allows `Grammar`, `Vocabulary`, `Kanji`, `Reading`, `Listening`, `Speaking`, `Writing`, and `Mixed`. No category value will be added or changed by V2.

## 1. Baseline verified

The live `jlt` database remains the frozen V1 baseline:

- Entity tables: `study_sessions`, `vocabulary`, `kanji`, and `grammar_points`.
- Junction tables: `kanji_vocabulary`, `session_vocabulary`, `session_kanji`, and `session_grammar`.
- The four junction tables have composite primary keys and two foreign keys each.
- All eight V1 foreign keys use `ON DELETE CASCADE`; no orphan rows were found.
- Existing indexes support session date/category and learning-material JLPT/status queries.
- Current API contracts already expose a session with its related vocabulary, kanji, and grammar; vocabulary and kanji detail endpoints already expose their V1 relationships.

V2 must be additive. It must not rename, replace, or alter V1 tables for convenience.

## 2. V2 feature-to-persistence matrix

| Feature | Persistence decision | Reason |
| --- | --- | --- |
| Study session read view | Reuse V1 | `GET /api/sessions/:id` already returns the session and its three relationship sets. |
| Quick Add Session | Reuse V1 | It creates an ordinary `study_sessions` row and optional existing junction rows; no `quick_sessions` table. |
| Vocabulary / Kanji preview | Reuse V1 + examples | The existing detail records and `kanji_vocabulary` are canonical. Only managed example sentences need new storage. |
| Calendar / study history | Read-only V1 query | Calendar cells, monthly totals, heatmaps, and sessions-by-day derive from indexed `study_sessions.session_date`. |
| Study streak / consistency | Derived, no persistence | Calculate from distinct `study_sessions.session_date` values; never store the current or longest streak. |
| Advanced filtering | Query/API enhancement | It composes existing V1 filters and later V2 joins; no table is needed. |
| Structured writing content | New table | V1 `notes` is not a dedicated, structured writing record. |
| Vocabulary example usage | New table | User-managed sentences belong to real vocabulary records. |
| Kanji usage examples | Reuse `usage_examples` through `kanji_vocabulary` | A kanji view shows examples for real linked words and their actual readings. It needs no separate kanji-example relation. |
| Study goals | New table | Goal definitions and their rules must persist; progress is derived. |
| Content log | New table + session junction | Content metadata is distinct from a free-text session resource and may relate to many sessions. |
| Notes | New table + explicit junction tables | Supports standalone and entity-linked notes without an unchecked `entity_type/entity_id` pair. |
| Tags | New table + explicit junction tables | Normalized reusable tags; no comma-separated values. |
| Simple review | New tables | Due state and immutable review history are not represented by V1. |

## 3. Proposed ER model

```text
study_sessions 1 --- 0..1 session_writings
study_sessions N --- N content_entries       via content_entry_sessions

vocabulary     1 --- N usage_examples
kanji          N --- N vocabulary             via existing kanji_vocabulary
kanji views derive examples through vocabulary -> usage_examples

notes          N --- N study_sessions         via note_study_sessions
notes          N --- N vocabulary             via note_vocabulary
notes          N --- N kanji                  via note_kanji
notes          N --- N grammar_points         via note_grammar

tags           N --- N study_sessions         via tag_study_sessions
tags           N --- N vocabulary             via tag_vocabulary
tags           N --- N kanji                  via tag_kanji
tags           N --- N grammar_points         via tag_grammar

review_items   0..1 --- 1 vocabulary | kanji | grammar_points
review_items   1 --- N review_events
```

`review_items` uses three nullable, foreign-key-backed columns and a check that exactly one is populated. This avoids a polymorphic type/id pair while allowing one review queue.

## 4. Proposed additive tables

### 4.1 `session_writings`

Purpose: optional structured writing content for a study session.

- PK: `id_session_writing` (`INT AUTO_INCREMENT`).
- Required: `id_session`, `content` (`TEXT`).
- Optional: `title` (`VARCHAR(150)`), `notes` (`TEXT`).
- Audit: `created_at`, `updated_at` timestamps.
- FK: `id_session -> study_sessions(id_session) ON DELETE CASCADE ON UPDATE RESTRICT`.
- Constraints/indexes: `UNIQUE(id_session)`; the unique index also supports loading a session detail.
- Cardinality: one session has zero or one structured writing record.
- Validation: title <= 150; non-empty trimmed content <= 10,000 characters; notes <= 1,500.
- Paths: session detail reads it; a future session create/update may write it only when the existing V1 category is `Writing` or `Mixed`.

### 4.2 `usage_examples`

Purpose: persistent vocabulary example sentences. Kanji usage is derived from examples belonging to vocabulary linked by `kanji_vocabulary`.

- PK: `id_usage_example` (`INT AUTO_INCREMENT`).
- Required: `id_vocabulary`, `sentence` (`TEXT`).
- Optional: `translation` (`TEXT`), `notes` (`TEXT`).
- Audit: `created_at`, `updated_at` timestamps.
- FK: `id_vocabulary -> vocabulary(id_vocabulary) ON DELETE CASCADE ON UPDATE RESTRICT`.
- Indexes: `INDEX(id_vocabulary, id_usage_example)`.
- Cardinality: one vocabulary record has zero or many examples; one example belongs to exactly one vocabulary record.
- Validation: sentence <= 2,000; translation <= 2,000; notes <= 1,500; no raw HTML rendering.
- Paths: vocabulary detail reads/writes its examples. Kanji detail joins `kanji_vocabulary`, `vocabulary`, and this table so the shown reading always belongs to the displayed word.

### 4.3 `goals`

Purpose: store goal definitions only. Progress is always calculated from V1 data or existing learning-status fields.

- PK: `id_goal` (`INT AUTO_INCREMENT`).
- Required: `title` (`VARCHAR(120)`), `goal_type`, `target_value`, `period_type`, `start_date`.
- Optional: `target_jlpt_level`, `target_status`, `due_date`, `is_active` (default true), timestamps.
- Allowed `goal_type`: `study_minutes`, `vocabulary_count`, `kanji_count`, `grammar_count`.
- Allowed `period_type`: `weekly`, `cumulative`, `by_deadline`.
- Checks: `target_value > 0`; `due_date IS NULL OR due_date >= start_date`; JLPT/status values must match V1 allowlists.
- Indexes: `INDEX(is_active, due_date)`, `INDEX(goal_type, period_type)`.
- Cardinality: independent aggregate definitions; no target-entity FK is required or desirable.
- Validation: a weekly goal may only use `study_minutes`; `by_deadline` requires `due_date`; count goals may optionally constrain JLPT and/or V1 status.
- Paths: the goals page writes definitions; dashboard and goals endpoints calculate progress at read time.

The proposed initial goal set intentionally excludes free-form manual-progress goals and ambiguous “JLPT milestone” scoring. Those require separately agreed measurement rules.

### 4.4 `content_entries` and `content_entry_sessions`

Purpose: log Japanese media/content independently of individual study sessions while allowing real study links.

`content_entries`:

- PK: `id_content_entry` (`INT AUTO_INCREMENT`).
- Required: `title` (`VARCHAR(255)`), `content_type`, `content_date`.
- Optional: `perceived_difficulty` (`TINYINT`), `comprehension_percent` (`TINYINT`), `new_words_count` (`INT`), `notes` (`TEXT`), timestamps.
- Allowed `content_type`: `Anime`, `Manga`, `Book`, `Article`, `YouTube`, `Podcast`, `Game`, `Conversation`.
- Checks: difficulty 1–5 when present; comprehension 0–100 when present; word count >= 0.
- Indexes: `INDEX(content_date)`, `INDEX(content_type, content_date)`.

`content_entry_sessions`:

- PK: composite `(id_content_entry, id_session)`.
- FKs: to `content_entries` and `study_sessions`, both `ON DELETE CASCADE ON UPDATE RESTRICT`.
- Reverse lookup index: `INDEX(id_session)`.
- Cardinality: many content entries may be studied in many sessions.

### 4.5 `notes` and its explicit links

Purpose: retain standalone notes and notes associated with real records, with referential integrity.

`notes`:

- PK: `id_note` (`INT AUTO_INCREMENT`).
- Required: `body` (`TEXT`), `category`.
- Optional: `title` (`VARCHAR(150)`), timestamps.
- Allowed `category`: `Grammar`, `Vocabulary`, `JapaneseQuestion`, `Correction`, `Resource`, `General`.
- Index: `INDEX(category, updated_at)`.
- Validation: title <= 150; non-empty body <= 10,000.

First-release link tables: `note_study_sessions`, `note_vocabulary`, `note_kanji`, and `note_grammar`.

- Each has a composite PK of its two IDs, both FKs with `ON DELETE CASCADE ON UPDATE RESTRICT`, and a reverse lookup index on the non-note ID.
- A note may have zero links (standalone) or multiple explicit links. No application field accepts an arbitrary table name or entity ID.

### 4.6 `tags` and explicit tag links

Purpose: reusable labels for filtering; a tag is a label, not a comma-separated text field.

`tags`:

- PK: `id_tag` (`INT AUTO_INCREMENT`).
- Required: `name` (`VARCHAR(60)`), `normalized_name` (`VARCHAR(60)`).
- Audit: `created_at`, `updated_at` timestamps.
- Constraint: `UNIQUE(normalized_name)`.
- Validation: non-empty 1–60 characters; `normalized_name` is server-calculated by trimming, collapsing whitespace, and case-folding.

First-release link tables: `tag_study_sessions`, `tag_vocabulary`, `tag_kanji`, and `tag_grammar`.

- Each has a composite PK, cascading FKs, and a reverse lookup index.
- Tags are intentionally not linked to goals, notes, content entries, or review events in the first V2 iteration.

### 4.7 `review_items` and `review_events`

Purpose: a deliberately small review queue and an auditable history, not an Anki clone.

`review_items`:

- PK: `id_review_item` (`INT AUTO_INCREMENT`).
- Exactly one required target: nullable `id_vocabulary`, `id_kanji`, `id_grammar`; each has an FK to its V1 table with `ON DELETE CASCADE ON UPDATE RESTRICT`.
- Required: `due_on` (`DATE`), `interval_days` (`SMALLINT UNSIGNED`, default 0).
- Optional: `last_reviewed_at` (`DATETIME`), `last_result` (`VARCHAR(10)`), timestamps.
- Constraints: unique index on each target ID; a `CHECK` requiring exactly one target ID; `interval_days <= 60`; result is `Again` or `Good` when present.
- Index: `INDEX(due_on)` for the queue.

`review_events`:

- PK: `id_review_event` (`INT AUTO_INCREMENT`).
- Required: `id_review_item`, `reviewed_at`, `result`, `previous_interval_days`, `next_interval_days`.
- FK: `id_review_item -> review_items(id_review_item) ON DELETE CASCADE ON UPDATE RESTRICT`.
- Index: `INDEX(id_review_item, reviewed_at)`.
- Validation: result is `Again` or `Good`; intervals are 0–60.

Review is intentionally small: newly created vocabulary, kanji, and grammar enter the queue due today. Existing V1 learning records were backfilled once when Review was activated. Recording `Again`, `Hard`, or `Good` schedules the item after 1, 3, or 7 days and records an immutable event. No review action changes the V1 status automatically.

The V1 `status` remains the user-visible mastery status. The review tables will not update it until that separate approval exists.

## 5. Read/write API impact

The existing V1 routes stay compatible. V2 adds routes only for new resources and augments detail responses only with clearly named optional fields.

- Detail reads: session -> `writing`; vocabulary -> `examples`; kanji -> vocabulary-based usage examples.
- Read-only derived endpoints: calendar/history, streak/consistency, advanced filters, and goal progress.
- New CRUD resources: goals, content entries, notes, tags, and vocabulary usage examples.
- Transactional writes: a session plus writing, content-entry links, note links, tag links, and review events.
- List endpoints remain paginated; relationship option endpoints continue to use the current Japanese/romaji-aware search behavior.

## 6. Migration order and rollback

Every migration will be one deterministic SQL file, named in this order:

1. `001_v2_session_writings`
2. `002_v2_usage_examples`
3. `003_v2_goals`
4. `004_v2_content_entries`
5. `005_v2_content_entry_sessions`
6. `006_v2_notes`
7. `007_v2_note_links_v1_entities`
8. `008_v2_tags`
9. `009_v2_tag_links_v1_entities`
10. `010_v2_review_items`
11. `011_v2_review_events`

Forward migrations only create new tables, checks, keys, and indexes. They do not update, copy, or delete V1 rows. Each migration is independently applied and validated before the next migration begins.

Before the first migration, create and verify a timestamped logical backup of `jlt` from the terminal. Before a rollback, create another backup. A rollback drops only the new tables in strict reverse dependency order (11 to 1). It is allowed only after confirming whether V2 data must be preserved; if it must, restore that data from the pre-rollback backup instead of silently discarding it.

## 7. Validation and security implications

- Keep every query parameterized and every writable field allowlisted.
- Validate IDs before querying; validate all enum/check values server-side even when MariaDB has a constraint.
- Use transactions for all multi-table writes and roll back on every failure.
- Return safe 400/404/409 responses and no raw SQL errors.
- Render note, writing, example, content, and tag text with `textContent`, never as raw HTML.
- Do not add accounts, ownership columns, authentication, or authorization in V2; this remains a single-user local application.
- Do not store derived streaks, calendar entries, goal progress, romaji, or kanji reading guesses.

## 8. Applied migration/table list

No V1 table changes are proposed. The first V2 release creates these 17 tables:

| Migration | Tables created |
| --- | --- |
| `001_v2_session_writings` | `session_writings` |
| `002_v2_usage_examples` | `usage_examples` |
| `003_v2_goals` | `goals` |
| `004_v2_content_entries` | `content_entries` |
| `005_v2_content_entry_sessions` | `content_entry_sessions` |
| `006_v2_notes` | `notes` |
| `007_v2_note_links_v1_entities` | `note_study_sessions`, `note_vocabulary`, `note_kanji`, `note_grammar` |
| `008_v2_tags` | `tags` |
| `009_v2_tag_links_v1_entities` | `tag_study_sessions`, `tag_vocabulary`, `tag_kanji`, `tag_grammar` |
| `010_v2_review_items` | `review_items` |
| `011_v2_review_events` | `review_events` |

Deferred from the first release: `note_content_entries`, `tag_content_entries`, and `tag_notes`. They will be reconsidered only after actual use demonstrates their value.

## 9. Still deferred

The schema is approved and applied. The following semantic decision remains out of scope until separately approved:

1. The streak rule: a day is active when it has at least one `study_sessions` row; a missed local calendar day resets the current streak; longest streak is derived from all historical dates.
