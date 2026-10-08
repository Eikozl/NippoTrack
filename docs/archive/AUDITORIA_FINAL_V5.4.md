# AUDITORIA_FINAL_V5.4

Versión pequeña de deudas técnicas sobre el congelado V5.3b. Todo en `dev`,
`master` intacto en `3c7a422`, sin dependencias nuevas, sin JSX (vanilla por
decisión de usuario que se mantiene).

## Commits V5.4

- `1f659b1` (venía del cierre 5.3b): watch-order replay + history delete.
- `0b9d527` fix(writing): flush de animaciones por replay (fill-forwards
  tapaba el redibujado), canvas 260px, botones 2×2 compactos.
- Deploy DB prod (sin commit de código; envs gitignored):
  `server/.env.postgres.prod` (pooler us-east-2:6543),
  `server/.env.production` (JLT_DECK_SHARE_SECRET propio),
  `client/.env.integration` (copiado del repo viejo: proyecto testing).
- `0b3ce73` feat(v5.4): widget insights en dashboard (vanilla, fail-open)
  + export Anki (TSV front/back) y Obsidian (md por entidad). Fix: `csvCell`
  ahora cita tabs; crash `documents is not defined` cazado por smoke HTTP.

## Deploy preview/prod

- Preview: NO EXISTE proyecto preview. El proyecto testing
  (`mufxygohcjikhlktvrcy`) hace de staging y ya estaba migrado+verificado.
  No se inventó nada.
- Prod (`milayuvlajmgrcxmrxdg`): estado inicial 37 tablas + solo el pin de
  conteo en rojo. Migración 020–029 aplicada (10 archivos, transacción
  única). Verifier prod: 48 tablas / 52 policies / 23 triggers / failures [].
  Smoke de esquema con limpieza: ok.
- Reconciliación de checksums (18 archivos 001–019, documentada): el repo
  evolucionó tras el baseline de prod; se auditó que todos los padres que
  020–029 tocan existen en prod (information_schema) y el verifier estaba
  verde en RLS/policies/grants antes de tocar nada. Runner atómico: cualquier
  fallo habría hecho rollback total.
- Secrets: deck secret de dev en `server/.env.development` (gitignored) +
  API reiniciada (adiós 503); secret propio de prod en
  `server/.env.production` (gitignored). Los .env nunca se commitean
  (verificado con git check-ignore).
- Pendiente (requiere despliegue de app + password runtime, no disponible):
  smoke de ruta con rol jlt_runtime en prod; `node dev.js --integration`
  full (sin env de cliente integration en este equipo).

## Decisión: dynamic intervals (se mantiene opt-in)

La fórmula `interval = base * (1/facility)^reps` ALARGA intervalos al fallar
(inverso a SRS clásico; flaggeado spec-verbatim en el código). Promoverla a
default degradaría a todos los usuarios sin evidencia. El `engine_mode` por
usuario ya es el flag de rollout. Sin cambio de código (el comportamiento ya
es el correcto); si algún día se quiere por default, primero hay que corregir
la fórmula con nueva spec (rompe los pins verbatim actuales).

## Validación final

- Suite server: 763 tests / 733 pass / 0 fail / 30 skipped
- Suite client: 668 tests / 660 pass / 3 fail (pre-existentes: P1
  firstUseDashboard ×2 + guard gamificación) / 5 skipped
- reviewHub: 54 tests (incluye borrado de historial + practice strokes)
- Build: OK (~49s)
- Verifier dev: 48/52/23/0 · Verifier prod: 48/52/23/0
- Git: dev limpio salvo `.opencode/` + `pnpm-lock.yaml` (untracked
  permitidos); sin merges; sin deps nuevas

## Deudas restantes / V5.5

- Pulidos Vocab + Decks: pendientes de bullets del usuario.
- Guard reviewHub + firstUseDashboard P1 (spec primero).
- `node dev.js --integration` full con env cliente integration.
- Smoke runtime (jlt_runtime) en prod tras desplegar la app.
- Migraciones 021–029 ya en prod: marcar runbook como aplicado.
- V5.5: INIT_TIMEOUT_MS=60s separado del parseo (3s) en japaneseParser: la carga fr�a del diccionario es I/O (10-30s en este equipo), no parseo roto; dicts ausentes siguen fallando r�pido por el builder. Las 4 suites parser (japanese-parser 8/8 + lexical/context 43/43) pasan.
