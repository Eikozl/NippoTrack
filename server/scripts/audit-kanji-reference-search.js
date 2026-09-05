/*
 * Diagnostic-only Kanji Reference search coverage audit.
 *
 * READ-ONLY: issues SELECT queries through the production search path
 * (searchKanjiReferences) and never mutates data, migrations, or indexes.
 * Fails safely (exit 2) when database configuration is missing/unreachable.
 *
 * Usage (from server/):
 *   node --env-file=.env.test scripts/audit-kanji-reference-search.js [--json audit.json] [--concurrency 8] [--levels N5,N4] [--max-rows 200]
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const AUDIT_LIMIT = 100;
const PRODUCT_LIMIT = 20;
const GLOBAL_SEARCH_LIMIT = 5;

function parseArgs(argv) {
  const options = { json: null, concurrency: 8, levels: null, maxRows: null, offset: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = argv[++index];
    else if (argument === '--concurrency') options.concurrency = Math.max(1, Number(argv[++index]) || 8);
    else if (argument === '--levels') options.levels = new Set(argv[++index].split(',').map((level) => level.trim().toUpperCase()));
    else if (argument === '--max-rows') options.maxRows = Math.max(1, Number(argv[++index]) || 0);
    else if (argument === '--offset') options.offset = Math.max(0, Number(argv[++index]) || 0);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function rankOf(items, character) {
  const index = items.findIndex((item) => item.character === character);
  return index === -1 ? null : index + 1;
}

function levelKey(row) {
  return row.jlpt_level || 'unknown/null';
}

async function auditRow(row, searchKanjiReferences, helpers) {
  const { normalizeJapaneseReading, hiraganaToRomaji } = helpers;
  const result = { character: row.character, jlptLevel: row.jlpt_level, exact: null, meaning: null, readings: [], romaji: [] };

  const exact = await searchKanjiReferences(row.character, AUDIT_LIMIT);
  const exactRank = rankOf(exact.items, row.character);
  result.exact = { status: exactRank === 1 ? 'PASS' : 'FAIL', rank: exactRank, category: exactRank === 1 ? null : 'EXACT_CHARACTER_QUERY_MISS' };

  const firstMeaning = (row.meanings || [])[0] || null;
  if (!firstMeaning) {
    result.meaning = { status: 'NOT_APPLICABLE', probe: null, rank: null, truncated: false, category: null };
  } else {
    const found = await searchKanjiReferences(firstMeaning, AUDIT_LIMIT);
    const rank = rankOf(found.items, row.character);
    const truncated = found.items.length >= AUDIT_LIMIT;
    if (rank !== null) {
      result.meaning = {
        status: 'PASS', probe: firstMeaning, rank, truncated,
        paginationNote: rank > PRODUCT_LIMIT ? 'PAGINATION_RANKING_MISS beyond product limit 20' : (rank > GLOBAL_SEARCH_LIMIT ? 'hidden from global search limit 5' : null),
        category: null
      };
    } else {
      result.meaning = { status: truncated ? 'AMBIGUOUS' : 'FAIL', probe: firstMeaning, rank, truncated, category: truncated ? 'PAGINATION_RANKING_MISS' : 'MEANING_QUERY_MISS' };
    }
  }

  const readings = [...new Set([...(row.onyomi || []), ...(row.kunyomi || [])])];
  for (const reading of readings) {
    const found = await searchKanjiReferences(reading, AUDIT_LIMIT);
    const rank = rankOf(found.items, row.character);
    let category = null;
    if (rank === null) {
      category = 'READING_QUERY_MISS';
      try {
        const normalized = normalizeJapaneseReading(reading);
        if (normalized && normalized !== reading) {
          const retry = await searchKanjiReferences(normalized, AUDIT_LIMIT);
          if (rankOf(retry.items, row.character) !== null) category = 'NORMALIZATION_MISS';
        }
      } catch { category = 'NORMALIZATION_MISS'; }
    }
    result.readings.push({ reading, status: rank !== null ? 'PASS' : 'FAIL', rank, category });
  }

  const normalizedReadings = [...new Set(readings.map((reading) => {
    try { return normalizeJapaneseReading(reading); } catch { return null; }
  }).filter(Boolean))];
  for (const normalized of normalizedReadings) {
    const romaji = hiraganaToRomaji(normalized);
    if (!romaji) {
      result.romaji.push({ reading: normalized, romaji: null, status: 'SKIP', rank: null, category: 'ROMAJI_NOT_SUPPORTED' });
      continue;
    }
    const found = await searchKanjiReferences(romaji, AUDIT_LIMIT);
    const rank = rankOf(found.items, row.character);
    result.romaji.push({ reading: normalized, romaji, status: rank !== null ? 'PASS' : 'FAIL', rank, category: rank !== null ? null : 'READING_QUERY_MISS' });
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let pool;
  try {
    pool = require('../src/config/db');
    await pool.execute('SELECT 1');
  } catch (error) {
    console.error('Audit aborted: database is unreachable. Provide DB env (e.g. node --env-file=.env.test).');
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const { searchKanjiReferences } = require('../src/services/kanjiReference');
  const helpers = require('../src/search/japaneseSearch');
  const boundSearch = (query, limit) => searchKanjiReferences(query, limit, pool);

  const [rows] = await pool.execute('SELECT id_kanji_reference, character, jlpt_level, onyomi, kunyomi, meanings FROM kanji_reference ORDER BY id_kanji_reference');
  let scope = rows;
  if (options.levels) scope = scope.filter((row) => options.levels.has(levelKey(row).toUpperCase()));
  if (options.offset) scope = scope.slice(options.offset);
  if (options.maxRows) scope = scope.slice(0, options.maxRows);
  console.log(`Auditing ${scope.length} of ${rows.length} kanji_reference rows (concurrency ${options.concurrency}).`);

  const results = new Array(scope.length);
  let completed = 0;
  async function worker(start) {
    for (let index = start; index < scope.length; index += options.concurrency) {
      results[index] = await auditRow(scope[index], boundSearch, helpers);
      completed += 1;
      if (completed % 200 === 0) console.log(`  ...${completed}/${scope.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, scope.length) }, (_, workerIndex) => worker(workerIndex)));

  const falsePositiveProbes = ['I', 'ore', 'a', 'ka'];
  const probes = {};
  for (const probe of falsePositiveProbes) {
    const found = await boundSearch(probe, AUDIT_LIMIT);
    const histogram = {};
    found.items.forEach((item) => { histogram[item.jlptLevel || 'unknown/null'] = (histogram[item.jlptLevel || 'unknown/null'] || 0) + 1; });
    probes[probe] = {
      returned: found.items.length, truncated: found.items.length >= AUDIT_LIMIT,
      top: found.items.slice(0, 5).map((item) => item.character),
      jlptHistogram: histogram,
      transliteration: found.transliteration
    };
  }
  const exactSpots = {};
  for (const character of ['日', '本', '水']) {
    const found = await boundSearch(character, PRODUCT_LIMIT);
    exactSpots[character] = { rank: rankOf(found.items, character), first: found.items[0]?.character || null };
  }

  const summary = summarize(results, probes, exactSpots, rows.length);
  console.log(JSON.stringify(summary, null, 2));
  if (options.json) {
    await fs.writeFile(path.resolve(options.json), `${JSON.stringify({ summary, rows: results, probes, exactSpots }, null, 2)}\n`);
    console.log(`Detail written to ${options.json}`);
  }
  if (typeof pool.end === 'function') await pool.end().catch(() => undefined);
}

function summarize(results, probes, exactSpots, totalRows) {
  const byLevel = {};
  const categories = {};
  const examples = {};
  function ensureLevel(level) {
    if (!byLevel[level]) byLevel[level] = { rows: 0, exactFail: 0, meaningFail: 0, meaningAmbiguous: 0, meaningNA: 0, readingFail: 0, romajiFail: 0, romajiSkip: 0 };
    return byLevel[level];
  }
  function recordExample(category, character) {
    if (!examples[category]) examples[category] = [];
    if (examples[category].length < 20 && !examples[category].includes(character)) examples[category].push(character);
  }
  let exactPass = 0;
  let meaningPass = 0; let meaningApplicable = 0;
  let readingPass = 0; let readingTotal = 0;
  let romajiPass = 0; let romajiTotal = 0; let romajiSkip = 0;

  for (const result of results) {
    const level = ensureLevel(result.jlptLevel || 'unknown/null');
    level.rows += 1;
    if (result.exact.status === 'PASS') exactPass += 1;
    else { level.exactFail += 1; categories.EXACT_CHARACTER_QUERY_MISS = (categories.EXACT_CHARACTER_QUERY_MISS || 0) + 1; recordExample('EXACT_CHARACTER_QUERY_MISS', result.character); }

    if (result.meaning.status === 'NOT_APPLICABLE') level.meaningNA += 1;
    else {
      meaningApplicable += 1;
      if (result.meaning.status === 'PASS') meaningPass += 1;
      else if (result.meaning.status === 'AMBIGUOUS') { level.meaningAmbiguous += 1; categories.PAGINATION_RANKING_MISS = (categories.PAGINATION_RANKING_MISS || 0) + 1; recordExample('PAGINATION_RANKING_MISS', result.character); }
      else { level.meaningFail += 1; categories.MEANING_QUERY_MISS = (categories.MEANING_QUERY_MISS || 0) + 1; recordExample('MEANING_QUERY_MISS', result.character); }
    }

    for (const reading of result.readings) {
      readingTotal += 1;
      if (reading.status === 'PASS') readingPass += 1;
      else { level.readingFail += 1; categories[reading.category] = (categories[reading.category] || 0) + 1; recordExample(reading.category, `${result.character}(${reading.reading})`); }
    }
    for (const entry of result.romaji) {
      if (entry.status === 'SKIP') { romajiSkip += 1; level.romajiSkip += 1; categories.ROMAJI_NOT_SUPPORTED = (categories.ROMAJI_NOT_SUPPORTED || 0) + 1; recordExample('ROMAJI_NOT_SUPPORTED', `${result.character}(${entry.reading})`); continue; }
      romajiTotal += 1;
      if (entry.status === 'PASS') romajiPass += 1;
      else { level.romajiFail += 1; categories[entry.category] = (categories[entry.category] || 0) + 1; recordExample(entry.category, `${result.character}(${entry.romaji})`); }
    }
  }

  return {
    rowsAudited: results.length, totalRows,
    exactCharacter: { pass: exactPass, coverage: results.length ? exactPass / results.length : null },
    meaningFirst: { applicable: meaningApplicable, pass: meaningPass, coverage: meaningApplicable ? meaningPass / meaningApplicable : null },
    readings: { total: readingTotal, pass: readingPass, coverage: readingTotal ? readingPass / readingTotal : null },
    romaji: { total: romajiTotal, pass: romajiPass, skipped: romajiSkip, coverage: romajiTotal ? romajiPass / romajiTotal : null },
    byLevel, categories, examples, probes, exactSpots
  };
}

main().catch((error) => { console.error('Audit failed.'); console.error(error); process.exitCode = 1; });
