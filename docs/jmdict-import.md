# JMdict Reference Operations (CA-B1)

Offline lifecycle for JLT's global Japanese–English word reference data.
Companion to the frozen design in `docs/context-aware-ca-architecture.md`.

## Concepts

- **Snapshot**: one complete pinned import, keyed by
  `(source_name, file_date, converter, converter_version, sha256)` and stored
  under a `source_id`. Snapshots are **immutable**: a new import never mutates
  another snapshot's rows (physical keys are `(source_id, ent_seq)`, …).
- **Active pointer**: singleton row `jmdict_active_snapshot(singleton=1)` holding
  the live `source_id`. `NULL` means "dictionary not loaded" (Context-Aware
  degrades to `UNAVAILABLE/version-absent`). Activation/rollback = one atomic
  single-row `UPDATE` — content is never copied or rebuilt.
- **No tombstones**: an `ent_seq` absent from a new snapshot is an upstream
  removal. Rollback restores old rows because they were never touched.

## Authority and pinning

- Source authority: official EDRDG `JMdict_e` (English-only; non-English
  glosses carry separate copyright and are excluded).
- Ingestion projection: `jmdict-simplified` `jmdict-eng-<converterVersion>.json`
  (weekly Monday releases). CA-B1 verified pin: converter `3.6.2`,
  `dictDate` 2026-08-31, release tag `3.6.2+20260831182826`.
- Every snapshot records: source name/date, converter name/version,
  artifact sha256 (+ whether the hash was verified against an expected value),
  importer version (`cab1-1`), import timestamp. An import whose provenance
  cannot be established fails instead of creating an untraceable snapshot.

## Commands

All run from `server/` with the **admin** connection (`.env.postgres`).
The admin connection must be BYPASSRLS-capable (e.g. the `postgres`
superuser, as for the kanji-reference importer): reference tables use
`FORCE ROW LEVEL SECURITY` with only a `jlt_runtime` SELECT policy, so a
non-bypass admin role can neither read nor write them.

```powershell
npm run jmdict -- status
npm run jmdict -- import --file <path-to-jmdict-eng-X.Y.Z.json> [--expected-sha256 <hex>] [--activate] [--batch-size 500]
npm run jmdict -- verify --source <id>
npm run jmdict -- audit --source <id>
npm run jmdict -- activate --source <id>
npm run jmdict -- rollback
npm run jmdict -- prune --source <id>
```

Downloaded artifacts belong in `server/.cache-jmdict/` (git-ignored, never
committed). Transport integrity for the verified pin: TLS + exact release
asset byte count; content identity: recorded sha256 of the consumed file.

## Lifecycle

```
resolve pinned source → read artifact → verify checksum (if expected given)
→ allocate NEW source_id (status=importing)
→ normalize + import in bounded batches (one transaction per batch)
→ status=validating → integrity checks → C1 audit → status=ready
→ OPTIONAL explicit activate (never automatic)
```

- **Idempotent reimport**: identical identity + `ready` → reused, no duplicate.
  Identical identity stuck in `importing`/`validating`/`failed` → its rows are
  discarded and the import restarts under a fresh `source_id`. The ACTIVE
  snapshot is never touched by recovery.
- **Failed import**: pointer unchanged, other snapshots intact, status `failed`,
  truthful error. Partial rows may remain under the inactive `source_id`
  (invisibility comes from the pointer, not from one giant transaction).
- **Rollback**: pointer switch to the most recently activated ready snapshot.
  No re-download, no re-import.
- **Prune**: refuses the ACTIVE snapshot and the newest activated non-active
  snapshot (the rollback target). Never-activated snapshots prune freely.
  Child rows first, source row last, one transaction. Runtime cannot prune.

## Refresh expectation (licence condition)

The EDRDG licence asks dictionary-backed services to refresh at least
monthly. Procedure: download the new Monday `jmdict-eng-*.json`, import with
`--expected-sha256`, verify + audit, activate in a low-traffic window,
keep the previous snapshot as rollback target, prune older ones explicitly.

## Security boundary

- `jlt_runtime`: SELECT-only on all five tables; no INSERT/UPDATE/DELETE;
  no pointer UPDATE; no prune. `PUBLIC`/`anon`/`authenticated`: nothing.
- No `user_id` on reference tables; no user-table FK into them (asserted by
  test and by `postgres:verify-runtime-security`, which allowlists the five
  `<table>_runtime_select` policies).
- Pasted Analyzer text never leaves JLT infrastructure: no runtime download,
  no dictionary API, no external calls anywhere on this path.

## Known converter limitation (L1)

`jmdict-simplified` `JMdictKana` exposes `{text, common, tags,
appliesToKanji}` but drops XML `re_nokanji`. Consequence: a reading the XML
marks "cannot be written in kanji" looks fully applicable when its
`appliesToKanji` is `["*"]`. Residual risk is contained structurally —
kana-only entries have no `keb` rows so kanji observations can never match
them, and `appliesToKanji: []` (applies-to-none) is still flagged `nokanji`.
CA-B2's H4 rule must note this limitation; a future XML sidecar for
`re_nokanji` is explicitly out of scope for CA-B1.

## CA-B2 amendments (preserved, not implemented here)

- **A — request snapshot pinning**: Q1 must return/preserve the pinned active
  source metadata even with zero lexical matches; no second pointer read in
  the same request. One request = one snapshot.
- **B — safe identity keys**: reconstructed/inflected observed surfaces
  (行った, 行きました, 食べなかった, 来なかった, …) must NEVER become Q1
  dictionary identity keys. Identity comes from safe lemma/canonical, plus
  surface only when proven dictionary-form/uninflected.
- Frozen query caps recap: ≤30 candidates, ≤4 keys each, Q1 ≤720 rows with
  per-key 5+1 overflow sentinel, Q2 ≤150 entries with 64+1 sense valve,
  evaluate-before-display-truncate, `lookupTruncated`/`evaluationTruncated`
  conservative flags. No `LIKELY` in v1; "Compatible meaning" wording only.
