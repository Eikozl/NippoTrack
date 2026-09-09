# Stroke-order assets — provenance & licensing

## Artwork source

KanjiVG release **r20250816**, file `kanjivg-20250816-main.zip`
(non-variant SVGs only).

- Release: https://github.com/KanjiVG/kanjivg/releases/tag/r20250816
- Project: https://kanjivg.tagaini.net
- Copyright © 2009–2011 Ulrich Apel (per-file headers; years vary per file).

## License

Creative Commons **Attribution-Share Alike 3.0** (CC BY-SA 3.0).

- Deed: https://creativecommons.org/licenses/by-sa/3.0/
- Full text vendored alongside: `./COPYING`
  (upstream: https://github.com/KanjiVG/kanjivg/blob/master/COPYING)

As required by the license: every vendored SVG keeps its original
`<!-- Copyright ... -->` header intact, and this notice states our use of
KanjiVG with a link to the project website (above).

## Jōyō subset (2136 files)

Only Jōyō kanji are vendored. Eligibility was derived from KANJIDIC2
(http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz, EDRG/EDRDG licence):
entries with `<grade>` 1–6 (kyōiku) or 8 (remaining jōyō) are included;
grades 9–10 (jinmeiyō) are excluded. The snapshot used yields exactly
2136 code points, all present in the KanjiVG release (0 missing).

Reproduce/audit: `scripts/vendor-kanji-strokes.cjs` documents the exact
derivation (the client allowlist `client/src/strokeJoyo.js` is generated
from the same source and must be regenerated together with this set).

## Runtime use

Files are served as static lazy-loaded presentation assets
(`stroke/kanji/<5-digit-lowercase-hex>.svg`, e.g. `stroke/kanji/05b66.svg`
for 学). They are never bundled into application JavaScript. Non-Jōyō
characters and load failures fall back to the normal font-rendered glyph.
