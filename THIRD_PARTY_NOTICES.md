# Third-Party Notices

## Kanji reference data (KANJIDIC2 + OpenJLPT)

JLT's shared kanji reference dictionary is built from [KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project) (EDRDG, CC BY-SA 4.0), which supplies character readings, meanings, stroke counts, and grade metadata for the full dictionary universe. JLPT level classifications are overlaid from [OpenJLPT](https://github.com/evanclan/OpenJLPT) (CC BY-SA 4.0) where available; characters without OpenJLPT coverage keep a null/unclassified JLPT level and are never presented as holding an official JLPT level. KANJIDIC2's legacy pre-2010 `<jlpt>` codes are ignored. See `server/scripts/build-kanji-reference.js` for the deterministic merge, including per-record provenance in `source_metadata`.

OpenJLPT documents field-level provenance in its [NOTICE.md](https://github.com/evanclan/OpenJLPT/blob/main/NOTICE.md); that original notice remains the source for the complete upstream attribution.

JLT can import kanji reference data derived from [OpenJLPT](https://github.com/evanclan/OpenJLPT), available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). OpenJLPT documents field-level provenance in its [NOTICE.md](https://github.com/evanclan/OpenJLPT/blob/main/NOTICE.md); that original notice remains the source for the complete upstream attribution.

JLT transforms OpenJLPT input into its source-agnostic canonical kanji format. The transformation validates one Han Unicode code point and file-level JLPT labels, removes duplicate readings and meanings while preserving their input order, rejects conflicting cross-level assignments, and adds preserved provenance metadata. It does not treat the transformed data as an official JLPT syllabus.

The OpenJLPT notice identifies the following upstream sources as relevant to the imported kanji fields:

- **KANJIDIC2 — EDRDG**: kanji readings, meanings, stroke counts, grade, and frequency data; CC BY-SA 4.0.
- **Jonathan Waller's JLPT Resources** (`tanos.co.uk`): N5–N1 reference level assignments; CC BY.

OpenJLPT states that the Japan Foundation and JLPT do not publish an official N5–N1 kanji list. Accordingly, JLT presents these classifications only as community/reference data, not as an official JLPT syllabus.

If JLT redistributes a transformed OpenJLPT-derived dataset, the applicable CC BY-SA 4.0 attribution, license information, and upstream credits must remain with that distribution.
