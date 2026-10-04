// Tabular export tests: CSV escaping, paged pulls and the dependency-free
// XLSX writer, all against fakes (no database, no server).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildXlsx,
  csvCell,
  csvRow,
  eachEntityPage,
  metadataRow,
  parseEntities,
  xlsxEscape
} = require('../src/services/exportService');

test('csv cells quote commas, quotes and newlines; Japanese passes through', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell('水'), '水');
  assert.equal(csvCell(null), '');
  assert.equal(csvRow(['a', 'b,c']), 'a,"b,c"\r\n');
  const meta = metadataRow('2026-10-04T00:00:00Z', 'abc123');
  assert.match(meta, /^# nippotrack export,/);
  assert.match(meta, /exported_at=2026-10-04T00:00:00Z/);
  assert.match(meta, /user=abc123/);
});

test('entities parse with defaults and reject unknowns', () => {
  assert.deepEqual(parseEntities('').value, ['vocabulary', 'kanji', 'grammar', 'notes', 'sessions']);
  assert.deepEqual(parseEntities('kanji,vocabulary,kanji').value, ['kanji', 'vocabulary']);
  assert.ok(parseEntities('emoji').error, 'unknown entity rejected');
});

test('paged pulls map headers and stream page by page', async () => {
  const total = 1200;
  const pages = [];
  const executor = {
    async execute(sql, params) {
      assert.match(sql, /FROM vocabulary/);
      const offset = params[params.length - 1];
      const limit = params[params.length - 2];
      const rows = [];
      for (let i = offset; i < Math.min(offset + limit, total); i += 1) {
        rows.push({
          id_vocabulary: i + 1, word: `w${i}`, reading: i % 2 ? 'みず' : null,
          meaning: 'm', jlpt_level: 'N5', status: 'New', notes: null,
          created_at: new Date('2026-01-01T00:00:00Z')
        });
      }
      return [rows];
    }
  };
  let seen = 0;
  await eachEntityPage(executor, 'user-1', 'vocabulary', async (page) => {
    pages.push(page.length);
    seen += page.length;
    assert.equal(page[0].length, 8, 'eight mapped columns');
    assert.equal(typeof page[0][7], 'string', 'dates serialize to ISO');
  });
  assert.deepEqual(pages, [500, 500, 200]);
  assert.equal(seen, total);
});

test('xlsx writer emits a readable archive with escaped sheets', () => {
  const buffer = buildXlsx([
    { name: 'vocabulary', headers: ['id', 'word'], rows: [[1, '水'], [2, 'a&b']] },
    { name: 'notes', headers: ['id'], rows: [] }
  ]);
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
  const text = buffer.toString('utf8');
  assert.match(text, /vocabulary/);
  assert.match(text, /a&amp;b/, 'ampersands escaped');
  assert.match(text, /inlineStr/, 'inline strings, no shared-string table');
});

test('xlsx writer caps runaway sheets', () => {
  assert.throws(
    () => buildXlsx([{ name: 'vocabulary', headers: ['id'], rows: Array.from({ length: 50001 }, (_, i) => [i]) }]),
    /exceeds 50000 rows/
  );
  assert.equal(xlsxEscape('a<b>"c"&'), 'a&lt;b&gt;&quot;c&quot;&amp;');
});
