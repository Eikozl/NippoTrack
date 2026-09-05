/*
 * Builds the broader canonical kanji reference dataset.
 *
 * Base universe: KANJIDIC2 (EDRDG, CC BY-SA 4.0) — every character entry.
 * Overlay: OpenJLPT canonical JSON — JLPT level/classification metadata only.
 *
 * OpenJLPT no longer defines the universe of records; it enriches the
 * dictionary. Characters without OpenJLPT coverage keep jlpt_level NULL
 * (never implied, never defaulted to N1).
 *
 * KANJIDIC2's legacy <jlpt> element carries pre-2010 JLPT codes and is
 * deliberately ignored; OpenJLPT is the sole classification source.
 *
 * Usage:
 *   node scripts/build-kanji-reference.js --kanjidic2 path/to/kanjidic2.xml --openjlpt path/to/canonical-openjlpt.json --output path/to/merged.json
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const { normalizeImportedReference } = require('../src/services/kanjiReference');

const JLPT_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];
const OPENJLPT_NOTICE = 'https://github.com/evanclan/OpenJLPT/blob/main/NOTICE.md';
const KANJIDIC_PROJECT_URL = 'https://www.edrdg.org/wiki/index.php/KANJIDIC_Project';

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return String(node['#text'] ?? '');
}

function readingType(node) {
  if (node && typeof node === 'object') return node.r_type || null;
  return null;
}

function meaningLanguage(node) {
  if (node && typeof node === 'object') return node.m_lang || null;
  return null;
}

function stableUnique(values) {
  return [...new Set(values)];
}

function parseKanjidic2(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    trimValues: true,
    isArray: (name) => ['character', 'rmgroup', 'reading', 'meaning', 'stroke_count'].includes(name)
  });
  const document = parser.parse(xmlText);
  const root = document.kanjidic2;
  if (!root || typeof root !== 'object') throw new Error('kanjidic2 root element is missing.');
  const header = root.header || {};
  const version = {
    fileVersion: textOf(header.file_version) || null,
    databaseVersion: textOf(header.database_version) || null,
    dateOfCreation: textOf(header.date_of_creation) || null
  };
  const characters = root.character || [];
  const entries = new Map();
  const duplicates = [];
  characters.forEach((entry, index) => {
    const character = textOf(entry.literal);
    if (entries.has(character)) {
      duplicates.push({ character, index });
      return;
    }
    const groups = entry.reading_meaning?.rmgroup || [];
    const onyomi = [];
    const kunyomi = [];
    const meanings = [];
    groups.forEach((group) => {
      (group.reading || []).forEach((reading) => {
        const value = textOf(reading).trim();
        if (!value) return;
        if (readingType(reading) === 'ja_on') onyomi.push(value);
        else if (readingType(reading) === 'ja_kun') kunyomi.push(value);
      });
      (group.meaning || []).forEach((meaning) => {
        const language = meaningLanguage(meaning);
        if (language !== null && language !== 'en') return;
        const value = textOf(meaning).trim();
        if (value) meanings.push(value);
      });
    });
    const misc = entry.misc || {};
    const strokeCandidates = (misc.stroke_count || []).map((value) => Number(textOf(value))).filter((value) => Number.isInteger(value) && value > 0);
    const gradeValue = misc.grade === undefined ? null : Number(textOf(misc.grade));
    entries.set(character, {
      character,
      onyomi: stableUnique(onyomi),
      kunyomi: stableUnique(kunyomi),
      meanings: stableUnique(meanings),
      strokeCount: strokeCandidates.length ? strokeCandidates[0] : null,
      grade: gradeValue !== null && Number.isInteger(gradeValue) && gradeValue > 0 ? gradeValue : null
    });
  });
  return { version, entries, duplicates };
}

const singleHanCodePoint = /^\p{Script=Han}$/u;

// CJK Compatibility Ideographs (e.g. U+FA10 塚) NFKC-fold to unified Han
// characters that already exist as their own KANJIDIC2 rows. They are
// compatibility aliases, not distinct Kanji: collapse them so the canonical
// universe holds one linguistic row per unified character. This decision
// applies ONLY to character identity/literals — readings, meanings, and
// stroke data are never NFKC-normalized.
function collapseCompatibilityAliases(entries) {
  const collapsed = [];
  for (const [character] of entries) {
    const folded = character.normalize('NFKC');
    if (folded === character) continue;
    if (!singleHanCodePoint.test(folded)) continue;
    if (!entries.has(folded)) continue;
    entries.delete(character);
    collapsed.push({ alias: character, canonical: folded });
  }
  collapsed.sort((left, right) => sortCharacter(left.alias, right.alias));
  return collapsed;
}

function sortCharacter(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergeReferences(kanjidic, openjlptRecords) {
  const collapsedAliases = collapseCompatibilityAliases(kanjidic.entries);
  const report = {
    kanjidicEntries: kanjidic.entries.size + collapsedAliases.length,
    kanjidicDuplicates: kanjidic.duplicates.length,
    compatibilityAliasesCollapsed: collapsedAliases.length,
    collapsedAliases,
    openjlptInput: openjlptRecords.length,
    openjlptMatched: 0,
    openjlptOnly: [],
    classified: 0,
    unclassified: 0,
    rejectedRecords: []
  };
  const openjlptByCharacter = new Map();
  openjlptRecords.forEach((record, index) => {
    if (!record || typeof record !== 'object' || !record.character) {
      report.rejectedRecords.push({ index, reason: 'OpenJLPT record must be an object with a character.' });
      return;
    }
    if (openjlptByCharacter.has(record.character)) {
      report.rejectedRecords.push({ character: record.character, index, reason: 'Duplicate character in OpenJLPT input.' });
      return;
    }
    openjlptByCharacter.set(record.character, { record, index });
  });

  const references = [];
  for (const [character, entry] of kanjidic.entries) {
    const overlay = openjlptByCharacter.get(character);
    let candidate;
    // KANJIDIC2 is the canonical source of linguistic data for every
    // character. OpenJLPT overlays only the JLPT classification and its
    // own provenance metadata; its dictionary fields are never used.
    if (overlay) {
      report.openjlptMatched += 1;
      const sourceMetadata = overlay.record.source_metadata || {};
      candidate = {
        character,
        jlpt_level: overlay.record.jlpt_level ?? null,
        onyomi: entry.onyomi,
        kunyomi: entry.kunyomi,
        meanings: entry.meanings,
        stroke_count: entry.strokeCount,
        source_name: 'KANJIDIC2+OpenJLPT',
        source_metadata: {
          dataset: 'KANJIDIC2',
          license: 'CC BY-SA 4.0',
          source: 'EDRDG KANJIDIC2',
          kanjidic2_url: KANJIDIC_PROJECT_URL,
          kanjidic2_database_version: kanjidic.version.databaseVersion,
          kanjidic2_date_of_creation: kanjidic.version.dateOfCreation,
          ...(entry.grade === null ? {} : { kanjidic2_grade: entry.grade }),
          jlpt_source: 'OpenJLPT',
          jlpt_notice: OPENJLPT_NOTICE,
          ...(sourceMetadata.source_files ? { source_files: sourceMetadata.source_files } : {}),
          ...(sourceMetadata.openjlpt_grade === undefined ? {} : { openjlpt_grade: sourceMetadata.openjlpt_grade }),
          ...(sourceMetadata.openjlpt_frequency_rank === undefined ? {} : { openjlpt_frequency_rank: sourceMetadata.openjlpt_frequency_rank })
        }
      };
    } else {
      candidate = {
        character,
        jlpt_level: null,
        onyomi: entry.onyomi,
        kunyomi: entry.kunyomi,
        meanings: entry.meanings,
        stroke_count: entry.strokeCount,
        source_name: 'KANJIDIC2',
        source_metadata: {
          dataset: 'KANJIDIC2',
          license: 'CC BY-SA 4.0',
          source: 'EDRDG KANJIDIC2',
          kanjidic2_url: KANJIDIC_PROJECT_URL,
          kanjidic2_database_version: kanjidic.version.databaseVersion,
          kanjidic2_date_of_creation: kanjidic.version.dateOfCreation,
          ...(entry.grade === null ? {} : { kanjidic2_grade: entry.grade }),
          jlpt_source: null
        }
      };
    }
    try {
      const validated = normalizeImportedReference({
        character: candidate.character,
        jlpt_level: candidate.jlpt_level,
        onyomi: candidate.onyomi,
        kunyomi: candidate.kunyomi,
        meanings: candidate.meanings,
        stroke_count: candidate.stroke_count,
        source_metadata: candidate.source_metadata
      });
      references.push({
        character: validated.character,
        jlpt_level: validated.jlptLevel,
        onyomi: validated.onyomi,
        kunyomi: validated.kunyomi,
        meanings: validated.meanings,
        stroke_count: validated.strokeCount,
        source_name: candidate.source_name,
        source_metadata: validated.sourceMetadata
      });
    } catch (error) {
      report.rejectedRecords.push({ character, reason: error.message });
    }
  }

  for (const [character, { index }] of openjlptByCharacter) {
    if (!kanjidic.entries.has(character)) report.openjlptOnly.push({ character, index });
  }

  references.sort((left, right) => {
    const leftRank = left.jlpt_level === null ? JLPT_ORDER.length : JLPT_ORDER.indexOf(left.jlpt_level);
    const rightRank = right.jlpt_level === null ? JLPT_ORDER.length : JLPT_ORDER.indexOf(right.jlpt_level);
    return leftRank - rightRank || sortCharacter(left.character, right.character);
  });
  for (const reference of references) {
    if (reference.jlpt_level === null) report.unclassified += 1;
    else report.classified += 1;
  }
  return { references, report };
}

function parseArguments(argv) {
  const result = { kanjidic2: null, openjlpt: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--kanjidic2') result.kanjidic2 = argv[++index];
    else if (argument === '--openjlpt') result.openjlpt = argv[++index];
    else if (argument === '--output') result.output = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.kanjidic2) throw new Error('Provide --kanjidic2 path/to/kanjidic2.xml.');
  if (!result.openjlpt) throw new Error('Provide --openjlpt path/to/canonical-openjlpt.json.');
  if (!result.output) throw new Error('Provide --output path/to/merged-references.json.');
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const xmlText = await fs.readFile(path.resolve(args.kanjidic2), 'utf8');
  const openjlptRecords = JSON.parse(await fs.readFile(path.resolve(args.openjlpt), 'utf8'));
  if (!Array.isArray(openjlptRecords)) throw new Error('OpenJLPT input must be a JSON array of canonical records.');
  const kanjidic = parseKanjidic2(xmlText);
  const merged = mergeReferences(kanjidic, openjlptRecords);
  if (kanjidic.duplicates.length || merged.report.rejectedRecords.length) {
    console.error(JSON.stringify(merged.report, null, 2));
    throw new Error('Merge rejected one or more records; no canonical JSON was written.');
  }
  if (merged.report.openjlptOnly.length) {
    console.error(JSON.stringify(merged.report.openjlptOnly.slice(0, 20), null, 2));
    throw new Error('OpenJLPT characters missing from KANJIDIC2; no canonical JSON was written.');
  }
  await fs.writeFile(path.resolve(args.output), `${JSON.stringify(merged.references, null, 2)}\n`);
  console.log(JSON.stringify(merged.report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Kanji reference build failed.');
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseKanjidic2, mergeReferences, collapseCompatibilityAliases };
