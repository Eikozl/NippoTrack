# Phase 0 — Motor de referencia Kanji

## Estado y alcance

Esta entrega implementa el motor de referencia compartido de kanji y las mejoras de interfaz construidas sobre él. No inicia Phase 1 ni modifica Production. Los datos de referencia son de solo lectura durante la ejecución normal; las importaciones usan la conexión privilegiada de migración/administración.

## Flujo implementado

```text
JSON local de OpenJLPT (N5…N1)
  -> adaptador normalize-openjlpt-kanji.js
  -> JSON canónico de NippoTrack
  -> import-kanji-reference.js (idempotente)
  -> kanji_reference (RLS forzado, SELECT para jlt_runtime)
  -> API /api/kanji/reference y /api/kanji/lookup/:character
  -> búsqueda global, alta de kanji y enciclopedia
```

1. Se creó `kanji_reference` con carácter, nivel, listas de on'yomi, kun'yomi y significados, trazos y procedencia `jsonb`.
2. `kanji.reference_id` es la relación canónica hacia esa tabla. Las columnas históricas de `kanji` se conservan únicamente por compatibilidad durante esta fase.
3. La migración fuerza RLS y añade la política explícita `kanji_reference_runtime_select` para `jlt_runtime`; ese rol solo recibe `SELECT` sobre la tabla compartida.
4. El importador canónico valida exactamente un punto de código Han Unicode, normaliza listas y hace `upsert` por carácter. Repetir una importación no duplica filas y vuelve a enlazar registros existentes mediante `reference_id`.
5. Se añadió el adaptador de OpenJLPT. Recibe cinco archivos locales explícitos, mantiene los arrays, elimina duplicados conservando orden, rechaza registros inválidos y rechaza conflictos entre niveles en lugar de resolverlos silenciosamente. Su salida es determinista.

## Datos y atribución

El primer conjunto normalizado contiene 2,211 referencias aceptadas:

| Nivel | Registros |
| --- | ---: |
| N5 | 79 |
| N4 | 166 |
| N3 | 367 |
| N2 | 367 |
| N1 | 1,232 |

No se detectaron duplicados fusionados, conflictos entre niveles ni registros rechazados en esa importación inicial.

La procedencia se conserva en cada registro canónico. `THIRD_PARTY_NOTICES.md` documenta que NippoTrack transforma datos de OpenJLPT, conserva la atribución CC BY-SA 4.0 y enlaza el `NOTICE.md` original. Los niveles JLPT son datos comunitarios/de referencia, no un programa oficial del JLPT. El README y Settings muestran la atribución discreta con enlace al aviso de terceros en GitHub.

## Funcionalidad visible

- Al crear un kanji, una entrada Han válida consulta la referencia y rellena solo campos que seguían intactos. Mientras llega la respuesta se muestra un estado de carga.
- El nivel JLPT queda bloqueado al crear para evitar incoherencias; al editar, se permite cambiarlo pero aparece una advertencia si se modifican carácter, significado, lecturas o nivel de referencia.
- Escribir romaji en el selector de kanji muestra todas las coincidencias compartidas y permite elegir la correcta.
- La búsqueda global consulta también los 2,211 kanji compartidos por carácter, significado, kana o romaji. Cada resultado abre `#kanji-reference/<carácter>`.
- La página de enciclopedia presenta significado, nivel, trazos y lecturas con el estilo neumórfico y responsive de NippoTrack. Aún no inventa ejemplos ni animaciones de trazos: indica honestamente que los ejemplos compartidos no están disponibles.
- En formularios de vocabulario, kanji y gramática, los campos destinados a japonés convierten romaji completo al perder foco: hiragana para texto/lecturas kun y katakana para on'yomi. No se alteran `meaning`, traducciones ni notas, para no convertir español o inglés por error.

## Bypass de autenticación local

Para poder probar la aplicación local sin una cuenta de Supabase, se añadió un bypass de desarrollo con defensas explícitas:

1. El cliente solo lo habilita en Vite de desarrollo con `VITE_JLT_LOCAL_AUTH_BYPASS=true`.
2. La API exige además `JLT_LOCAL_AUTH_BYPASS=true`, un UUID en `JLT_LOCAL_AUTH_USER_ID`, la cabecera interna exacta y una conexión/origen localhost.
3. Se desactiva si `NODE_ENV=production` o `VERCEL=1`.

Por tanto no cambia el login de Vercel ni Production. Los valores deben estar solo en los archivos `.env*` ignorados, nunca en Git.

## Operación no productiva

Con credenciales del proyecto de integración en `server/.env.postgres` (o indicando otro archivo mediante `POSTGRES_ENV_FILE`), ejecute desde PowerShell:

```powershell
$env:POSTGRES_ENV_FILE = '.env.integration.postgres'
npm.cmd --prefix server run postgres:migrate
npm.cmd --prefix server run kanji-reference:normalize-openjlpt -- --n5 C:\data\openjlpt\n5.json --n4 C:\data\openjlpt\n4.json --n3 C:\data\openjlpt\n3.json --n2 C:\data\openjlpt\n2.json --n1 C:\data\openjlpt\n1.json --output C:\data\openjlpt\jlt-kanji-reference.json
npm.cmd --prefix server run kanji-reference:import -- C:\data\openjlpt\jlt-kanji-reference.json
npm.cmd --prefix server run postgres:verify-runtime-security
```

Use únicamente archivos descargados de OpenJLPT y un destino de integración/no productivo. El adaptador no llama a ninguna API remota y el importador no debe ejecutarse con las credenciales normales de runtime.

Para levantar la interfaz de integración con el bypass local, configure pares de variables coincidentes en los `.env` ignorados y ejecute:

```powershell
npm.cmd run dev:integration
```

## Verificación realizada

- Las pruebas cubren el normalizador OpenJLPT N5–N1, valores opcionales ausentes, duplicados, conflictos, diagnósticos, determinismo e importación idempotente/procedencia.
- También cubren la consulta de referencias por romaji, el enlace canónico al crear kanji, el RLS de solo lectura y el bypass local bloqueado fuera de localhost/Production/Vercel.
- La build de producción del cliente completa correctamente. Vite conserva una advertencia de tamaño de bundle, sin impedir la build.
- El test de topología de Vercel se ajustó al rewrite actual que excluye `/api` del fallback SPA.

## Smoke test de Preview

1. Abra la Preview sin habilitar el bypass local e inicie sesión normalmente.
2. Busque `食`, `shoku` y `taberu`; compruebe que aparecen referencias compartidas y que cada una abre su ficha.
3. Compruebe en la ficha significado, on'yomi, kun'yomi, nivel y trazos; el bloque de ejemplos debe indicar que aún no hay ejemplos compartidos.
4. Cree un kanji escribiendo `taberu`, elija `食` en la lista, y confirme que solo los campos intactos se rellenan y que JLPT queda bloqueado.
5. Edite ese kanji y cambie una lectura o el nivel: confirme que aparece la advertencia antes de guardar.
6. Añada vocabulario o gramática introduciendo romaji en un campo japonés, salga del campo y confirme la conversión a kana. Verifique que significado, traducción y notas no cambian.
7. Compruebe Settings → Data sources y que el enlace a Third-Party Notices abre el archivo de GitHub de la revisión publicada.
