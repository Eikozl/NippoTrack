# INFORME FINAL V5.3a

Fecha: 2026-10-02 · Rama: `dev` · Sin merge a `master` (`3c7a422` intacto).
Ciclo V5.3a sobre `dev` desde `81920ae` (fin del ciclo anterior). Este
informe cubre hasta el commit de cierre. Los valores son los REALES medidos;
donde el prompt de V5.3a asumía otra cosa se marca como [DESVIACIÓN].

## Baseline
- 8 commits de feature/fix + este cierre: 9f16032, af01f33, 2b4cea4, 0b9b6f3,
  d796b80, 2b7d9d7, 9d65ee5, 3ae8d08 (+ chore final).
- 41 archivos, +5,739/−67 vs 81920ae. Cero dependencias nuevas.

## Fases completadas
- **Inmersión Asistida** (Sprint 1-2)
  - 9f16032 backend: migración 021 (immersion_sessions + immersion_session_items,
    RLS modelo 020, ensancha el CHECK de kanji_encounters para reusar el recorder
    existente), pipeline analyze/create-session/history, verifier 38→40.
  - af01f33 frontend: página /immersion (grupos con checkboxes, Select all/Clear,
    nivel estimado, historial read-only), integración en Review ("From text",
    banner de hand-off), nav + iconos + i18n, tests cliente 7/7.
  - 3ae8d08 fix de aceptación (ver Issues): queue hand-off + repair de history.
- **Lectura Graduada** (Sprint 3-4)
  - 2b4cea4 backend: migración 022 (reading_sources, reading_texts con user_id
    NULL = biblioteca compartida, user_reading_progress), clasificador
    determinista (reusa estimateDifficultyLevel + kanji_reference + grammar),
    anotaciones posicionalmente correctas, fuentes NHK Easy RSS + listado
    Aozora con allowlist fija de hosts (https, host exacto, sin puerto ni
    credenciales, timeouts y byte caps), verifier 40→43.
  - 0b9b6f3 frontend: /reading (biblioteca con filtros + import + texto propio),
    lector con anotaciones inline (tooltip kanji, modal vocab/grammar con
    "Add to my collection" vía POST existentes, degradado honesto sin meaning
    de referencia), toggle de anotaciones, slider de fuente, progreso con
    autosave 30s (siempre manda posición+tempo juntos por el contrato PUT),
    vista de progreso con barras de 8 semanas. + GET /api/reading/progress.
- **Review 2.0** (Sprint 5-6)
  - d796b80 backend: migración 023 (user_review_preferences, review_patterns,
    columnas aditivas card_type/difficulty_score en review_sessions), motor de
    tipos de tarjeta + preferencias, /due enriquecido con cardTypes, patrones
    heurísticos (kanji-reading-confusion, grammar-family-failures,
    vocabulary-frequent-again) con storage replace-per-detection, calculadora
    de intervalos dinámicos spec-verbatim opt-in, verifier 43→45.
  - 2b7d9d7 frontend: diálogo de preferencias (checklist + sliders), rotación
    ponderada determinista, tarjetas Recognition/Recall (inversión de caras),
    Audio (Web Speech API ja-JP), Cloze (frase real vía lazy fetch con
    fallback recognition), panel de patrones con "Practice these".
- **Metas Inteligentes** (Sprint 5-6)
  - 9d65ee5: migración 024 (user_smart_goals), heurísticas 100% locales
    (adjust ±20%, streak con días de gracia por semana ISO, predicción JLPT
    por volúmenes documentados, micro-metas con deadline del domingo),
    endpoints GET/PUT/POST /api/goals/smart*, widget en Dashboard + sección
    en Settings, verifier 45→46.

## Tests
- Suite server final: **716 tests / 686 pass / 0 fail / 30 skipped**
  (687 base + 29 nuevos: immersion 7, graded-reader 8, review-v2 8,
  smart-goals 6).
- Suites client afectadas: immersion 7/7, navigation 9/9,
  vocabularyAutofill 40/40, reviewHub 25/26, firstUseDashboard 23/25.
- [DESVIACIÓN plantilla] El prompt exigía "suite completa 687+" — el número
  real tras V5.3a es 716; los 687 eran el baseline del ciclo.
- Failures pre-existentes en HEAD (no tocados, verificados con stash): 1×
  reviewHub COMPLETE (copy "Repeat failed" de P3 vs guard de gamificación) y
  2× firstUseDashboard (semántica P1). Ninguno fue introducido por V5.3a.

## Builds
- Vite por sprint: 1m03s (1B), 57s (2A), 1m03s (2B), 1m11s (3B), 1m43s (P4),
  1m19s (fix). 1910 módulos, chunks nuevos: immersion 6.9kB, reading 14.5kB,
  smartGoals 3.8kB, review 27.9kB. Solo los 2 warnings preexistentes.

## Migraciones
- 021-024 aplicadas en JLT testing (mufxygohcjikhlktvrcy) con el runner
  canónico + guarda de ref esperado. Verifier final: **46 tablas de aplicación
  / 50 policies / 23 triggers / failures: []**. Pins de grammar-reference
  actualizados por migración (38→40→43→45→46).
- [DESVIACIÓN plantilla] No aplicadas a preview/producción (sin credenciales
  de preview; producción exige ack). Runbook idéntico al de V5.2.

## Smokes contra la DB real (usuario sintético + bypass local, cero residuo)
- Immersión end-to-end: **8/8** — analyze clasifica N4 con glosses reales de
  JMdict (日本語 → "Japanese (language)"), create-session transaccional
  (1 vocab + 7 kanji + review session + items + encounters con provenance
  `immersion_session`), el queue devuelto gradea contra la sesión abierta,
  /due respeta la semántica inert congelada, history, 400 en selectedItems
  malformado.
- Lectura: **9/9** — user-text clasificado N4 con 11 anotaciones reales,
  GET text con anotaciones y progreso, library con knownKanjiPct,
  progreso idempotente (UNIQUE user+text), 404 ajeno, 400 en filtro inválido,
  import NHK degrada a `{status:'unavailable'}` (sin salida de red en esta
  máquina) — jamás 5xx.
- Smart goals: **6/6** — defaults, persistencia de preferencias, predicción
  N3 coherente, adjust sin actividad, 400, 401.

## Issues encontrados y resueltos durante la validación
1. **[3ae8d08] History de inmersión crasheaba en SQL real**: los `?` de los
   FILTER aparecen antes que los del WHERE en el texto SQL, pero los params
   iban en otro orden → `'grammar'` caía en el slot uuid de `user_id`. Los
   unit tests con stubs regex no lo veían; el smoke live sí. Fix: literales
   inline en los FILTER (constantes, nunca input del usuario).
2. **[3ae8d08] Hueco de aceptación en el loop Texto→Sesión→Review**: los
   items recién enrolados no tienen review_events, así que el descubrimiento
   por rango de fechas NUNCA podía mostrarlos. Fix: create-session devuelve
   `items[]` con entityIds resueltos por el server; la página de inmersión
   guarda `{reviewSessionId, items}` en sessionStorage (por pestaña, se
   consume una vez) y Review arranca REVIEWING directamente contra la sesión
   abierta recién creada. El grading sigue validando ownership server-side.
3. **Fórmula dinámica del prompt invertida (flag)**: `interval = base *
   (1/facility)^reps` alarga los intervalos cuando facility < 1 — lo inverso
   del ease clásico de SRS. Implementada VERBATIM (spec) + pineada por tests,
   pero opt-in (`engine_mode='dynamic'`); el default `fixed` conserva la
   curva 1/3/7 congelada de V5.2 byte-idéntica. Requiere revisión de producto
   antes de promoverla a default.
4. **Fuentes externas**: en esta máquina no hay salida a internet, así que el
   import real de NHK/Aozora solo pudo validarse en su path de degradación
   (200 unavailable, nunca 5xx) + con fixtures en los unit tests. Los
   fetchers tienen allowlist estricta (host fijo, https, sin puerto ni
   credenciales, byte caps, timeout 8s).
5. Subagente 2A cancelado a mitad por límite de créditos → completado a mano
   conservando su esqueleto (migración 022 + verifier). Un intento de
   subagente 1B no produjo nada → relanzado con éxito. Todos los commits
   fueron verificados personalmente antes de committear (un dev.js no
   autorizado de un subagente fue revertido).

## Desviaciones documentadas (vs el prompt V5.3a)
- **Sin JSX**: el cliente es JS vainilla; los `.jsx` del prompt se
  implementaron como módulos `.js` con el helper `element()` (crearlos como
  JSX rompería el build — no hay React).
- **reviewEngine.js y goalsController.js no existían** (el prompt decía
  EXTENDER): creados nuevos; el CRUD manual de goals (v2) no se tocó y
  /api/goals/smart* coexiste por fall-through del router.
- **userId de body ignorado** en POST /api/reading/analyze (el prompt lo
  pedía): ownership SIEMPRE req.user.id.
- **"Practice these"** de patrones pre-selecciona el tipo de material y entra
  al SETUP; una mini-sesión por items exactos requiere un endpoint dedicado
  (diferido, documentado).
- **Cloze** hace fallback a recognition cuando no hay frase disponible
  (fail-open); **kanji "similares"** se aproximan por lecturas compartidas
  (kanji_reference no tiene columna de radicales).
- **Historial de inmersión read-only** (el payload no lleva reviewSessionId;
  "repetir" duplicaría sesiones) — documentado en la página.

## Riesgos
- El hand-off del queue usa sessionStorage (por pestaña, una sola lectura):
  si el usuario abre /review sin pasar por la inmersión, queda el banner
  informativo. Tampering del queue no escala privilegios (gradeEntity valida
  ownership de entidad y sesión).
- TTS de tarjetas Audio depende de `speechSynthesis` del navegador (guardado;
  sin TTS la tarjeta degrada a reveal manual).
- Los step-stubs de grading quedaron acoplados al SELECT de preferencias
  (paso 1 del contrato transaccional) — documentado en cada test.

## Pendientes futuros
- Aplicar 021-024 a preview/producción con el runbook (postgres:migrate →
  verifier 46/0 → smoke).
- Decidir el destino del engine_mode dynamic (fórmula invertida, Issue 3).
- Mini-sesiones enfocadas por items exactos (endpoint nuevo).
- Import real NHK Easy/Aozora desde un entorno con salida a internet.
- Tickets pre-existentes de client tests (reviewHub copy P3,
  firstUseDashboard P1).
- Aplicación móvil del lector (tooltip hover → tap) si hay demanda.

## Validación de aceptación V5.3a
- [x] Inmersión: Texto → Analizar → Seleccionar → Crear sesión → Review inicia con items (queue hand-off, smoke 8/8)
- [x] Lectura: Biblioteca → Lector con anotaciones → Add entity → Stats (smoke 9/9 + UI)
- [x] Review 2.0: Tipos configurables → Review usa tipos → Patrones detectados → Intervalos dinámicos (opt-in, spec-verbatim, flag)
- [x] Metas: Auto-ajusta → Predicción JLPT → Micro-metas → UI Dashboard/Settings (smoke 6/6)
- [x] Suite: 716/686/0/30 (≥687 requerido)
- [x] Build: ✓ (1m19s, 1910 módulos, solo warnings preexistentes)
- [x] Verifier dev: 46 tablas / 0 failures
- [x] Git: master 3c7a422 intacto, sin merges, sin deps nuevas, cero secretos
- [x] Documentación: `AUDITORIA_FINAL_V5.3a.md` (este archivo)

## V5.3b � post-freeze hardening (dev: f953019, 67706c0, b9968c5, + cierre)
- Review history: la fila abre el openDetailModal propio ('<Tipo> Review Session � <fecha>') con items y kanji enlazados a su kanji-reference (stroke order). Tests reviewHub reescritos al modal (25/26; el fallo restante es el guard pre-existente).
- Review: bot�n 'Start immersed review' junto a 'Start review'; eliminado el atajo 'Card types' del intro (sigue en opciones). Card types documentadas en el di�logo + voz japonesa expl�cita y avisos si el TTS no existe.
- Reading: selects con value reales (el 400 'level must be one of...' era label enviado como valor); header del lector y panel de filtros reorganizados m�vil-first; slider con id/acento; barra = furthest-read (seed + mon�tona).
- Progreso servidor: GREATEST en el upsert + eco del valor guardado (el adapter descarta extras del RETURNING: se lee de vuelta). Regresi�n imposible punta a punta (verificado live).
- Aozora: �ndice vivo sakuhin_a1.html + links relativos ./files + transcodificaci�n euc-jp/shift_jis + import en background (202 + poll, textos por commits individuales). Verificado live: 202 en <1s, primera fila <60s, N1 real, 0 mojibake.
- NHK Easy retirado (feed 404, JSON 401, HTML sin enlaces): sin bot�n, sourceType solo aozora, tests y docs actualizados.
- Delete de textos propios: DELETE /api/reading/text/:id (solo due�o; 404 ajeno/compartido) + bot�n con confirmDialog igual que los CRUDs.
- 'Suggested goals' (antes 'Smart goals') en UI; mismo fix de option-value en sus selects.
- Notas de entorno: kuromoji tarda ~29s en esta m�quina (benchmark 1.4s) � los 4 suites de parser fallan por timeout de init 15s; pooler Supabase con ECONNRESET/timeouts espor�dicos; un flake del classifier (vocabUnknown 0/1 en primera tokenizaci�n) aparece bajo carga. Nada de esto lo toca este diff.
- Import con elecci�n (b0a20fa+): GET /api/reading/import/preview lista hasta 20 obras (t�tulos+URLs, sin descargar art�culos); el di�logo muestra checkboxes con Select all/Clear y POST importa solo las URLs elegidas (validadas: https + host + patr�n card, intersectadas con el �ndice vivo). Verificado live: preview 20 obras, 2 elegidas aterrizan y nada m�s.
- Save atascado: el di�logo de card types no cerraba al guardar y el bot�n quedaba girando para siempre (los CRUD cierran; este no). Ahora libera el estado, muestra '? Saved' 1s y cierra; el error de validaci�n tambi�n libera.
- Voces: bot�n 'Preview Japanese voice' en el di�logo (habla una frase de prueba) + nota si no hay voz japonesa instalada. Audio solo aparece en tarjetas de vocabulario con el tipo activado; kanji cae a recognition (documentado en el di�logo).
- Delete en tarjetas: papelera abajo-derecha de cada texto propio (icono Trash2 + regla .icon-button--danger); importados sin bot�n; refresh in place tras borrar. Se quit� el bot�n del header del lector.
- Picker con b�squeda (pendiente commit): preview acepta ?index= (grupos kana a/ka/sa/ta/na/ha/ma/ya/ra/wa validados) para variar las obras; el di�logo suma selector de grupo + b�squeda por t�tulo en vivo + Select all solo-visibles. Niveles en el picker no son posibles sin analizar (~1min/texto): el filtro por nivel vive en la biblioteca (ya corregido).
- Import por link: POST /api/reading/import/url {url} (202 + background + poll). La URL se valida en controlador y servicio (solo card pages https del host); el t�tulo sale del <title> de la card ('?????:X'). Verificado live: 400 a host ajeno, 202 v�lido, texto real N1 sin mojibake.
- Persistencia compartida: el loop de sync extra�do a persistImportItem (bulk y link usan el mismo commit por item).
- Docs de endpoints: cat�logo en app.js con preview + import/url + DELETE text.
- Filtro por nivel verificado live: 2 textos (N2+N1) filtran exacto por level + 400 ante N9. El filtro de biblioteca N5-N1 funciona; en el picker no puede existir (cada nivel cuesta ~1min de an�lisis).
- Hukumusume a�adido junto a Aozora (migraci�n 025 ensancha chk_reading_sources_type): �ndice mensual, extracci�n con scan balanceado del td, trim por t�tulo+????, transcodificaci�n heredada. Picker con switch de fuente + meses + b�squeda; paste-link acepta ambas; validaciones por fuente.
- Import resiliente: reintento 1x (an�lisis) y commit por item con reintento ante fallos de transporte del pooler; ParserError excluido del reintento. Hallazgo: CHECK 23514 tumbaba los inserts (sin migraci�n no hay fuente nueva).
- Live: cuento real importa punta a punta (N1, 1662 chars, 0 mojibake). Nota honesta: el clasificador es estricto (hasta ?????? sale N2), as� que los cuentos tambi�n salen N1; el valor de Hukumusume es variedad + sitio conocido, no facilidad.
- Separaci�n visual biblioteca (mt-4): no hay m�rgenes negativos en el c�digo; era apilado sin aire.
- Retake (migraci�n 026 review_session_items): la queue exacta con orden persiste al crear (normal, repeat e inmersi�n); GET /sessions/:id/items devuelve pendientes+lastResult; el modal de In progress ofrece Retake y reanuda la MISMA sesi�n donde qued� (terminar la completa, sin duplicar historial). Verifier 47/51/23/0.
