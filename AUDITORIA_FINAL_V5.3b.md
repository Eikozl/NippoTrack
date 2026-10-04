# AUDITORIA_FINAL_V5.3b

Sprint 1–4 sobre el cierre V5.3a (`bc8784e`): quick wins + deuda crítica,
insights semanales + vocab contextual, escritura MVP + social + export, y
pulido final. Todo en `dev`, `master` intacto, sin dependencias nuevas.

## Commits V5.3b (9)

- `7ce7d0f` fix(review): quick wins — empty states visibles en
  loadDifficult/loadHistory (antes se ocultaban), loading inicial,
  error state con reintento, toast fail-open en refresh, botones Reload en
  headers, role="list", fechas `<time dateTime>`, aria-labels. Fecha se
  queda en `en-US` fijo por decisión de usuario (no se aplica el revert a
  locale del plan). Entity: mensaje vacío en word examples. reviewHub
  49/50 (solo guard pre-existente).
- `fa338e7` test(qa): retry-once solo para `context omitted` (cold kuromoji
  init bajo contención). Lógica verificada + suite 11/11.
- `201fa5f` fix(dev): dev.js robusto + proxy integration. Espera con health
  checks en 2 fases (TCP→HTTP, backoff 3/5/10/30s, progreso cada 10s,
  `DEV_STARTUP_TIMEOUT_MS` default 180s, dual-stack localhost), logs a
  archivo con tails + limpieza de huérfanos al fallar, `--no-wait` conserva
  la salida inmediata. node corre nodemon/vite directo (las capas
  shell/cmd pierden la salida en Windows — 3 probes lo probaron). Proxy TCP
  3000→3101 detachado solo en integration (`scripts/dev-integration-proxy.js`).
  Validado: dev mode healthy end-to-end; proxy sirve /api/health.
  Integration full-stack no corre aquí (guard: sin env de cliente
  integration, pre-existente).
- `4d69804` feat(insights): weekly insights engine + API. Servicio ISO week
  (accuracy por tipo, strengths ≥80%, weaknesses <60% con mínimo 5,
  anomalía caída >50%, streak/JLPT/micro-goals vía smartGoals) +
  GET /api/insights/weekly, GET /history, POST /generate con caché por
  semana. Migración **029** (la 028 estaba ocupada por speech_rate), molde
  026, sin trigger. Verifier 48/52/23/0. Tests 5/5 + roundtrip live con
  cero residuo.
- `e8429a7` feat(vocab): cloze + tags + TTS. Cloze desde usage_examples
  propios (palabra→lectura→skip), sugerencias heurísticas documentadas
  (nunca auto-aplicadas), asignación reusa tags/tag_vocabulary por usuario
  (el smoke live cazó el UNIQUE real antes del commit). GET+PUT
  /api/vocabulary/:id/cloze|tags. Frontend vanilla: speech.js con
  veredictos, secciones Cloze Practice + Tags en entityPage. Tests server
  5/5, speech 4/4, regresión vocab-link 17/17, build ok.
- `9f7586c` feat(frontend): escritura MVP. kanjiWriting vanilla (canvas
  200px + grid, overlay SVG ordenado semitransparente, dibujo por pointer,
  validación SOLO orden por starts con tolerancia, feedback
  verde/naranja + veredicto, Clear/Retry/Done, tabindex + aria-live).
  Lógica pura en kanjiWritingLogic.js (testeable en Node). entityPage:
  sección Handwriting Practice + modal. review.js recall-kanji: diálogo
  Practice strokes (harness inyecta fake mount). Tests lógica 4/4,
  reviewHub 50/51 (solo guard), suites estáticas 89/89, build ok.
- `cc8ad61` feat(social): decks HMAC. Códigos firmados SHA256, TTL 90d,
  cap 200, creator hasheado, TTL/expirado→404; import crea filas nuevas
  con dedupe (vocab NULL-safe). JLT_DECK_SHARE_SECRET cierra los endpoints
  con 503 sin él (documentado en .env.example, sin valor). Diálogos vanilla
  Share/Import (checkboxes, copy con fallback, preview + confirm, refresh).
  Roundtrip HTTP live verificado, cero residuo. Tests 5/5, build ok.
- `0e651b3` feat(export): CSV/XLSX. GET /api/export?format=csv|xlsx&
  entities=… (/api/export plano conserva el backup JSON). CSV con BOM +
  metadata + secciones, streaming por páginas con backpressure; XLSX con
  writer mínimo propio (ZIP stored + inline strings, cap 50k/fila). Smoke
  HTTP de los 3 formatos. Tests 5/5.
- `6de4040` fix(provision): grants mínimos. REVOKE escrituras en las 7
  tablas read-only + UPDATE/DELETE en kanji_encounters, condicional a
  existencia (provision corre antes de migrate). Verifier 48/52/23/0.
  Corrida completa de provision bloqueada: sin JLT_RUNTIME_DB_PASSWORD
  (con el cluster manager, pre-existente).

## Deudas técnicas (tabla)

| # | Deuda | Severidad | Acción |
|---|-------|-----------|--------|
| 1 | JLT_RUNTIME_DB_PASSWORD pendiente | Alta | Cluster manager; luego provision + verifier |
| 2 | `node dev.js --integration` sin env cliente | Media | Crear client integration env seguro |
| 3 | Guard reviewHub en rojo (`Repeat failed` copy) | Baja | Renombrar copy o ajustar guard |
| 4 | firstUseDashboard P1 matrix ×2 | Baja | Tickets pre-existentes, no tocar sin spec |
| 5 | Kuromoji init ~29s vs budget 15s (4 suites parser) | Media | Budget o warmup; retry-once solo mitiga 1 test |
| 6 | XLSX sin estilos ni shared strings | Baja | Documentado; exceljs solo si se acepta dep |
| 7 | JLT_DECK_SHARE_SECRET sin valor en ningún env | Media | Generar y repartir fuera del repo |

## Flaky test documentado

`context-analyze-api.test.js` › `context omitted`: cold kuromoji init supera
el budget bajo contención → lexical `unavailable`/timeout. Workaround:
`retryOnceOnFlakyInit` local al test (1 reintento solo ante
unavailable|timeout; lo demás falla directo). No global.

## Provision/Verifier

Inconsistencia cerrada en código (D2): el GRANT amplio queda estrechado a
los sets del verifier. Orden soportado provision→migrate sin rollback.
Falta la corrida real (bloqueada por #1).

## DB drift

`tags` real ≠ baseline 001: tiene `user_id` + UNIQUE(user_id,
normalized_name) (migs 004/005). El servicio de tags se corrigió contra la
DB viva (no contra el baseline). Lección: smokes live antes de asumir DDL.

## Decisiones V5.3b

- Sin subagentes disponibles en esta sesión: ejecución directa secuencial
  con suites en background (procesos detached + poll) como paralelismo.
- Fecha historial: inglés fijo (respuesta usuario), no locale navegador.
- Componentes: vanilla JS (respuesta usuario), JSX solo si vanilla no
  bastara (no hizo falta).
- Migración insights = 029 (028 ocupada).
- dev.js duplicado QW2/D1: una sola implementación.
- UI en inglés (Reload/Refreshing) en vez de emojis/中文 del plan.
- XLSX propio sin exceljs (restricción sin deps).

## Checklist V5.4

- [ ] Password runtime → provision + verifier en staging
- [ ] Env cliente integration → validar `dev.js --integration` full
- [ ] Guard reviewHub + firstUseDashboard P1 (spec primero)
- [ ] Migraciones 021–029 a preview/producción (runbook)
- [ ] JLT_DECK_SHARE_SECRET en envs seguros (no repo)
- [ ] Dashboards: widgets de insights + export UI si hay demanda

## Validación final

- Suite server: 761 tests / 731 pass / 0 fail / 30 skipped
- Suite client: 665 tests / 657 pass / 3 fail (los 3 pre-existentes:
  firstUseDashboard P1 ×2 + guard gamificación) / 5 skipped
- reviewHub: 50/51 (solo guard pre-existente)
- review-v2: 15/15 · insights 5/5 · vocab-contextual 5/5 · deck 5/5 ·
  export-tabular 5/5 · speech 4/4 · kanjiWriting 4/4 · vocab-link 17/17 ·
  estáticas cliente 89/89
- Build: OK (último 28s)
- Verifier dev: 48 tablas / 52 policies / 23 triggers / failures []
- Git: dev limpio salvo .opencode/ + pnpm-lock.yaml (untracked
  permitidos); master 3c7a422 intacto; sin merges; sin deps nuevas
- Post-cierre: JLT_DECK_SHARE_SECRET generado en server/.env.development (gitignored, solo dev) + API reiniciada; Share/Import dejan el 503. Practice strokes tambi�n en recognition-kanji (antes solo recall).
- Congelado 5.3b: Watch order en escritura (replay trazo a trazo con dash animation + reduced-motion, reutiliza STROKE_DRAW_MS/PAUSE); Practice strokes tambi�n en recognition-kanji; borrado de historial (trash por fila con confirm + Clear history general con confirm; DELETE /sessions/:id y DELETE /sessions owner-scoped, cascadas verificadas en DDL; roundtrip live crear?borrar?404 + foreign 404, cero residuo).
