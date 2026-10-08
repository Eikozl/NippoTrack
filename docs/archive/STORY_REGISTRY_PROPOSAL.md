# Story Registry — análisis y propuesta técnica

Estado: PROPUESTA (no implementada). Análisis verificado contra el código el
2026-10-04. Sin subagentes en esta sesión: análisis directo del builder.

## 1. Análisis crítico del Content Log actual

**Dónde vive.** UI: `client/src/pages/v2Pages.js` (config `content`, genérica
CRUD: lista paginada, búsqueda, modal crear/editar). API: `server/src/
controllers/v2Controller.js` (`resourceHandlers`, ~5 líneas por verbo) sobre
`content_entries`. Tabla: `001` líneas 87–96 + `user_id` en `004/005`.

**Qué está mal (con evidencia).**

1. Isla total. `LINK_CONFIGS.content` (v2Controller.js:151) solo enlaza
   `content_entry_sessions`. No existe ningún join hacia `vocabulary`,
   `kanji`, `grammar_points`, `review_items` o `review_sessions`. Guardar una
   historia no deja rastro lingüístico en el sistema.
2. Sin valor extraído. Los campos (`title, content_type, content_date,
   perceived_difficulty, comprehension_percent, new_words_count, notes`) son
   metadata auto-reportada. `new_words_count` es un número a mano: nadie sabe
   QUÉ palabras. No hay texto fuente almacenado en ningún campo.
3. Sin embed. No hay `source_url` ni `embed_html`. Y hay un bloqueador real:
   `app.js:34` usa `helmet({ contentSecurityPolicy: true })` con defaults →
   `frame-src 'self'`. Un iframe de YouTube hoy sería **bloqueado por CSP**
   aunque el frontend lo renderice. Cualquier propuesta debe tocar la CSP.
4. Sin extracción automática. No hay fetch de URLs (el único fetch con
   allowlist vive en `gradedReader.js:741` para Aozora), ni readability, ni
   transcripts, ni yt-dlp (cero deps de ese tipo en `package.json`).
5. Tipos muertos en la práctica. El CHECK admite Anime/Manga/Book/Article/
   YouTube/Podcast/Game/Conversation, pero ningún tipo cambia el
   comportamiento: todos son el mismo formulario.

**Qué falta.** URL origen, embed sandboxed, texto extraído, candidatos
kanji/vocab/grammar vinculados, enroll en SRS opt-in, puente a Review
(como candidatos), Analyzer (enviar texto) y Reading (modo lector).

**Qué sobra.** Nada que quitar: el CRUD genérico sirve como base. No se
propone borrar `content_entries` (Hyrum: el backup JSON de export lo incluye
y el historial del usuario debe sobrevivir).

## 2. Arquitectura propuesta: extender, no reemplazar

Migración `033_story_registry.sql` (aditiva, sin tocar columnas existentes):

```sql
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS source_url varchar(2000);
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS embed_html text;
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS thumbnail_url varchar(2000);
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS duration_seconds integer;
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS source_domain varchar(255);
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS extracted_json jsonb NOT NULL DEFAULT '{}';
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS processing_status varchar
  NOT NULL DEFAULT 'none'
  CONSTRAINT chk_story_status CHECK (processing_status IN ('none','pending','processing','completed','failed'));
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS extraction_error text;
CREATE TABLE IF NOT EXISTS story_review_links (
  id_content_entry integer NOT NULL REFERENCES content_entries (id_content_entry) ON DELETE CASCADE,
  id_review_item integer NOT NULL REFERENCES review_items (id_review_item) ON DELETE CASCADE,
  PRIMARY KEY (id_content_entry, id_review_item)
);
-- RLS/GRANT/POLICY molde 026 para story_review_links; ALTERs heredan la
-- postura de content_entries. Sin triggers (sin updated_at nuevo).
```

`extracted_json` shape: `{ kanji: [{char, reading, meaning, frequency}],
vocab: [{word, reading, meaning, pos, frequency}], grammar: [{pattern,
meaning, example}], confidence }`. Un solo jsonb evita 3 tablas nuevas y el
verifier solo suma 1 tabla + 1 policy.

## 3. API (contrato primero, principios api-and-interface-design)

Base existente: `resourceHandlers` ya da GET/POST/PUT/DELETE con `{ error }`
uniforme + 404/400 coherentes. Se extiende (nunca se modifica):

- `POST /api/stories/extract-preview` `{ source_url }` → `{ title,
  thumbnail, duration, embedHtml, sandbox, preview: { kanji[], vocab[],
  grammar[] } }`. Solo lectura + cómputo: seguro de reintentar.
- `POST /api/stories` `{ source_url?, title?, notes?, auto_extract: true,
  auto_enroll_srs: false }` → `{ story_id, extracted, review_items_created[] }`.
  `auto_enroll_srs` default **false** (ver §6).
- `POST /api/stories/:id/extract` → re-ejecuta extracción (idempotente por
  diseño: reescribe `extracted_json`, no duplica).
- `POST /api/stories/:id/enroll-srs` `{ kanji[], vocab[], grammar[] }` →
  crea entidades vía `ensure*Entity` + `review_session_id` vía el hand-off
  de inmersión. Responde `{ review_session_id, created }`.
- `GET /api/stories/:id/embed` → `{ embedHtml, sandbox, csp }` (ver §4).

Validación en el borde (handlers), nunca dentro de servicios. Errores con el
mismo `{ error }` del v2. `source_url` se valida contra allowlist de hosts
(YouTube, dominios de noticias configurables) + tope de bytes, igual que
`fetchFixedText` (gradedReader.js:741). SSRF: sin hosts arbitrarios.

## 4. iframes: sandbox + CSP (hallazgo bloqueante incluido)

- `sandbox="allow-scripts allow-same-origin"` solo YouTube;
  `sandbox="allow-scripts"` artículos (sin same-origin: el embed no toca
  cookies del sitio embebido).
- Podcasts: NO iframe genérico — `<audio>` nativo con la URL del RSS
  (menos superficie que un iframe de terceros).
- CSP: añadir `frame-src 'self' https://www.youtube-nocookie.com` (nocookie,
  no youtube.com) vía config de helmet en `app.js`. Sin esto, el navegador
  bloquea el player aunque el HTML sea correcto.
- `GET /:id/embed` centraliza qué sandbox corresponde a cada dominio, para
  que el cliente nunca construya iframes a mano.

## 5. Extracción (honesta sobre dependencias: cero nuevas)

Reusar, en orden: `immersionPipeline.runAnalysis` (texto → candidatos con
glosses) + `ensureVocabularyEntities / ensureKanjiEntities /
ensureGrammarEntities` (creación con ownership) para enroll. Límites:
timeout 30s, tope 5000 caracteres, `processing_status` visible.

Brechas declaradas (no se fingen):

- **Transcripts de YouTube**: sin yt-dlp/ytdl-core no hay transcript fiable.
  Fase 1 = el usuario pega el texto/transcript (el Analyzer ya acepta texto
  libre); Fase 2 = dependencia nueva solo si se aprueba.
- **JMdict no tiene ejemplos**: el fallback "primer ejemplo de JMdict" del
  spec es imposible con este esquema (forms/senses no traen oraciones).
  Los ejemplos salen de `usage_examples`/`grammar_examples` propios.
- **Artículos**: fetch allowlisted + extracción de texto principal con
  heurística local (sin readability/cheerio: más código propio, cero deps;
  documentar el tradeoff).

## 6. Integraciones (mapa de reuso concreto)

| Destino | Mecanismo existente a reusar |
|---|---|
| Review (candidatos) | `story_review_links` + `getReviewCandidates` (los items linkados aparecen; nada nuevo que inventar) |
| SRS enroll | `ensure*Entity` + hand-off `items[]` de inmersión (commit 0d40c6d) |
| Analyzer | `POST /api/analyze/text` ya acepta texto: botón "Analizar" manda `extracted.text` |
| Reading | `gradedReader` reader + anotaciones: botón "Leer" abre el texto en modo lector |
| TTS | `client/src/speech.js` (`speakJapanese` con veredictos) en cada ejemplo |
| Kanji trazos | `strokeOrder.loadStrokePaths` + `kanjiWriting.mountKanjiWriting` en el detalle |

No-gos explícitos: auto-enroll default ON (contamina el SRS con ruido;
opt-in), notificaciones push (no hay infra), ratings/geografía (privacidad).

## 7. UI (vanilla, skill frontend-ui-engineering)

Nueva página `stories.js` (no tocar v2Pages: el Content Log clásico sigue
vivo): feed de historias (thumbnail, duración, dominio, estado de extracción
con `aria-live`), modal crear (URL + notas + checkboxes auto_extract /
enroll), diálogo de preview (candidatos con checkboxes por tipo + Confirmar),
player embebido (iframe sandboxed o `<audio>`), botones Analizar / Leer /
Escuchar por ejemplo. Estados loading/empty/error en cada bloque (fail-open).
Sin estética AI: tokens existentes (`surface`, `text-muted`, pills), nada de
gradientes púrpura ni héroes genéricos.

## 8. Plan por fases (migraciones 033+)

1. **033**: esquema + `POST extract-preview` con texto pegado (sin fetch
   externo). UI: página + modal + preview. (Sin riesgo red.)
2. Fetch allowlisted de artículos + `POST /stories` + enroll opt-in.
3. Puentes Review/Analyzer/Reading/TTS (todo reuso, sin SQL nuevo salvo
   `story_review_links` ya creado en 033).
4. Solo si se aprueba: transcripts (nueva dep) y `GET :id/embed` endurecido.
