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

## Canonical asset set (6702 files)

Every canonical, non-variant SVG filename in the r20250816 release is
vendored: exactly `kanji/<five lowercase hexadecimal code point>.svg`.
Filename variants and variant-selection UX are intentionally outside this
scope. The set is generated from one coherent release, not mixed across
KanjiVG versions.

Reproduce/audit: `scripts/vendor-kanji-strokes.cjs` verifies the canonical
set; `scripts/generate-stroke-asset-index.cjs` regenerates the lazy client
availability index directly from these files.

## Runtime use

Files are served as static lazy-loaded presentation assets
(`stroke/kanji/<5-digit-lowercase-hex>.svg`, e.g. `stroke/kanji/05b66.svg`
for 学). They are never bundled into application JavaScript. A compact lazy
index avoids requests for absent assets; load failures fall back to the normal
font-rendered glyph.
