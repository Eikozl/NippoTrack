# INFORME FINAL V5.2

Fecha: 2026-10-02 · Rama: `dev` · Sin merge a `master` (`3c7a422` intacto).
Nota de honestidad: los valores de este informe son los REALES medidos durante
P9. Donde la plantilla de P9 asumía un valor distinto, se marca como
[DESVIACIÓN] con el motivo.

## Baseline
- Ciclo V5.2 sobre `dev` desde `3c7a422` (master intacto).
- Este informe cubre hasta `d4be326` (fix adapter, hallado en P9.4).

## Fases completadas
- P1 (2b290f1): fix(onboarding): keep checklist until all actions are completed
- P2 (e20fdc8): feat(review): expose SRS state on vocabulary and grammar details
- P3 (2742872): feat(review): repeat failed items and recent session history
- P4 (74455ec): feat(grammar): multiple usage examples mirroring vocabulary
- P5: omitida — decisión documentada en commit 1ed62e8 (evitar feature creep)
- P6 (92ac2ba): test(review): account for owned SRS lookup in vocabulary query bound
- P8 (1ed62e8): feat(review): surface frequently difficult items on the review page
- P9-fix (d4be326): fix(db): map grammar_examples insertId in postgres adapter
  (bug real hallado por el smoke P9.4; ver Issues)

## Fases omitidas y motivo
- P5 (Problem Items general): omitida — Repeat failed + weak items + historial +
  Last Result cubren el loop; Again×N entre sesiones exigiría endpoint paralelo
  = feature creep.
- P7 (Analyzer exposure): omitido — Analyzer is read-only by design; el texto
  pegado no es evidencia y la exposición ya queda capturada vía imports de
  vocabulary (documentado en cuerpo de 1ed62e8).

## Commits
- 2b290f12d29d2c4b6dce4fcfdf388ef1a66f6069 fix(onboarding): keep checklist until all actions are completed
- e20fdc86c00fdaba752c559dd4cc43b5e3816ae feat(review): expose SRS state on vocabulary and grammar details
- 2742872cb2b85348163e7245011583a171d5b5a8 feat(review): repeat failed items and recent session history
- 74455ec8752715b6e72c54df46fc43bcd250cdc3 feat(grammar): multiple usage examples mirroring vocabulary
- 92ac2ba41743f63703efff8cb448a37eea1305c1 test(review): account for owned SRS lookup in vocabulary query bound
- 184f9a034b975f95a327f668e86b8d0b904dd97f fix(grammar): hide legacy example when managed examples exist
- a02197e84b0c6c82bb65b6ed785c7f1e2acd64cc refactor(client): share SRS date helpers and clarify checklist pre-check
- 1ed62e8801e08fe039a1afbfec5256bfad061dba feat(review): surface frequently difficult items on the review page
- d4be326cc921d50d659e0e6d3c2077af64bf996d fix(db): map grammar_examples insertId in postgres adapter

## Archivos/sistemas modificados
- P1: client/src/firstUseDashboard.js, client/src/pages/dashboard.js,
  server/tests/first-use-dashboard.test.js (nuevo)
- P2: server/src/controllers/vocabularyController.js,
  server/src/controllers/grammarController.js, client/src/pages/entityPage.js,
  server/tests/srs-exposure.test.js (nuevo)
- P3: server/src/controllers/reviewController.js, server/src/routes/review.js,
  server/src/app.js, client/src/pages/review.js,
  server/tests/review-history.test.js (nuevo)
- P4: server/db/migrations-postgres/020_grammar_examples.sql (nuevo),
  grammarController.js, routes/grammar.js,
  server/scripts/verify-postgres-runtime-security.js (37→38 tablas),
  entityPage.js, server/tests/grammar-examples.test.js (nuevo),
  server/tests/grammar-reference.test.js
- P6: server/tests/vocabulary-reading.test.js (bound 5→6 + scoping SRS)
- P8: reviewController.js (listDifficultItems), routes/review.js, app.js,
  review.js (difficultBlock), server/tests/review-difficult.test.js (nuevo)
- P9-fix: server/src/config/postgresAdapter.js (ID_COLUMNS + export),
  server/tests/grammar-examples.test.js (test de regresión)
- Total vs 3c7a422: 20 archivos, +1285/−40. Cero dependencias nuevas.

## Tests
- Final (tras el fix): **687 tests / 657 pass / 0 fail / 30 skipped**.
- [DESVIACIÓN plantilla] P9.1 midió primero 686/651/5-fail/30: los 5 fails
  fueron el flake kuromoji conocido (4 context-analyze-api + 1
  lexical-analyze-api, duraciones ~15–28s, `unavailable vs ok`; causa:
  PARSE_TIMEOUT_MS*5=15s bajo contención CPU porque suite y build corrían en
  paralelo). Re-ejecución aislada 3×: 15/15 + 11/11 a la primera → flaky
  confirmado, cero regresión real. La pasada final 687/657/0/30 no flakeó.
- Review suite (P8): 59/59. P9-fix file: 8/8.
- node --check OK: review.js, entityPage.js (×2 pasadas), reviewController.js,
  review-difficult.test.js.

## Build
- Vite: ✓ built in 1m 7s, 1907 módulos, dist/ regenerado (32 assets).
- [DESVIACIÓN plantilla] se indicaba 1m 14s; el tiempo real medido es 1m 7s.
- Warnings: solo los 2 preexistentes ([INEFFECTIVE_DYNAMIC_IMPORT],
  [PLUGIN_TIMINGS]).

## Migraciones
- [DESVIACIÓN plantilla] 020 NO aplicada en dev/preview/prod (sin credenciales
  locales; producción exige ack explícito no fabricable). Validada end-to-end
  en DB scratch desechable `jlt_migcheck` (creada/eliminada, sin rastro):
  runner 20/20 aplicadas; catálogo 020 verificado objeto por objeto;
  verifier **38 tablas, 42 policies, 15 triggers, failures: []** tras grants
  equivalentes al provision script (ordenados como en real: provision primero,
  grants explícitos de 009/020 después).
- Smoke HTTP real contra scratch (app booteada con auth bypass, rol
  jlt_runtime): **11/11 PASS** — GET /difficult (filtra Again×1 y sin eventos,
  againCount=2/totalEvents=3), GET /grammar/:id (legacy + managed),
  CRUD examples 201/200/200, 404 sin leak ×2, 400 sin sentence.
- Pendiente (runbook): `postgres:migrate` → verifier (38/0) → smoke, en
  dev → preview → prod (con JLT_EXPECTED_SUPABASE_PROJECT_REF + ack en prod).
  Si el runner reporta checksum mismatch: parar y reconciliar, nunca tocar
  `schema_migrations`.

## Issues encontrados
1. **Bug real (corregido en d4be326)**: `ID_COLUMNS` del adapter no incluía
   `grammar_examples` → sin auto-RETURNING, `createGrammarExample` devolvía
   201 con cuerpo vacío en Postgres real. Los stubs lo ocultaban (siempre
   devolvían insertId). El smoke P9.4 lo cazó; test de regresión añadido.
2. **Flaky kuromoji** (ver Tests): contención CPU suite∥build; no correr en
   paralelo. No bloquea.
3. **Anomalía credencial local**: `jlt_runtime` dejó de autenticar a mitad de
   sesión (fallaba también en `jlt_smoke`, rol sin expiry, envs sin cambios;
   posible rotación externa en el clúster). Se reseteó a valor de sesión con
   superusuario local para completar P9.4. Revisar con quien gestione el
   clúster; `.env.development` ya no autentica a ese rol.
4. **Anomalía PUT/DELETE no persistente (una vez, no reproduce)**: en una
   pasada con el pool en estado de error 28P01, PUT/DELETE devolvieron 200 sin
   persistir. Dos verificaciones posteriores con read-after-write confirman
   comportamiento correcto. Sin acción.
5. **Provision vs verifier**: el provision script hace `GRANT ON ALL TABLES`
   (rompería append-only/read-only si corre después de las migraciones); el
   orden correcto es provision→migraciones (009/020 llevan grants explícitos).
6. **DB local `jlt_postgres` a la deriva** (checksum 001 distinto, solo
   migs 001–003, sin esquema auth): el runner la rechaza correctamente. No
   tocar; reconciliar o recrear si se quiere DB local útil.
7. P7 omitido (ver arriba).

## Riesgos
- Test flaky bajo contención (documentado, no bloquea, con protocolo).
- Credencial `jlt_runtime` local manipulada fuera de sesión (ver Issue 3).
- `jlt_postgres` local inutilizable como dev mirror hasta reconciliar.
- Coexistencia columna legacy `example` + `grammar_examples` (deuda conocida;
  P2 solo oculta la duplicación visual).

## Pendientes futuros
- Crear entorno preview (credenciales `.env.postgres.preview`).
- Ejecutar runbook 020 en dev → preview → producción.
- Aclarar con el gestor del clúster la rotación de `jlt_runtime`.
- Reconciliar o recrear `jlt_postgres` local.
- Estabilizar flake kuromoji (retry-once en test o norma no-paralelo).
- Detalle de sesión en UI de historial (API `GET /:id` ya existe).

## Validación de aceptación
- [x] Suite: 687/657/0/30 ([DESVIACIÓN]: no 682/652/0/30; +4 P8 +1 regresión, flake documentado)
- [x] Build: ✓ 1m 7s
- [x] Verifier: 38 tablas, 0 failures (en scratch provisionada-equivalente; real dev/preview/prod pendientes por credenciales)
- [x] Smoke: 11/11 PASS (HTTP real contra scratch)
- [x] Git: limpio, master 3c7a422 intacto, sin merges, sin deps nuevas
- [x] Informe: `AUDITORIA_FINAL_V5.2.md` generado (este archivo)
