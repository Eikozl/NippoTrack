# Third-Party Notices

## Word dictionary data (JMdict / EDRDG)

NippoTrack's Context-Aware reference layer is built from [JMdict](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project) (Japanese-Multilingual Dictionary, Electronic Dictionary Research and Development Group — EDRDG), available under [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/). Copyright over the dictionary files is held by James William Breen and the EDRDG.

NippoTrack ingests the English-only JMdict distribution through the [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) JSON projection (derived files likewise CC BY-SA 4.0; its loader tooling is MIT and is not a NippoTrack runtime dependency). Only English glosses are imported; non-English translational equivalents carry separate compilers' copyright and are excluded. Per-record source provenance (source date, converter version, artifact hash, importer version) is stored with every reference snapshot; see `server/scripts/import-jmdict-reference.js` and `docs/jmdict-import.md`.

JMdict-derived readings, glosses, and entry metadata are GLOBAL REFERENCE DATA: they never imply that a user added, reviewed, or knows a word, and they never feed Estimated Study Level, JLPT Progress, or Review. Dictionary meaning suggestions always require explicit user confirmation before any vocabulary write.

In-app acknowledgement (built in the Context-Aware UI surface, CA-B3): whenever the Analyzer's vocabulary results carry dictionary provenance, the lexical surfaces credit "Dictionary data: JMdict © EDRDG (CC BY-SA 4.0)" with links to the JMdict project and the CC BY-SA 4.0 licence, plus a reference-version disclosure (converter version, release date). The EDRDG licence asks dictionary-backed services to refresh from current releases at least monthly; NippoTrack's refresh procedure is documented in `docs/jmdict-import.md`. Commercial use is permitted by the licence; NippoTrack application code remains under its own terms and no copyright over JMdict material is claimed.

## Kanji reference data (KANJIDIC2 + OpenJLPT)

NippoTrack's shared kanji reference dictionary is built from [KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project) (EDRDG, CC BY-SA 4.0), which supplies character readings, meanings, stroke counts, and grade metadata for the full dictionary universe. JLPT level classifications are overlaid from [OpenJLPT](https://github.com/evanclan/OpenJLPT) (CC BY-SA 4.0) where available; characters without OpenJLPT coverage keep a null/unclassified JLPT level and are never presented as holding an official JLPT level. KANJIDIC2's legacy pre-2010 `<jlpt>` codes are ignored. See `server/scripts/build-kanji-reference.js` for the deterministic merge, including per-record provenance in `source_metadata`.

OpenJLPT documents field-level provenance in its [NOTICE.md](https://github.com/evanclan/OpenJLPT/blob/main/NOTICE.md); that original notice remains the source for the complete upstream attribution.

NippoTrack can import kanji reference data derived from [OpenJLPT](https://github.com/evanclan/OpenJLPT), available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). OpenJLPT documents field-level provenance in its [NOTICE.md](https://github.com/evanclan/OpenJLPT/blob/main/NOTICE.md); that original notice remains the source for the complete upstream attribution.

NippoTrack transforms OpenJLPT input into its source-agnostic canonical kanji format. The transformation validates one Han Unicode code point and file-level JLPT labels, removes duplicate readings and meanings while preserving their input order, rejects conflicting cross-level assignments, and adds preserved provenance metadata. It does not treat the transformed data as an official JLPT syllabus.

The OpenJLPT notice identifies the following upstream sources as relevant to the imported kanji fields:

- **KANJIDIC2 — EDRDG**: kanji readings, meanings, stroke counts, grade, and frequency data; CC BY-SA 4.0.
- **Jonathan Waller's JLPT Resources** (`tanos.co.uk`): N5–N1 reference level assignments; CC BY.

OpenJLPT states that the Japan Foundation and JLPT do not publish an official N5–N1 kanji list. Accordingly, NippoTrack presents these classifications only as community/reference data, not as an official JLPT syllabus.

If NippoTrack redistributes a transformed OpenJLPT-derived dataset, the applicable CC BY-SA 4.0 attribution, license information, and upstream credits must remain with that distribution.

## Grammar reference data (Nihongo Mono)

NippoTrack's shared grammar reference catalog is built from [Nihongo Mono](https://github.com/stndaru/nihongo-mono) (stndaru), pinned to commit `ec0ba4a0ce1611c568b0e4f8a223eb8029249a25`. The grammar content is licensed under MIT; the full license text is preserved in `server/data/grammar/NIHONGO-MONO-MIT-LICENSE.txt` and the pin is recorded in `server/data/grammar/ATTRIBUTION.md`. Only the five grammar level catalog files (`n1`–`n5`) and inventory metadata are vendored (1,031 entries: N5 119 · N4 189 · N3 248 · N2 208 · N1 267); no JMdict, KANJIDIC, or KanjiVG material is included from this source.

Grammar reference rows are GLOBAL REFERENCE DATA: they never imply that a user added, reviewed, or knows a grammar point. Grammar records are created only through explicit user action, and a grammar point may exist with no reference link at all.
