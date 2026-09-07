# Context-Aware Vocabulary Intelligence — Frozen Architecture (CA-A → CA-B2)

Canonical design record. Phases: CA-A (source/storage/model), CA-A.1 (snapshot
correctness, two-axis model, bounded queries), CA-A.2 (pinning, overflow
safety, precedence, valve precision), CA-B1 (reference foundation, built),
CA-B1.1 (bulk import, Q1 index, doc corrections), CA-B2 (context core, built).

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
  `is_common`, `nokanji`. Hot index `idx_jmdict_forms_q1_lookup(source_id,
  normalized, kind, is_common DESC, entry_id)` (migration `011`, measured
  CA-B1.1: serves the frozen Q1 shape as Limit>Index Scan with no sort on
  1/5/14/52-row cohorts; replaced the sort-requiring `(source_id,
  normalized)` index at ~equal storage). No fuzzy/trigram.
- `jmdict_senses(source_id, entry_id, sense_no)` — `pos[]`, `gloss_en[]`,
  `stagk[]`, `stagr[]` (all SQL-addressable; `["*"]` pre-expanded at import).

Snapshots immutable; no tombstones (absence = upstream removal); rollback
restores rows (proven A→B→A in CA-B1); prune protects ACTIVE + rollback
target; idempotent reimport; crash recovery restarts under a fresh id.
Runtime `SELECT`-only, forced RLS role-boundary, admin-only lifecycle.

## Two-axis intelligence model (frozen; built in CA-B2)

- `dictionaryMatch`: `UNIQUE | MULTIPLE | NO_MATCH | UNSUPPORTED | UNAVAILABLE`
  — which entry/form/readings the candidate maps to. Resolved ONLY after all
  Q2-dependent hard filters (H1–H6 + POS table) run over the full evaluated set.
  Zero evaluated survivors + a tripped sense valve is `MULTIPLE` (never
  `NO_MATCH` — the unevaluated tail may hide a match); a tripped valve on a
  fully-excluded entry likewise forbids `UNIQUE`/`COMPATIBLE`.
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
15,016 entries. 83 distinct POS codes observed; 82 mapped into known JLT
audit families; 1 intentionally unknown/unclassified: `unc` (must never be
used as a hard exclusion in CA-B2 — unknown is not incompatible). **maxSensesPerEntry = 27 ≤ 64 valve**
(valve provably dormant on this snapshot). All 10 integrity checks green;
zero orphans; zero gloss-less senses. Storage ≈ 367 MB reference
(entries 195 / forms 112 / senses 60 MB, measured local PG18).

## CA-B2 handoff (foundation guarantees — all implemented)

One-request-one-snapshot pinning (Q1 returns pin incl. zero-match path);
orthographic-first lookup with kind-enforced keys; no inflected identity
keys; Q1 5+1 overflow sentinel; Q2 full-set evaluation with 64+1 valve;
post-filter `dictionaryMatch`; interpretation after match; display truncation
last.

## CA-B2 implementation (as built)

Service topology (`server/src/services/`, reusable beyond the Analyzer —
input is candidate-shaped data, never raw text):

- `contextIdentity.js` — eligibility (Phase 12 content words only; proper
  nouns/unknowns/function words → `UNSUPPORTED`), safe keys (lemma +
  canonical dedup; observed surfaces only when `surface === lemma`), strategy
  driven by the LEMMA alone (a kana lemma never upgrades to `ORTHOGRAPHIC`
  on an unobserved Han canonical), head-token inflection recovery.
- `contextPos.js` — centralized compatibility table → `EXACT_COMPATIBLE |
  BROAD_COMPATIBLE | INCOMPATIBLE | UNKNOWN`; only `INCOMPATIBLE` excludes.
  `unc`, unrecognized codes and empty lists are wildcards. Audit-hardened
  broad sets: `aux-v`/`exp` for verbs; `exp`/`aux-adj` for i-adjectives;
  `vs`/`exp`/counters for na-adjectives; `adv`/`vs`/`int`/counters/`exp`
  for nouns (adverbial nouns/pronouns: 何 stays `AMBIGUOUS`, never
  niche-`COMPATIBLE`); full `n` range + `exp` for adverbs; `adv`/`n`/`exp`
  for interjections. `pn` still strikes (names out of v1 scope; a pn-only
  entry is honestly `NO_MATCH` for a common-noun observation).
  Inflection (`一段→v1`, `五段・行→v5*`, `カ変→vk`, `サ変→vs`) corroborates
  only (`INFLECTION_FAMILY_COMPATIBLE`), never vetoes.
- `contextReference.js` — Q1 (active CTE × keys × `LEFT JOIN LATERAL`,
  one round trip, pin preserved on zero matches; ≤120 keys guarded,
  5+1/key, ≤720 rows) + Q2 senses (pinned source param, per-entry 64+1
  via `LATERAL`) + Q2 forms (per-entry cap 200 with truncation flag).
  Adapter-safe (`?` only, counts asserted, no `LIKE`/JSON-operators).
- `contextFilters.js` — H1–H6 with normalized restriction membership; H2
  uses parser `lemmaReading` only (dictionary form observed; frozen rule —
  an IPADIC misreading propagates, so the behavior is pinned by test and
  disclosed here); reading resolution (`ORTHOGRAPHIC`: all applicable reb;
  fallback: matched rows only); two-axis finalization incl. the
  excluded-tail rule above.
- `contextResponse.js` — diet (entries ≤5, senses ≤3, glosses ≤3, no `doc`),
  summary counts, reason codes, 100 KB cap (presentation-only trim that
  provably preserves statuses).
- `contextService.js` — `resolveContext({pool, candidates, tokens})`:
  ≤3 queries, ≤150-entry Q2 budget (overflow → `MULTIPLE` + truncated,
  never `NO_MATCH`), never throws, logs nothing.

API (`POST /api/analyze/text`, additive double opt-in): `lexical.enabled`
unchanged; `context.enabled` requires lexical (else `lexical-required`,
HTTP 200). Context rides the lexical budget (no second limiter). Failure
semantics: Kanji OK / lexical OK / context `UNAVAILABLE` (`version-absent`,
`reference-query-failed`, `sense-evaluation-failed`, `lexical-required`,
`lexical-unavailable`), HTTP 200 throughout. Runtime pool only
(`config/db`); services never import admin *or* runtime pools (pool is
injected; asserted by test). No writes, no user tables, no external calls,
no content logging (counts/durations only).

Known limitations (safe direction, future work — NOT v1 bugs):
- `stagkNone`/`stagrNone` (kana-only senses) are not persisted (CA-B1
  schema frozen): collapsed to unrestricted, so Han observations keep such
  senses (over-keep → `AMBIGUOUS`). Needs a future migration to represent.
- H2 trusts the IPADIC dictionary-form reading; a parser misreading narrows
  to the wrong sense. Absent reading evidence always keeps ambiguity.

Measured local facts (snapshot 1, 218,672 entries; loopback admin,
read-only): Q1 `Limit > Index Scan(idx_jmdict_forms_q1_lookup)`, no sort,
on 1/1/6/6-row probes (2–6 ms, 6–11 buffers); widest cohort 52 rows
(こう/reb) → 6-row fetch; max forms/entry 40 (cap 200 dormant); max
senses/entry 27 (valve 64 dormant). Corpus: 19 texts, ≤3 queries each,
1.5–3.5 KB blocks, 7–33 ms. Adversarial outcomes: 行く `UNIQUE` without
逝く/往く; かける trio identically `MULTIPLE` + truncated (no WSD);
箸 `COMPATIBLE` chopsticks; はし `MULTIPLE`; 田中 absent (proper noun);
ググった empty-ok; エモい ambiguous (no invented definition). One live
correction made during verification: 何/なに stays `AMBIGUOUS` across its
`n` + `adv` senses (noun↔adverb broadened) instead of `COMPATIBLE` on the
niche noun sense.

Tests: 40 unit (`context-unit`), 15 DB (`context-db`, loopback-gated:
bounds, sentinels both directions, F12 race with single-pointer-read
assert, F13 zero-match pin, 011 plan shape, N+1, Han-miss, fixture F1–F5),
10 API (`context-analyze-api`: flags, degradation, caps, reason codes,
closed status sets across UNIQUE/MULTIPLE/NO_MATCH/UNAVAILABLE wire).
65 context tests total, all green; full server suite green (see report).

## CA-B2.1 contract polish (as built — behavior fixes only, no redesign)

- `selectedEntryId` invariant (frozen): non-null ONLY when
  `dictionaryMatch.status === UNIQUE`. A lone visible survivor beside a
  truncated/excluded cohort is still `MULTIPLE` with `selectedEntryId: null`
  — no identity is ever inferred from commonness, survivor count, or partial
  evaluation. `UNIQUE` + `AMBIGUOUS` (行く) keeps its identity.
- `retryable` truthfulness: true ONLY when a transient failure contributed
  (`reference-query-failed`, `sense-evaluation-failed`, `context-failed`).
  Deterministic structural outcomes are false: `candidate-cap-reached`,
  `lookup-truncated`, `evaluation-truncated` (`partial`), `version-absent`
  and `lexical-required` (`unavailable`). Statuses, reasons, and warnings
  are unchanged — only the retryable flag was corrected.
- Snapshot provenance: Q1 also selects `s.converter`; the pin carries
  `{sourceId, sourceName, converter, converterVersion, fileDate}` from the
  actual snapshot row, and the API `dictionary` block is derived from that
  pin alone (no importer constants on the response path; constants remain
  for importer/default use). Zero-match path reports the same provenance
  from the same single Q1 round trip.
- Environment safety (process rule): any DB-backed command outside server
  startup must resolve its explicit target and refuse a Production project
  ref (`milayuvlajmgrcxmrxdg`) BEFORE connecting — loopback and the
  disposable integration project (`mufxygohcjikhlktvrcy`) pass. Implemented
  as `assertSafeDbTarget({host, user, source})` in the existing
  `scripts/production-guard.js` (reuses `isProductionValue`; no new env
  architecture) and wired into both gated DB test files beside their
  loopback gates. Cause of the CA-B2 incident: an ad-hoc probe loaded the
  runtime config (whose local `.env.runtime` points at Production) outside
  the startup guards, issuing one read-only `SELECT` that failed with
  `42P01`; nothing was read or written.

## CA-B3 product integration (as built — UI only, backend untouched)

Request: the Analyzer sends `context: { enabled: true }` alongside lexical
on the same Analyze call (no duplicate request, same budget). API stays
opt-in; only the Analyzer UI uses the capability.

Card hierarchy (augments Phase 12 cards, compact by default): canonical word
→ POS/existing metadata → observed/reading lines → Context intelligence →
Add action. Presentation mapping lives in `client/src/contextAnalyzer.js`
(pure; backend objects never mutated, statuses/remainingCount/truncation
trusted, never recomputed).

- UNIQUE + COMPATIBLE: `Compatible meaning` + same-sense glosses joined
  (`to begin · to start`); dictionary reading shown with `(JMdict)` cue.
- UNIQUE + AMBIGUOUS: reading kept; `Possible meanings` + sense list +
  `JLT couldn't reliably distinguish one meaning from this context.` First
  sense never picked.
- MULTIPLE: `Multiple dictionary matches` + headword — gloss rows, no
  authoritative reading, no entry election; `More dictionary matches exist.`
  when `lookupTruncated`.
- NO_MATCH: quiet `No reliable dictionary match found.` UNAVAILABLE (item):
  `Context details are temporarily unavailable.` UNSUPPORTED: no panel
  (existing Needs-verification stays primary).
- Truncation: user copy only (`More meanings exist.`, ambiguity-kept note);
  caps (5+1/64+1/150/100 KB) never exposed.
- `Why this matches` (collapsed `<details>`): evidence codes mapped
  (LEMMA_EXACT→Dictionary form matches, ORTHOGRAPHIC_EXACT→Spelling
  matches, READING_COMPATIBLE→Reading matches,
  READING_RESTRICTED→Reading is valid for this spelling, POS_EXACT→Part of
  speech matches, POS_BROAD→Part of speech is compatible,
  INFLECTION_FAMILY_COMPATIBLE→Conjugation matches the dictionary verb
  family); excludedBy collapsed to spelling/reading/part-of-speech kinds.
  Raw codes never render.
- Block failure: compact `role="status"` notice; `Retry analysis` ONLY when
  `retryable === true` (reuses the normal Analyze action);
  `version-absent` → neutral environment wording, no Retry.
- Attribution (one footer per vocabulary section, only with provenance):
  `Dictionary data: JMdict © EDRDG (CC BY-SA 4.0)` with hardcoded JMdict/CC
  links + `Reference version` disclosure (converter version, release date).
  Never per card; never `sourceId`.

Add-dialog matrix (existing dialog reused; open ≠ write; save explicit):

| match | interpretation | word | reading | meaning |
|---|---|---|---|---|
| UNIQUE | COMPATIBLE | prefill | prefill (dictionary, if suggested) | prefill (first gloss) |
| UNIQUE | AMBIGUOUS | prefill | prefill (if suggested) | blank + explicit `Use “…”` picks (user action) |
| MULTIPLE / NO_MATCH / UNSUPPORTED / UNAVAILABLE | any | lexical default | lexical default | blank |

Stale safety: suggestions tagged to the candidate identity; editing WORD
away clears untouched context-derived reading/meaning (never reapplies),
disables sense picks until restored; user-typed values always preserved.
Romaji conversion untouched (`iku→いく`, `gakkou→がっこう`, kana preserved,
failure/race behavior intact).

Responsive/accessibility: intrinsic CSS only (no JS measurement, estimate
code untouched); verified 320–1280px with no horizontal overflow; native
`<details>` disclosures; named buttons incl. `Use meaning “…” for …`;
`aria-expanded` via native semantics; `role="status"` notices; retry gated
semantically; both themes via existing `--jlt-*` variables (no hardcoded
colors). All rendering through `textContent`; licence links hardcoded.

Tests: 13 client unit (`contextAnalyzer.test.mjs`: states, matrix, stale
model, evidence, retryable, truncation, attribution) + 17 browser
(`contextAware.browser.test.mjs`: full matrix incl. stale/romaji/
unavailable-retry/evidence-focus/7-width geometry/dark mode). Reviews:
japanese-language PASS, security PASS WITH FINDINGS (2 non-blocking minors,
`noopener` applied).

Local live proof (loopback, tiny snapshot, since removed): real Kuromoji +
real SQL + real wire + real mapper — 学校 UNIQUE/COMPATIBLE, 行く
UNIQUE/AMBIGUOUS with reading, はし MULTIPLE ×3, 田中 conservative,
ctx 8–151 ms warm, ~2.3 KB blocks. Local DB left exactly as found
(snapshots 1–2 intact, pointer →1, no scaffold policies).

Known limitations: Preview closure conditional — integration project has
migrations 010/011 applied but an empty `jmdict_sources` (pointer NULL),
and no admin/BYPASSRLS credentials exist locally (runtime role is
SELECT-only), so the approved bulk import cannot run from here; Preview
backend env target unverifiable without Vercel access, so no remote smoke
was run (zero Production contact). Owner steps: run the approved importer
against integration (inactive → verify → C1 → explicit activate), confirm
Preview env alignment, smoke (§46 list).

Owner smoke (8): 1. `学校に行った。` states. 2. 行く ambiguous Add flow.
3. はし multiple-match flow. 4. Add 学校, verify prefill. 5. Edit word
before saving, confirm stale suggestions clear. 6. Narrow mobile width.
7. Dark mode. 8. Context unavailable state if practical.
