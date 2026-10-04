# INFORME FINAL V5.3a

Fecha: 2026-10-02 Â· Rama: `dev` Â· Sin merge a `master` (`3c7a422` intacto).
Ciclo V5.3a sobre `dev` desde `81920ae` (fin del ciclo anterior). Este
informe cubre hasta el commit de cierre. Los valores son los REALES medidos;
donde el prompt de V5.3a asumÃ­a otra cosa se marca como [DESVIACIÃ“N].

## Baseline
- 8 commits de feature/fix + este cierre: 9f16032, af01f33, 2b4cea4, 0b9b6f3,
  d796b80, 2b7d9d7, 9d65ee5, 3ae8d08 (+ chore final).
- 41 archivos, +5,739/âˆ’67 vs 81920ae. Cero dependencias nuevas.

## Fases completadas
- **InmersiÃ³n Asistida** (Sprint 1-2)
  - 9f16032 backend: migraciÃ³n 021 (immersion_sessions + immersion_session_items,
    RLS modelo 020, ensancha el CHECK de kanji_encounters para reusar el recorder
    existente), pipeline analyze/create-session/history, verifier 38â†’40.
  - af01f33 frontend: pÃ¡gina /immersion (grupos con checkboxes, Select all/Clear,
    nivel estimado, historial read-only), integraciÃ³n en Review ("From text",
    banner de hand-off), nav + iconos + i18n, tests cliente 7/7.
  - 3ae8d08 fix de aceptaciÃ³n (ver Issues): queue hand-off + repair de history.
- **Lectura Graduada** (Sprint 3-4)
  - 2b4cea4 backend: migraciÃ³n 022 (reading_sources, reading_texts con user_id
    NULL = biblioteca compartida, user_reading_progress), clasificador
    determinista (reusa estimateDifficultyLevel + kanji_reference + grammar),
    anotaciones posicionalmente correctas, fuentes NHK Easy RSS + listado
    Aozora con allowlist fija de hosts (https, host exacto, sin puerto ni
    credenciales, timeouts y byte caps), verifier 40â†’43.
  - 0b9b6f3 frontend: /reading (biblioteca con filtros + import + texto propio),
    lector con anotaciones inline (tooltip kanji, modal vocab/grammar con
    "Add to my collection" vÃ­a POST existentes, degradado honesto sin meaning
    de referencia), toggle de anotaciones, slider de fuente, progreso con
    autosave 30s (siempre manda posiciÃ³n+tempo juntos por el contrato PUT),
    vista de progreso con barras de 8 semanas. + GET /api/reading/progress.
- **Review 2.0** (Sprint 5-6)
  - d796b80 backend: migraciÃ³n 023 (user_review_preferences, review_patterns,
    columnas aditivas card_type/difficulty_score en review_sessions), motor de
    tipos de tarjeta + preferencias, /due enriquecido con cardTypes, patrones
    heurÃ­sticos (kanji-reading-confusion, grammar-family-failures,
    vocabulary-frequent-again) con storage replace-per-detection, calculadora
    de intervalos dinÃ¡micos spec-verbatim opt-in, verifier 43â†’45.
  - 2b7d9d7 frontend: diÃ¡logo de preferencias (checklist + sliders), rotaciÃ³n
    ponderada determinista, tarjetas Recognition/Recall (inversiÃ³n de caras),
    Audio (Web Speech API ja-JP), Cloze (frase real vÃ­a lazy fetch con
    fallback recognition), panel de patrones con "Practice these".
- **Metas Inteligentes** (Sprint 5-6)
  - 9d65ee5: migraciÃ³n 024 (user_smart_goals), heurÃ­sticas 100% locales
    (adjust Â±20%, streak con dÃ­as de gracia por semana ISO, predicciÃ³n JLPT
    por volÃºmenes documentados, micro-metas con deadline del domingo),
    endpoints GET/PUT/POST /api/goals/smart*, widget en Dashboard + secciÃ³n
    en Settings, verifier 45â†’46.

## Tests
- Suite server final: **716 tests / 686 pass / 0 fail / 30 skipped**
  (687 base + 29 nuevos: immersion 7, graded-reader 8, review-v2 8,
  smart-goals 6).
- Suites client afectadas: immersion 7/7, navigation 9/9,
  vocabularyAutofill 40/40, reviewHub 25/26, firstUseDashboard 23/25.
- [DESVIACIÃ“N plantilla] El prompt exigÃ­a "suite completa 687+" â€” el nÃºmero
  real tras V5.3a es 716; los 687 eran el baseline del ciclo.
- Failures pre-existentes en HEAD (no tocados, verificados con stash): 1Ã—
  reviewHub COMPLETE (copy "Repeat failed" de P3 vs guard de gamificaciÃ³n) y
  2Ã— firstUseDashboard (semÃ¡ntica P1). Ninguno fue introducido por V5.3a.

## Builds
- Vite por sprint: 1m03s (1B), 57s (2A), 1m03s (2B), 1m11s (3B), 1m43s (P4),
  1m19s (fix). 1910 mÃ³dulos, chunks nuevos: immersion 6.9kB, reading 14.5kB,
  smartGoals 3.8kB, review 27.9kB. Solo los 2 warnings preexistentes.

## Migraciones
- 021-024 aplicadas en JLT testing (mufxygohcjikhlktvrcy) con el runner
  canÃ³nico + guarda de ref esperado. Verifier final: **46 tablas de aplicaciÃ³n
  / 50 policies / 23 triggers / failures: []**. Pins de grammar-reference
  actualizados por migraciÃ³n (38â†’40â†’43â†’45â†’46).
- [DESVIACIÃ“N plantilla] No aplicadas a preview/producciÃ³n (sin credenciales
  de preview; producciÃ³n exige ack). Runbook idÃ©ntico al de V5.2.

## Smokes contra la DB real (usuario sintÃ©tico + bypass local, cero residuo)
- ImmersiÃ³n end-to-end: **8/8** â€” analyze clasifica N4 con glosses reales de
  JMdict (æ—¥æœ¬èªž â†’ "Japanese (language)"), create-session transaccional
  (1 vocab + 7 kanji + review session + items + encounters con provenance
  `immersion_session`), el queue devuelto gradea contra la sesiÃ³n abierta,
  /due respeta la semÃ¡ntica inert congelada, history, 400 en selectedItems
  malformado.
- Lectura: **9/9** â€” user-text clasificado N4 con 11 anotaciones reales,
  GET text con anotaciones y progreso, library con knownKanjiPct,
  progreso idempotente (UNIQUE user+text), 404 ajeno, 400 en filtro invÃ¡lido,
  import NHK degrada a `{status:'unavailable'}` (sin salida de red en esta
  mÃ¡quina) â€” jamÃ¡s 5xx.
- Smart goals: **6/6** â€” defaults, persistencia de preferencias, predicciÃ³n
  N3 coherente, adjust sin actividad, 400, 401.

## Issues encontrados y resueltos durante la validaciÃ³n
1. **[3ae8d08] History de inmersiÃ³n crasheaba en SQL real**: los `?` de los
   FILTER aparecen antes que los del WHERE en el texto SQL, pero los params
   iban en otro orden â†’ `'grammar'` caÃ­a en el slot uuid de `user_id`. Los
   unit tests con stubs regex no lo veÃ­an; el smoke live sÃ­. Fix: literales
   inline en los FILTER (constantes, nunca input del usuario).
2. **[3ae8d08] Hueco de aceptaciÃ³n en el loop Textoâ†’SesiÃ³nâ†’Review**: los
   items reciÃ©n enrolados no tienen review_events, asÃ­ que el descubrimiento
   por rango de fechas NUNCA podÃ­a mostrarlos. Fix: create-session devuelve
   `items[]` con entityIds resueltos por el server; la pÃ¡gina de inmersiÃ³n
   guarda `{reviewSessionId, items}` en sessionStorage (por pestaÃ±a, se
   consume una vez) y Review arranca REVIEWING directamente contra la sesiÃ³n
   abierta reciÃ©n creada. El grading sigue validando ownership server-side.
3. **FÃ³rmula dinÃ¡mica del prompt invertida (flag)**: `interval = base *
   (1/facility)^reps` alarga los intervalos cuando facility < 1 â€” lo inverso
   del ease clÃ¡sico de SRS. Implementada VERBATIM (spec) + pineada por tests,
   pero opt-in (`engine_mode='dynamic'`); el default `fixed` conserva la
   curva 1/3/7 congelada de V5.2 byte-idÃ©ntica. Requiere revisiÃ³n de producto
   antes de promoverla a default.
4. **Fuentes externas**: en esta mÃ¡quina no hay salida a internet, asÃ­ que el
   import real de NHK/Aozora solo pudo validarse en su path de degradaciÃ³n
   (200 unavailable, nunca 5xx) + con fixtures en los unit tests. Los
   fetchers tienen allowlist estricta (host fijo, https, sin puerto ni
   credenciales, byte caps, timeout 8s).
5. Subagente 2A cancelado a mitad por lÃ­mite de crÃ©ditos â†’ completado a mano
   conservando su esqueleto (migraciÃ³n 022 + verifier). Un intento de
   subagente 1B no produjo nada â†’ relanzado con Ã©xito. Todos los commits
   fueron verificados personalmente antes de committear (un dev.js no
   autorizado de un subagente fue revertido).

## Desviaciones documentadas (vs el prompt V5.3a)
- **Sin JSX**: el cliente es JS vainilla; los `.jsx` del prompt se
  implementaron como mÃ³dulos `.js` con el helper `element()` (crearlos como
  JSX romperÃ­a el build â€” no hay React).
- **reviewEngine.js y goalsController.js no existÃ­an** (el prompt decÃ­a
  EXTENDER): creados nuevos; el CRUD manual de goals (v2) no se tocÃ³ y
  /api/goals/smart* coexiste por fall-through del router.
- **userId de body ignorado** en POST /api/reading/analyze (el prompt lo
  pedÃ­a): ownership SIEMPRE req.user.id.
- **"Practice these"** de patrones pre-selecciona el tipo de material y entra
  al SETUP; una mini-sesiÃ³n por items exactos requiere un endpoint dedicado
  (diferido, documentado).
- **Cloze** hace fallback a recognition cuando no hay frase disponible
  (fail-open); **kanji "similares"** se aproximan por lecturas compartidas
  (kanji_reference no tiene columna de radicales).
- **Historial de inmersiÃ³n read-only** (el payload no lleva reviewSessionId;
  "repetir" duplicarÃ­a sesiones) â€” documentado en la pÃ¡gina.

## Riesgos
- El hand-off del queue usa sessionStorage (por pestaÃ±a, una sola lectura):
  si el usuario abre /review sin pasar por la inmersiÃ³n, queda el banner
  informativo. Tampering del queue no escala privilegios (gradeEntity valida
  ownership de entidad y sesiÃ³n).
- TTS de tarjetas Audio depende de `speechSynthesis` del navegador (guardado;
  sin TTS la tarjeta degrada a reveal manual).
- Los step-stubs de grading quedaron acoplados al SELECT de preferencias
  (paso 1 del contrato transaccional) â€” documentado en cada test.

## Pendientes futuros
- Aplicar 021-024 a preview/producciÃ³n con el runbook (postgres:migrate â†’
  verifier 46/0 â†’ smoke).
- Decidir el destino del engine_mode dynamic (fÃ³rmula invertida, Issue 3).
- Mini-sesiones enfocadas por items exactos (endpoint nuevo).
- Import real NHK Easy/Aozora desde un entorno con salida a internet.
- Tickets pre-existentes de client tests (reviewHub copy P3,
  firstUseDashboard P1).
- AplicaciÃ³n mÃ³vil del lector (tooltip hover â†’ tap) si hay demanda.

## ValidaciÃ³n de aceptaciÃ³n V5.3a
- [x] InmersiÃ³n: Texto â†’ Analizar â†’ Seleccionar â†’ Crear sesiÃ³n â†’ Review inicia con items (queue hand-off, smoke 8/8)
- [x] Lectura: Biblioteca â†’ Lector con anotaciones â†’ Add entity â†’ Stats (smoke 9/9 + UI)
- [x] Review 2.0: Tipos configurables â†’ Review usa tipos â†’ Patrones detectados â†’ Intervalos dinÃ¡micos (opt-in, spec-verbatim, flag)
- [x] Metas: Auto-ajusta â†’ PredicciÃ³n JLPT â†’ Micro-metas â†’ UI Dashboard/Settings (smoke 6/6)
- [x] Suite: 716/686/0/30 (â‰¥687 requerido)
- [x] Build: âœ“ (1m19s, 1910 mÃ³dulos, solo warnings preexistentes)
- [x] Verifier dev: 46 tablas / 0 failures
- [x] Git: master 3c7a422 intacto, sin merges, sin deps nuevas, cero secretos
- [x] DocumentaciÃ³n: `AUDITORIA_FINAL_V5.3a.md` (este archivo)

## V5.3b — post-freeze hardening (dev: f953019, 67706c0, b9968c5, + cierre)
- Review history: la fila abre el openDetailModal propio ('<Tipo> Review Session • <fecha>') con items y kanji enlazados a su kanji-reference (stroke order). Tests reviewHub reescritos al modal (25/26; el fallo restante es el guard pre-existente).
- Review: botón 'Start immersed review' junto a 'Start review'; eliminado el atajo 'Card types' del intro (sigue en opciones). Card types documentadas en el diálogo + voz japonesa explícita y avisos si el TTS no existe.
- Reading: selects con value reales (el 400 'level must be one of...' era label enviado como valor); header del lector y panel de filtros reorganizados móvil-first; slider con id/acento; barra = furthest-read (seed + monótona).
- Progreso servidor: GREATEST en el upsert + eco del valor guardado (el adapter descarta extras del RETURNING: se lee de vuelta). Regresión imposible punta a punta (verificado live).
- Aozora: índice vivo sakuhin_a1.html + links relativos ./files + transcodificación euc-jp/shift_jis + import en background (202 + poll, textos por commits individuales). Verificado live: 202 en <1s, primera fila <60s, N1 real, 0 mojibake.
- NHK Easy retirado (feed 404, JSON 401, HTML sin enlaces): sin botón, sourceType solo aozora, tests y docs actualizados.
- Delete de textos propios: DELETE /api/reading/text/:id (solo dueño; 404 ajeno/compartido) + botón con confirmDialog igual que los CRUDs.
- 'Suggested goals' (antes 'Smart goals') en UI; mismo fix de option-value en sus selects.
- Notas de entorno: kuromoji tarda ~29s en esta máquina (benchmark 1.4s) — los 4 suites de parser fallan por timeout de init 15s; pooler Supabase con ECONNRESET/timeouts esporádicos; un flake del classifier (vocabUnknown 0/1 en primera tokenización) aparece bajo carga. Nada de esto lo toca este diff.
- Import con elección (b0a20fa+): GET /api/reading/import/preview lista hasta 20 obras (títulos+URLs, sin descargar artículos); el diálogo muestra checkboxes con Select all/Clear y POST importa solo las URLs elegidas (validadas: https + host + patrón card, intersectadas con el índice vivo). Verificado live: preview 20 obras, 2 elegidas aterrizan y nada más.
- Save atascado: el diálogo de card types no cerraba al guardar y el botón quedaba girando para siempre (los CRUD cierran; este no). Ahora libera el estado, muestra '? Saved' 1s y cierra; el error de validación también libera.
- Voces: botón 'Preview Japanese voice' en el diálogo (habla una frase de prueba) + nota si no hay voz japonesa instalada. Audio solo aparece en tarjetas de vocabulario con el tipo activado; kanji cae a recognition (documentado en el diálogo).
- Delete en tarjetas: papelera abajo-derecha de cada texto propio (icono Trash2 + regla .icon-button--danger); importados sin botón; refresh in place tras borrar. Se quitó el botón del header del lector.
- Picker con búsqueda (pendiente commit): preview acepta ?index= (grupos kana a/ka/sa/ta/na/ha/ma/ya/ra/wa validados) para variar las obras; el diálogo suma selector de grupo + búsqueda por título en vivo + Select all solo-visibles. Niveles en el picker no son posibles sin analizar (~1min/texto): el filtro por nivel vive en la biblioteca (ya corregido).
- Import por link: POST /api/reading/import/url {url} (202 + background + poll). La URL se valida en controlador y servicio (solo card pages https del host); el título sale del <title> de la card ('?????:X'). Verificado live: 400 a host ajeno, 202 válido, texto real N1 sin mojibake.
- Persistencia compartida: el loop de sync extraído a persistImportItem (bulk y link usan el mismo commit por item).
- Docs de endpoints: catálogo en app.js con preview + import/url + DELETE text.
- Filtro por nivel verificado live: 2 textos (N2+N1) filtran exacto por level + 400 ante N9. El filtro de biblioteca N5-N1 funciona; en el picker no puede existir (cada nivel cuesta ~1min de análisis).
- Hukumusume añadido junto a Aozora (migración 025 ensancha chk_reading_sources_type): índice mensual, extracción con scan balanceado del td, trim por título+????, transcodificación heredada. Picker con switch de fuente + meses + búsqueda; paste-link acepta ambas; validaciones por fuente.
- Import resiliente: reintento 1x (análisis) y commit por item con reintento ante fallos de transporte del pooler; ParserError excluido del reintento. Hallazgo: CHECK 23514 tumbaba los inserts (sin migración no hay fuente nueva).
- Live: cuento real importa punta a punta (N1, 1662 chars, 0 mojibake). Nota honesta: el clasificador es estricto (hasta ?????? sale N2), así que los cuentos también salen N1; el valor de Hukumusume es variedad + sitio conocido, no facilidad.
- Separación visual biblioteca (mt-4): no hay márgenes negativos en el código; era apilado sin aire.
- Retake (migración 026 review_session_items): la queue exacta con orden persiste al crear (normal, repeat e inmersión); GET /sessions/:id/items devuelve pendientes+lastResult; el modal de In progress ofrece Retake y reanuda la MISMA sesión donde quedó (terminar la completa, sin duplicar historial). Verifier 47/51/23/0.
- Retake legacy fallback (vía subagente backend, verificado): el modal lee eventos (lo calificado) pero Retake lee la queue persistida; sesiones pre-026 / sin-items / inmersión sin targets tienen 0 filas y daban 'No items recorded'. Ahora el endpoint reconstruye desde candidatos del rango propio menos lo ya calificado (tope 100, determinista, read-only, sin tablas nuevas) con flag reconstructed + toasts honestos. Sin cambios a paths congelados.
- Review 3.0 implementado (2 subagentes en paralelo, verificado combinado): bocina persistente delante+respuesta con replay siempre; cloze/recall con campo para escribir + comprobación tolerante (solo práctica, la calificación sigue intacta); auto-pick por reglas con pesos como multiplicador + anti-repetición + toggle (default on, migración 027 columna auto_pick, sin tablas nuevas); diálogo con descripciones + preview de voz. Decisiones aplicadas: escribir en cloze y recall, sin presets, bocina a la derecha.
- Audio silencioso (2 subagentes en paralelo): GC del utterance, voces sin cargar, cancel+speak en la misma tarea y falta de voz ja sin aviso. Fix central en speakDisplay (referencia viva, warmup voiceschanged, speak diferido 80ms, aviso explícito sin voz ja). Veredicto autoPick 400: código correcto, era despliegue viejo (allow-list previa produce exactamente ese error); test de regresión con el body reportado + API reiniciada.
- Audio: falso negativo del detector (getVoices vacío pre-carga declarado como 'sin voz'). Ahora espera hasta 2.5s la lista real; solo declara ausencia con lista cargada sin ja, y 'aún no carga' en caso contrario. Tests de voces tardías + lista ausente.
- Velocidad de voz persistente (migración 028 columna speech_rate, sin tablas nuevas): slider 0.5-1.5 en el diálogo, default 0.9 idéntico al histórico; validación 400 fuera de rango; utterance usa la configurada.
