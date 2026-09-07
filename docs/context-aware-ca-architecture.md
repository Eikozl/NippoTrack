# Context-Aware Vocabulary Intelligence — Frozen Architecture (CA-A → CA-B1)

Canonical design record. Phases: CA-A (source/storage/model), CA-A.1 (snapshot
correctness, two-axis model, bounded queries), CA-A.2 (pinning, overflow
safety, precedence, valve precision), CA-B1 (reference foundation, built).

## What it is

Given a Phase 12 lexical candidate **inside a sentence**, report which JMdict
dictionary interpretations are compatible with the evidence — and refuse to
choose when the evidence does not justify it. v1 is a **lexical-compatibility
filter**, not word-sense disambiguation. "Ambiguous" is first-class.

Hard invariants: `DETECTED ≠ DICTIONARY-MATCHED ≠ CONTEXTUALLY-INTERPRETED ≠
ADDED ≠ REVIEWED ≠ KNOWN`. Read-only until explicit user action. No LLM,
embeddings, translation APIs, or external semantic services. No automatic
vocabulary writes, no Review enrollment. No JMnedict (proper nouns stay
`Needs verification`). Single-head-only v1 (no multi-token expressions).

## Lexical source (frozen)

Official EDRDG `JMdict_e` (English-only) as authority; `jmdict-simplified`
JSON (`jmdict-eng-*`) as offline ingestion projection. CC BY-SA 4.0, ©
Breen/EDRDG: attribution in `THIRD_PARTY_NOTICES.md` + docs + persistent
in-app credit; ≥monthly refresh (licence condition, see
`docs/jmdict-import.md`); commercial use permitted; no copyright claimed.

## Reference storage (frozen, built in migration `010`)

Hybrid PostgreSQL model, five tables, all GLOBAL (no `user_id`, no user FKs):

- `jmdict_sources` — provenance ledger + lifecycle (`importing →
  validating → ready`, `failed` terminal). Natural identity
  `(source_name, file_date, converter, converter_version, sha256)`.
- `jmdict_active_snapshot` — singleton pointer `(1, source_id NULLABLE)`.
  `NULL` = dictionary not loaded. Activation/rollback = one atomic row write.
- `jmdict_entries(source_id, ent_seq)` — canonical `doc JSONB`, `pos_summary`,
  `is_common`, row checksum. `ent_seq` is upstream identity, never the sole PK.
- `jmdict_forms(source_id, entry_id, kind, surface)` — exact `surface` +
  folded `normalized` key (NFKC + katakana→hiragana only), `restr`,
  `is_common`, `nokanji`. Hot index `(source_id, normalized)`. No fuzzy/trigram.
- `jmdict_senses(source_id, entry_id, sense_no)` — `pos[]`, `gloss_en[]`,
  `stagk[]`, `stagr[]` (all SQL-addressable; `["*"]` pre-expanded at import).

Snapshots immutable; no tombstones (absence = upstream removal); rollback
restores rows (proven A→B→A in CA-B1); prune protects ACTIVE + rollback
target; idempotent reimport; crash recovery restarts under a fresh id.
Runtime `SELECT`-only, forced RLS role-boundary, admin-only lifecycle.

## Two-axis intelligence model (frozen; built in CA-B2, not here)

- `dictionaryMatch`: `UNIQUE | MULTIPLE | NO_MATCH | UNSUPPORTED | UNAVAILABLE`
  — which entry/form/readings the candidate maps to. Resolved ONLY after all
  Q2-dependent hard filters (H1–H6 + POS table) run over the full evaluated set.
- `interpretation`: `COMPATIBLE | AMBIGUOUS | NOT_APPLICABLE | UNAVAILABLE` —
  which sense, if any, is justified. `COMPATIBLE` iff exactly one sense
  survives in a `UNIQUE` match with no valve trip. **No `LIKELY` in v1.**
- Readings resolve on the match axis independently of sense ambiguity: a
  `UNIQUE` entry's applicable dictionary reading may be suggested while
  meaning stays blank-or-choose. Provenance is always labeled
  (`surface | parser-lemma | dictionary | user`); parser fields never mutated.

## Query contract (frozen bounds for CA-B2)

One request = one pinned snapshot (Q1 returns the pin; Q2 takes it as a
parameter — never re-read). Identity strategy per candidate: ORTHOGRAPHIC
(Han-bearing → `keb` keys only; readings validate within the cohort) vs
READING_FALLBACK (kana-only → `reb` keys; may be `MULTIPLE`). Inflected
observed surfaces are never identity keys. Q1: per-key `LIMIT 5+1` sentinel
(≤720 rows); overflow forbids `UNIQUE` (`lookupTruncated`). Q2: all senses
for ≤150 entries with 64+1 valve; trip forbids `COMPATIBLE`
(`evaluationTruncated`). Evaluate-before-display-truncate; display ≤3 +
counts. Context ≤3 queries; additive double-opt-in API block; HTTP-200
degradation (Kanji OK / lexical OK / context UNAVAILABLE).

## Evidence model (frozen)

HARD excluders: H1 `stagk`, H2 `stagr`, H3 `re_restr`, H4 kana/kanji mismatch,
H5 proven POS-incompatibility, H6 identity failure. Ranking priors only:
priority/commonness, sense order, `uk`, neighbor window, particles.
Particles/window are weak annotations, never filters. Commonness/order can
never promote to certainty (no promotion path exists by construction).
UI wording: "Compatible meaning" (+ disclosed limits); "Likely meaning here"
is forbidden in v1.

## C1 evidence (measured CA-B1, pin 3.6.2 / dictDate 2026-08-31)

218,672 entries · 498,846 forms (233,311 keb / 265,535 reb) · 253,434 senses.
Restriction-bearing: 466 entries stagk (625 senses), 805 stagr (1,043),
4,774 re_restr forms, 6,639 applies-to-none readings. n/adj-na overlap: 3,348
entries / 3,581 senses. Verb families: v1 3,922 · v5 8,041 · vk 38 · vs
15,016 entries. 83/83 POS codes classified; sole unknown `unc`
(unclassified — must never filter). **maxSensesPerEntry = 27 ≤ 64 valve**
(valve provably dormant on this snapshot). All 10 integrity checks green;
zero orphans; zero gloss-less senses. Storage ≈ 367 MB reference
(entries 195 / forms 112 / senses 60 MB, measured local PG18).

## CA-B2 handoff (foundation guarantees)

One-request-one-snapshot pinning (Q1 returns pin incl. zero-match path);
orthographic-first lookup with kind-enforced keys; no inflected identity
keys; Q1 5+1 overflow sentinel; Q2 full-set evaluation with 64+1 valve;
post-filter `dictionaryMatch`; interpretation after match; display truncation
last. DO NOT implement here — CA-B2 block, audited separately.
