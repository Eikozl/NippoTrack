# AUDITORIA_FINAL_V5.5

Re-arquitectura social aprobada por el usuario (foundation-first) + parser +
deuda documentada. Todo en `dev`, `master` intacto en `3c7a422`, sin
dependencias nuevas, vanilla JS (sin JSX).

## Commits V5.5

- `4e67f60` fix(parser): INIT_TIMEOUT_MS=60s separado del parseo (3s).
  Suites parser verdes: japanese-parser 8/8 + lexical/context 43/43.
- `752303c` feat(social) foundation (M030): username/bio/avatar/is_public
  en user_profile + deck_publications (snapshots) + items + follows.
  Endpoints /api/decks, /api/users/:username/* (spec paths). Verifier
  51/55/23/0. Tests 5/5 + roundtrip live sin residuo.
- `b88758d` feat(social) suggestions (M031): PRs ligeros title/description
  con razones, owner-only, accept aplica, decided-once. Verifier 52/56/23/0.
  Tests 5/5.
- `3c90027` feat(deck) collections (M032): playlists ordenadas + share
  HMAC autocontenido + import-all con dedupe. Verifier 54/58/23/0. Tests
  5/5 + roundtrip live sin residuo.
- `b19269d` feat(social) analytics + UI: GET /decks/:id/analytics
  owner-only (followers, daily, sugerencias, items); entityPage Publish +
  Browse (follow, view). Tests 6/6 en foundation.
- Decisiones (sin código): dynamic intervals se queda opt-in (ya en
  auditoría V5.4); fecha historial en-US (decisión ×2 del usuario, no se
  revierte); D4 sin geografía/dispositivos (privacy-first se mantiene en
  telemetría aunque los decks sean públicos).

## Desviaciones del plan pegado (conscientes)

- Migraciones 030/031/032 reales (el plan pedía 032–035 sin revisar qué
  número iba libre; la 029 estaba ocupada).
- Sin JSX: componentes vanilla (decisión vigente del usuario).
- Sin columna vocabulary.tags ni migración: se reusó tags/tag_vocabulary.
- Romaji tolerance omitido (conversión es server-side por request).
- Decks multi-entidad no implementados (single-entity + selectedItems).
- Preview/Deploy ya hechos en V5.4 (no re-ejecutados).
- "≥1500 tests" del plan: total real 1452 (784+668); no se infló.

## Validación final

- Suite server: 784 tests / 754 pass / 0 fail / 30 skipped
- Suite client: 668 tests / 660 pass / 3 fail (pre-existentes:
  firstUseDashboard ×2 + guard gamificación) / 5 skipped
- Nuevas suites: foundation 6/6, suggestions 5/5, collections 5/5
- Build: OK (~68s)
- Verifier dev: 54 tablas / 58 policies / 23 triggers / failures []
- Verifier prod: pendiente re-correr tras M030–M032 (mismo procedimiento
  atómico que 020–029)
- Git: dev limpio salvo `.opencode/` + `pnpm-lock.yaml`; sin merges

## Pendiente / V5.6

- Migraciones 030–032 a prod (runbook V5.4) + verifier prod.
- Pulidos Vocab/Decks: bullets del usuario (2 veces ofrecidos).
- Guard + firstUseDashboard P1 (spec primero, no tocar a ciegas).
- Password rol runtime + smoke jlt_runtime en prod.
- UI sugerencias/colecciones/analytics (backend listo y testeado).
- Profile page /u/:username (backend listo).
- Social UI: p�gina Decks (nav Library): browse p�blico con follow/view, mis decks con inbox de sugerencias + analytics, collections con create/share, formulario de perfil p�blico. PUT /api/users/me (409 si tomado). Smoke HTTP con limpieza. Nav test actualizado.
- Deploy: .env.production completado; prod migrada 030-032; provision total imposible (sin CREATEROLE en Supabase) E innecesario (verifier verde: los grants vienen de las migraciones); rotar el password del rol romper�a la app y no se hizo.
