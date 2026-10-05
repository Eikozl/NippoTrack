// Tabular export: CSV streamed row-by-row plus a dependency-free minimal
// XLSX writer (ZIP with stored entries + inline strings — no shared-string
// table, no styling; Excel/LibreOffice open it as plain data sheets).
// Column headers stay in English; the first CSV section carries the export
// metadata row (date, user hash, version).
const { createHash } = require('node:crypto');

const PAGE_SIZE = 500;
const XLSX_MAX_ROWS_PER_SHEET = 50000;

const ENTITIES = {
  vocabulary: {
    label: 'vocabulary',
    headers: ['id', 'word', 'reading', 'meaning', 'jlpt', 'status', 'notes', 'created_at'],
    query: 'SELECT id_vocabulary, word, reading, meaning, jlpt_level, status, notes, created_at FROM vocabulary WHERE user_id = ? ORDER BY id_vocabulary LIMIT ? OFFSET ?'
  },
  kanji: {
    label: 'kanji',
    headers: ['id', 'character', 'meaning', 'onyomi', 'kunyomi', 'jlpt', 'status', 'notes'],
    query: 'SELECT id_kanji, character_kanji, meaning, onyomi, kunyomi, jlpt_level, status, notes FROM kanji WHERE user_id = ? ORDER BY id_kanji LIMIT ? OFFSET ?'
  },
  grammar: {
    label: 'grammar',
    headers: ['id', 'grammar_point', 'meaning', 'structure', 'example', 'jlpt', 'status', 'notes'],
    query: 'SELECT id_grammar, grammar_point, meaning, structure, example, jlpt_level, status, notes FROM grammar_points WHERE user_id = ? ORDER BY id_grammar LIMIT ? OFFSET ?'
  },
  notes: {
    label: 'notes',
    headers: ['id', 'title', 'body', 'category', 'created_at'],
    query: 'SELECT id_note, title, body, category, created_at FROM notes WHERE user_id = ? ORDER BY id_note LIMIT ? OFFSET ?'
  },
  sessions: {
    label: 'sessions',
    headers: ['id', 'date', 'duration', 'category', 'resource', 'notes'],
    query: 'SELECT id_session, session_date, duration_minutes, category, resource, notes FROM study_sessions WHERE user_id = ? ORDER BY id_session LIMIT ? OFFSET ?'
  }
};

function parseEntities(value) {
  const names = String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const picked = (names.length ? names : Object.keys(ENTITIES)).filter((name) => ENTITIES[name]);
  if (!picked.length) return { error: 'entities must be a subset of vocabulary,kanji,grammar,notes,sessions' };
  return { value: [...new Set(picked)] };
}

function userHash(userId) {
  return createHash('sha256').update(String(userId || ''), 'utf8').digest('hex').slice(0, 16);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(cells) {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

// Anki plain-text import: tab-separated front/back, no header row (Anki
// reads lines literally). Newlines inside a cell stay quoted.
function tsvRow(cells) {
  return `${cells.map(csvCell).join('\t')}\n`;
}

function columnIndex(headers, name) {
  return headers.indexOf(name);
}

// Front/back per entity for Anki Basic cards. Vocabulary carries the
// reading on the answer side; kanji answers add both readings.
function ankiRow(label, headers, values) {
  const at = (name) => {
    const index = columnIndex(headers, name);
    return index >= 0 ? values[index] : null;
  };
  const text = (value) => (value === null || value === undefined ? '' : String(value));
  if (label === 'kanji') {
    const readings = [at('onyomi'), at('kunyomi')].map(text).filter(Boolean).join(' · ');
    return [text(at('character')), [text(at('meaning')), readings].filter(Boolean).join('\n')];
  }
  if (label === 'grammar') {
    return [text(at('grammar_point')), [text(at('meaning')), text(at('structure'))].filter(Boolean).join('\n')];
  }
  if (label === 'sessions') {
    return [`${at('date') || ''} · ${at('category') || ''}`, `${at('duration') || 0} min${at('notes') ? `\n${at('notes')}` : ''}`];
  }
  if (label === 'notes') {
    return [text(at('title')) || '(untitled)', text(at('body'))];
  }
  return [text(at('word')), [text(at('reading')), text(at('meaning'))].filter(Boolean).join('\n')];
}

// One Obsidian-friendly Markdown document per entity: H1 title, H2 item,
// bullet facts. Deterministic, no frontmatter dialect assumed.
function obsidianDocument(label, headers, rows, { exportedAt, hash } = {}) {
  const lines = [`# NippoTrack ${label} export`, '', `_Exported ${exportedAt || ''} · user ${hash || ''} · version 1_`, ''];
  const at = (values, name) => {
    const index = columnIndex(headers, name);
    return index >= 0 ? values[index] : null;
  };
  const fact = (name, value) => {
    const text = value === null || value === undefined || value === '' ? null : String(value).replace(/\r?\n/g, ' / ');
    return text ? `- ${name}: ${text}` : null;
  };
  for (const values of rows) {
    const title = label === 'kanji' ? at(values, 'character')
      : label === 'grammar' ? at(values, 'grammar_point')
      : label === 'sessions' ? `${at(values, 'date') || ''} · ${at(values, 'category') || ''}`
      : label === 'notes' ? at(values, 'title') || '(untitled)'
      : at(values, 'word');
    lines.push(`## ${String(title || 'item').replace(/\r?\n/g, ' ')}`);
    for (const name of headers) {
      if (['word', 'character', 'grammar_point', 'title'].includes(name) && label !== 'sessions') continue;
      const line = fact(name, at(values, name));
      if (line) lines.push(line);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function metadataRow(exportedAt, hash) {
  return csvRow(['# nippotrack export', `exported_at=${exportedAt}`, `user=${hash}`, 'version=1']);
}

// Paged pull per entity; the callback receives one array of row arrays per
// page so callers stream (CSV) or accumulate (XLSX) without full tables.
async function eachEntityPage(executor, userId, entityName, onPage) {
  const def = ENTITIES[entityName];
  let offset = 0;
  for (;;) {
    const [rows] = await executor.execute(def.query, [userId, PAGE_SIZE, offset]);
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return;
    const values = list.map((row) => def.headers.map((header) => {
      const column = header === 'id' ? Object.keys(row).find((key) => /^id_/i.test(key))
        : header === 'jlpt' ? 'jlpt_level'
        : header === 'character' ? 'character_kanji'
        : header === 'date' ? 'session_date'
        : header === 'duration' ? 'duration_minutes'
        : header === 'grammar_point' ? 'grammar_point'
        : header === 'body' ? 'body'
        : header;
      const value = row[column];
      return value instanceof Date ? value.toISOString() : value;
    }));
    await onPage(values);
    if (list.length < PAGE_SIZE) return;
    offset += PAGE_SIZE;
  }
}

function xlsxEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function columnLetter(index) {
  let letters = '';
  let rest = index;
  do {
    letters = String.fromCharCode(65 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return letters;
}

function sheetXml(name, headers, rows) {
  const cells = [];
  const pushRow = (values, rowNumber) => {
    cells.push(`<row r="${rowNumber}">`);
    values.forEach((value, columnIndex) => {
      cells.push(`<c r="${columnLetter(columnIndex)}${rowNumber}" t="inlineStr"><is><t>${xlsxEscape(value)}</t></is></c>`);
    });
    cells.push('</row>');
  };
  pushRow(headers, 1);
  rows.forEach((values, index) => pushRow(values, index + 2));
  const dimension = `A1:${columnLetter(headers.length - 1)}${rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetData>${cells.join('')}</sheetData></worksheet>`;
}

// Minimal ZIP writer (stored entries only): CRC32 table version, no
// compression library needed.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const writeUInt32 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0, 0);
    return buffer;
  };
  const writeUInt16 = (value) => {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value & 0xffff, 0);
    return buffer;
  };
  for (const { name, data } of files) {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(content);
    const local = Buffer.concat([
      writeUInt32(0x04034b50), writeUInt16(20), writeUInt16(0x0800), writeUInt16(0),
      writeUInt16(0), writeUInt16(0), writeUInt32(crc), writeUInt32(content.length), writeUInt32(content.length),
      writeUInt16(nameBuffer.length), writeUInt16(0), nameBuffer
    ]);
    chunks.push(local, content);
    central.push({
      header: Buffer.concat([
        writeUInt32(0x02014b50), writeUInt16(20), writeUInt16(20), writeUInt16(0x0800), writeUInt16(0),
        writeUInt16(0), writeUInt16(0), writeUInt32(crc), writeUInt32(content.length), writeUInt32(content.length),
        writeUInt16(nameBuffer.length), writeUInt16(0), writeUInt16(0), writeUInt16(0), writeUInt16(0),
        writeUInt32(0), writeUInt32(offset), nameBuffer
      ])
    });
    offset += local.length + content.length;
  }
  const centralStart = offset;
  const centralBuffers = [];
  for (const { header } of central) {
    centralBuffers.push(header);
    offset += header.length;
  }
  const centralSize = offset - centralStart;
  const end = Buffer.concat([
    writeUInt32(0x06054b50), writeUInt16(0), writeUInt16(0),
    writeUInt16(central.length), writeUInt16(central.length),
    writeUInt32(centralSize), writeUInt32(centralStart), writeUInt16(0)
  ]);
  return Buffer.concat([...chunks, ...centralBuffers, end]);
}

function buildXlsx(sheets) {
  for (const sheet of sheets) {
    if (sheet.rows.length > XLSX_MAX_ROWS_PER_SHEET) {
      throw new Error(`Sheet ${sheet.name} exceeds ${XLSX_MAX_ROWS_PER_SHEET} rows; narrow the export.`);
    }
  }
  const sheetFiles = sheets.map((sheet, index) => ({
    name: `xl/worksheets/sheet${index + 1}.xml`,
    data: sheetXml(sheet.name, sheet.headers, sheet.rows)
  }));
  const sheetRefs = sheets.map((sheet, index) => `<sheet name="${xlsxEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const rels = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  return zipStore([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetRefs}</sheets></workbook>`
    },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` },
    ...sheetFiles
  ]);
}

module.exports = {
  ENTITIES,
  PAGE_SIZE,
  XLSX_MAX_ROWS_PER_SHEET,
  ankiRow,
  buildXlsx,
  csvCell,
  csvRow,
  eachEntityPage,
  metadataRow,
  obsidianDocument,
  parseEntities,
  sheetXml,
  tsvRow,
  userHash,
  xlsxEscape,
  zipStore
};
