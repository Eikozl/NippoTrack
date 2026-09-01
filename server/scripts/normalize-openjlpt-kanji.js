const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeImportedReference } = require('../src/services/kanjiReference');

const OPENJLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const SOURCE_METADATA = {
  dataset: 'OpenJLPT',
  license: 'CC BY-SA 4.0',
  source_repository: 'https://github.com/evanclan/OpenJLPT',
  source_notice: 'https://github.com/evanclan/OpenJLPT/blob/main/NOTICE.md',
  jlpt_source: "Jonathan Waller's JLPT Resources (tanos.co.uk; CC BY)",
  kanji_dictionary_source: 'KANJIDIC2 — EDRDG (CC BY-SA 4.0)',
  jlpt_classification: 'Community/reference data; not an official JLPT syllabus.'
};

function stableUnique(values) {
  return [...new Set(values)];
}

function fileNameFor(level, value) {
  return value?.fileName || `${level}.json`;
}

function sourceLocation(level, file, index) {
  return { level, file, index };
}

function optionalInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${fieldName} must be a positive integer when provided.`);
  }
  return number;
}

function canonicalOpenJlptRecord(raw, expectedLevel, file) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('OpenJLPT entry must be an object.');
  }
  if (raw.level !== expectedLevel) {
    throw new Error(`level must be ${expectedLevel} to match its input file.`);
  }
  const grade = optionalInteger(raw.grade, 'grade');
  const frequencyRank = optionalInteger(raw.freq, 'freq');
  const sourceMetadata = {
    ...SOURCE_METADATA,
    source_files: [file],
    ...(grade === undefined ? {} : { openjlpt_grade: grade }),
    ...(frequencyRank === undefined ? {} : { openjlpt_frequency_rank: frequencyRank })
  };
  const validated = normalizeImportedReference({
    character: raw.character,
    jlpt_level: raw.level,
    onyomi: raw.onyomi,
    kunyomi: raw.kunyomi,
    meanings: raw.meanings,
    stroke_count: raw.strokes,
    source_metadata: sourceMetadata
  });
  return {
    character: validated.character,
    jlpt_level: validated.jlptLevel,
    onyomi: validated.onyomi,
    kunyomi: validated.kunyomi,
    meanings: validated.meanings,
    stroke_count: validated.strokeCount,
    source_name: 'OpenJLPT',
    source_metadata: validated.sourceMetadata
  };
}

function canonicalRecord(record) {
  return {
    character: record.character,
    jlpt_level: record.jlpt_level,
    onyomi: record.onyomi,
    kunyomi: record.kunyomi,
    meanings: record.meanings,
    stroke_count: record.stroke_count,
    source_name: record.source_name,
    source_metadata: record.source_metadata
  };
}

function mergeSameLevel(records) {
  const first = records[0].reference;
  const fields = [
    ['stroke_count', 'stroke_count'],
    ['openjlpt_grade', 'openjlpt_grade'],
    ['openjlpt_frequency_rank', 'openjlpt_frequency_rank']
  ];
  for (const [recordField, metadataField] of fields) {
    const values = stableUnique(records
      .map(({ reference }) => recordField === 'stroke_count'
        ? reference[recordField]
        : reference.source_metadata[metadataField])
      .filter((value) => value !== undefined && value !== null));
    if (values.length > 1) {
      throw new Error(`duplicate records disagree on ${recordField}.`);
    }
  }
  const sourceFiles = stableUnique(records.flatMap(({ reference }) => reference.source_metadata.source_files)).sort();
  const merged = canonicalRecord({
    ...first,
    onyomi: stableUnique(records.flatMap(({ reference }) => reference.onyomi)),
    kunyomi: stableUnique(records.flatMap(({ reference }) => reference.kunyomi)),
    meanings: stableUnique(records.flatMap(({ reference }) => reference.meanings)),
    source_metadata: { ...first.source_metadata, source_files: sourceFiles }
  });
  const validated = normalizeImportedReference(merged);
  return {
    ...merged,
    character: validated.character,
    jlpt_level: validated.jlptLevel,
    onyomi: validated.onyomi,
    kunyomi: validated.kunyomi,
    meanings: validated.meanings,
    stroke_count: validated.strokeCount,
    source_metadata: validated.sourceMetadata
  };
}

function addRejected(report, location, reason) {
  report.rejectedRecords.push({ ...location, reason });
}

function sortCharacter(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeOpenJlptFiles(inputByLevel) {
  const report = {
    inputByLevel: Object.fromEntries(OPENJLPT_LEVELS.map((level) => [level, 0])),
    acceptedByLevel: Object.fromEntries(OPENJLPT_LEVELS.map((level) => [level, 0])),
    acceptedRecords: 0,
    duplicatesMerged: 0,
    crossLevelConflicts: [],
    rejectedRecords: []
  };
  const grouped = new Map();

  for (const level of OPENJLPT_LEVELS) {
    const input = inputByLevel[level];
    const records = Array.isArray(input) ? input : input?.records;
    const file = fileNameFor(level, input);
    if (!Array.isArray(records)) throw new Error(`${level} input must be an array of OpenJLPT records.`);
    report.inputByLevel[level] = records.length;
    records.forEach((raw, index) => {
      const location = sourceLocation(level, file, index);
      try {
        const reference = canonicalOpenJlptRecord(raw, level, file);
        const entries = grouped.get(reference.character) || [];
        entries.push({ location, reference });
        grouped.set(reference.character, entries);
      } catch (error) {
        addRejected(report, location, error.message);
      }
    });
  }

  const references = [];
  for (const [character, records] of grouped) {
    const levels = stableUnique(records.map(({ reference }) => reference.jlpt_level));
    if (levels.length > 1) {
      const orderedLevels = OPENJLPT_LEVELS.filter((level) => levels.includes(level));
      const locations = records.map(({ location }) => location)
        .sort((left, right) => OPENJLPT_LEVELS.indexOf(left.level) - OPENJLPT_LEVELS.indexOf(right.level) || left.index - right.index);
      report.crossLevelConflicts.push({ character, levels: orderedLevels, records: locations });
      locations.forEach((location) => addRejected(report, location, `character appears in multiple JLPT levels: ${orderedLevels.join(', ')}.`));
      continue;
    }
    try {
      const merged = mergeSameLevel(records);
      report.duplicatesMerged += records.length - 1;
      references.push(merged);
    } catch (error) {
      records.forEach(({ location }) => addRejected(report, location, error.message));
    }
  }

  references.sort((left, right) => OPENJLPT_LEVELS.indexOf(left.jlpt_level) - OPENJLPT_LEVELS.indexOf(right.jlpt_level) || sortCharacter(left.character, right.character));
  for (const reference of references) report.acceptedByLevel[reference.jlpt_level] += 1;
  report.acceptedRecords = references.length;
  report.crossLevelConflicts.sort((left, right) => sortCharacter(left.character, right.character));
  report.rejectedRecords.sort((left, right) => OPENJLPT_LEVELS.indexOf(left.level) - OPENJLPT_LEVELS.indexOf(right.level) || left.index - right.index || sortCharacter(left.reason, right.reason));
  return { references, report };
}

function parseArguments(argv) {
  const result = { inputs: {}, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') result.output = argv[++index];
    else if (/^--n[1-5]$/i.test(argument)) result.inputs[argument.slice(2).toUpperCase()] = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.output) throw new Error('Provide --output path/to/canonical-references.json.');
  for (const level of OPENJLPT_LEVELS) {
    if (!result.inputs[level]) throw new Error(`Provide --${level.toLowerCase()} path/to/${level.toLowerCase()}.json.`);
  }
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const inputs = {};
  for (const level of OPENJLPT_LEVELS) {
    const inputPath = path.resolve(args.inputs[level]);
    inputs[level] = { fileName: path.basename(inputPath), records: JSON.parse(await fs.readFile(inputPath, 'utf8')) };
  }
  const normalized = normalizeOpenJlptFiles(inputs);
  if (normalized.report.rejectedRecords.length) {
    console.error(JSON.stringify(normalized.report, null, 2));
    throw new Error('Normalization rejected one or more OpenJLPT records; no canonical JSON was written.');
  }
  await fs.writeFile(path.resolve(args.output), `${JSON.stringify(normalized.references, null, 2)}\n`);
  console.log(JSON.stringify(normalized.report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('OpenJLPT normalization failed.');
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { normalizeOpenJlptFiles, OPENJLPT_LEVELS };
