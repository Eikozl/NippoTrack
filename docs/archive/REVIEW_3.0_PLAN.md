# Review 3.0 — Plan (borrador para aprobar antes de codificar)

Fecha: 2026-10-03 · Estado: PROPUESTA, sin código tocado.
Objetivo: que el usuario nunca tenga que entender qué es una "card type".
El sistema elige solo; las preferencias pasan a ser un ajuste fino opcional.

## 1. Cómo funciona hoy (2.0, verificado en código)

- Cuatro tipos: recognition (ver → recordar), recall (significado → palabra),
  cloze (frase con hueco), audio (escuchar → recordar).
- `pickCardType` rota por pesos configurados (`currentIndex % pool`), con
  fallback a recognition cuando la entidad no soporta el tipo elegido
  (kanji solo recognition/recall; audio y cloze con requisitos propios).
- Las preferencias viven en `user_review_preferences` + resumen en la UI.
- Problemas reportados y confirmados:
  1. Audio: botón "Play audio" genérico; tras "Reveal answer" el audio
     desaparece (el cuerpo se reemplaza). Si el TTS falla, antes era
     silencioso (ya avisa con toast, pero el daño de UX está hecho).
  2. Cloze: tras revelar, la frase con el hueco desaparece igual.
  3. El usuario no sabe cuándo aparece cada tipo ni por qué (rotación por
     pesos = aparentemente aleatorio). Descubrir Audio exige abrir el
     diálogo, activarlo y tener suerte con la rotación.

## 2. Principios de 3.0

1. **La tarjeta explica sola lo que pide.** Cada frente tiene un affordance
   explícito (escuchar, completar, recordar) — nunca un modo invisible.
2. **Los controles persisten tras revelar.** Escuchar y ver la frase son
   acciones de estudio, no pasos de un ritual: siguen disponibles en la
   respuesta para repasar antes de calificarse.
3. **El sistema elige; el usuario ajusta.** Auto-pick determinista por
   defecto. Los pesos actuales quedan como "énfasis" avanzado, no como el
   mecanismo principal.
4. Sin migraciones destructivas: `user_review_preferences` se extiende con
   columnas aditivas (`auto_pick boolean DEFAULT true`); la curva de
   intervalos y el resto del motor no se tocan.

## 3. Diseño propuesto

### 3.1 Ciclo de tarjeta unificado

Toda tarjeta pasa por dos fases con el mismo esqueleto:

- **Frente (prompt):** pill de tipo + instrucción de una línea
  ("Escucha y recuerda", "Completa la frase", …) + affordance principal.
- **Respuesta (reveal):** la respuesta completa + **los mismos affordances
  en modo compacto** (re-escuchar, ver frase) + calificación Again/Hard/Good.
- Regla dura: revelar jamás destruye un affordance. El `body` deja de
  reemplazarse entero; frente y respuesta son dos contenedores que se
  alternan (`hidden`), cada uno con sus controles vivos.

### 3.2 Audio: icono bocina siempre disponible

- El botón "Play audio" se sustituye por un **icono de bocina junto a la
  palabra** (delante y en la respuesta), con `aria-label="Escuchar …"`.
- El icono existe en ambos estados: se puede re-escuchar tras revelar,
  las veces que se quiera, antes de calificar.
- Robustez TTS (ya parcial, completar en 3.0): precarga de voces con
  `voiceschanged`, selección explícita de voz `ja`, `rate ≈ 0.9`,
  `onerror` → toast accionable ("instala la voz japonesa en tu sistema").
  Nota técnica honesta: `speechSynthesis` exige gesto de usuario (nuestros
  clicks lo son) y voz instalada; sin voz no hay audio posible desde web
  sin dependencias externas — el diálogo "Preview Japanese voice" es el
  smoke test del propio dispositivo.
- Audio sigue sin aplicar a kanji (una lectura aislada no es escucha
  significativa): esos casos caen a recognition, y el diálogo lo dice.

### 3.3 Cloze como práctica real de completar

- La tarjeta cloze muestra la frase con el hueco (＿＿) **más un campo de
  texto** "Completa la palabra" + botón Comprobar.
- Comprobación tolerante por capas: exacta → lectura (kana) →
  pista (primera letra / longitud). Nunca penaliza por formato.
- Tras revelar, la frase con el hueco **permanece visible** junto a la
  respuesta, para releer antes de calificar.
- Sin frase disponible → fallback a recognition (comportamiento actual,
  se mantiene).

### 3.4 Auto-pick inteligente (el corazón de 3.0)

`pickCardType(item, context)` determinista, en este orden:

1. **Soporte:** intersección con `ENTITY_SUPPORTED_CARD_TYPES` (congelado).
2. **Reglas por estado** (primera versión, ajustables con datos):
   - Item nuevo (sin eventos) → recognition (primer contacto).
   - Último resultado Again/Hard → recall; si es vocabulario y hay voz,
     alterna recall/audio (variedad donde duele).
   - Grammar con frase disponible → cloze (su hábitat natural).
   - Racha de Good ≥ 3 en recognition → promueve a recall/cloze.
3. **Énfasis del usuario** (los pesos actuales) como desempate, no como
   sorteo: multiplican la puntuación de las reglas en vez de definir el pool.
4. **Anti-repetición:** no repetir el mismo tipo dos veces seguidas para el
   mismo item en una sesión (salvo que sea el único soportado).
5. Todo queda registrado: el `card_type` por evento ya existe en
   `review_sessions`/eventos — el resumen COMPLETE muestra el reparto real
   ("estudiaste 5 en audio, 3 en cloze"), cerrando el loop de comprensión.

### 3.5 Diálogo de preferencias simplificado

- Mantiene los 4 tipos con su descripción de una línea (ya añadidas).
- Añade: toggle "Elección automática (recomendado)" + el botón de
  previsualización de voz (ya añadido) + nota de voces.
- Los sliders de peso pasan a sección "Énfasis avanzado" colapsada.
- Sin auto-pick (toggle off) → comportamiento 2.0 exacto (rotación por
  pesos). Migración cero-riesgo: default `auto_pick = true` solo para
  sesiones nuevas; las preferencias guardadas se respetan.

## 4. Criterios de aceptación (para la suite)

- Ni audio ni cloze pierden sus controles tras revelar (tests de
  FakeNode: existen nodos `aria-label=Escuchar…` y campo cloze en ambos
  estados; calificar sigue funcionando).
- Auto-pick determinista: misma entrada → mismo tipo (tests puros, sin DOM).
- Reglas pineadas: nuevo→recognition; Again→recall; grammar+frase→cloze;
  kanji nunca audio.
- Fallbacks intactos: sin frase→recognition; sin voz→toast + tarjeta
  usable; sin TTS→reveal manual.
- Suite servidor sin cambios (sin migración destructiva); reviewHub
  25/26 + nuevos tests 3.0 en verde; build ok.

## 5. Preguntas abiertas para ti (responder antes de codificar)

1. ¿Campo de texto para cloze (escribir la respuesta) o solo rellenar
   mentalmente + revelar? Propuesta: escribir, con comprobación tolerante.
2. ¿Recall también con campo de texto, o solo cloze lo tiene?
3. ¿Quieres presets ("Equilibrado", "Enfoque escucha") o basta con el
   toggle auto + énfasis avanzado?
4. En móvil, ¿bocina a la derecha de la palabra te vale como posición?

## 6. Fuera de alcance explícito

- Cambiar la curva de intervalos, el motor de grading o el esquema de
  sesiones (solo columna aditiva).
- TTS de servidor o archivos de audio (sin dependencias nuevas).
- Reescribir Review 2.0 por completo: 3.0 es una capa de presentación +
  selección sobre el motor existente.
