import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import {
  detectFormat, detectDelimiter, parseDelimited, parseCsv, parseJsonRows, parseFlatFile,
  inferColumnType, sanitizeIdentifier, inferSchema, buildCreateTableDDL,
  cellToSqlLiteral, buildInsertStatement,
  mapFirebirdFieldToSqlType, autoMapColumns, buildInsertStatementForMapping, FirebirdColumnMeta,
  streamDelimitedRows, detectDelimiterFromFile, readDelimitedPreview, streamDataRows,
} from '../shared/flat-file-parser';

/** Simulates a chunked fs.createReadStream() by feeding streamDelimitedRows() one array element per underlying chunk. */
async function streamChunks(chunks: string[], delimiter = ','): Promise<string[][]> {
  const stream = Readable.from(chunks);
  const rows: string[][] = [];
  for await (const row of streamDelimitedRows(stream, delimiter)) {
    rows.push(row);
  }
  return rows;
}

// tableInfoQuery()'s CASE has string-literal branches of different lengths, which Firebird types
// as one fixed-width CHAR sized to the longest branch ('TIMESTAMP', 9 chars) -- every shorter
// result comes back blank-padded to 9 chars over the wire, confirmed against a real server. Pad
// FIELD_TYPE here so these tests exercise what mapFirebirdFieldToSqlType() actually receives,
// not an idealized already-trimmed string -- that's exactly the gap that let this ship untrimmed
// the first time (every test here passed against clean strings; only a live server caught it).
function field(overrides: Partial<FirebirdColumnMeta> & { FIELD_NAME: string; FIELD_TYPE: string }): FirebirdColumnMeta {
  return { FIELD_SUB_TYPE: null, FIELD_PRECISION: null, FIELD_SCALE: null, ...overrides, FIELD_TYPE: overrides.FIELD_TYPE.padEnd(9) };
}

suite('flat-file-parser – detectFormat()', function () {
  test('detects .json', function () {
    assert.strictEqual(detectFormat('data.json'), 'json');
  });
  test('detects .tsv', function () {
    assert.strictEqual(detectFormat('data.tsv'), 'tsv');
  });
  test('defaults to csv for .csv/.txt/unknown extensions', function () {
    assert.strictEqual(detectFormat('data.csv'), 'csv');
    assert.strictEqual(detectFormat('data.txt'), 'csv');
    assert.strictEqual(detectFormat('data'), 'csv');
  });
  test('is case-insensitive', function () {
    assert.strictEqual(detectFormat('DATA.JSON'), 'json');
  });
});

suite('flat-file-parser – detectDelimiter()', function () {
  test('detects comma', function () {
    assert.strictEqual(detectDelimiter('a,b,c'), ',');
  });
  test('detects tab', function () {
    assert.strictEqual(detectDelimiter('a\tb\tc'), '\t');
  });
  test('detects semicolon', function () {
    assert.strictEqual(detectDelimiter('a;b;c'), ';');
  });
  test('defaults to comma when no delimiter is present', function () {
    assert.strictEqual(detectDelimiter('justoneword'), ',');
  });
  test('picks whichever delimiter appears most often', function () {
    assert.strictEqual(detectDelimiter('a,b;c,d,e'), ',');
  });
});

suite('flat-file-parser – parseDelimited()', function () {
  test('parses a simple comma-delimited grid', function () {
    const rows = parseDelimited('a,b,c\n1,2,3', ',');
    assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
  });

  test('handles \\r\\n line endings', function () {
    const rows = parseDelimited('a,b\r\n1,2', ',');
    assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
  });

  test('handles quoted fields containing the delimiter', function () {
    const rows = parseDelimited('name,note\n"Smith, John",hello', ',');
    assert.deepStrictEqual(rows, [['name', 'note'], ['Smith, John', 'hello']]);
  });

  test('handles quoted fields containing embedded newlines', function () {
    const rows = parseDelimited('a,b\n"line1\nline2",x', ',');
    assert.deepStrictEqual(rows, [['a', 'b'], ['line1\nline2', 'x']]);
  });

  test('handles doubled-quote escaping inside a quoted field', function () {
    const rows = parseDelimited('a\n"She said ""hi"""', ',');
    assert.deepStrictEqual(rows, [['a'], ['She said "hi"']]);
  });

  test('handles a tab delimiter', function () {
    const rows = parseDelimited('a\tb\n1\t2', '\t');
    assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
  });

  test('drops trailing blank lines', function () {
    const rows = parseDelimited('a,b\n1,2\n\n', ',');
    assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
  });

  test('strips a leading UTF-8 BOM', function () {
    const rows = parseDelimited('﻿a,b\n1,2', ',');
    assert.deepStrictEqual(rows[0], ['a', 'b']);
  });
});

// ── streamDelimitedRows() — the chunked/large-file counterpart to parseDelimited() ────────────
// (docs/roadmap/flat-file-import-wizard.md's "Large-file streaming" item). Each test feeds the
// input pre-split into separate chunks at the exact byte offset that's hardest for a resumable
// parser to get right — mid-field, mid-quote, mid-CRLF, mid-doubled-quote — the cases a single
// whole-string parse (parseDelimited()) can never actually exercise.

suite('flat-file-parser – streamDelimitedRows()', function () {
  test('a row split across two chunks, right in the middle of a field', async function () {
    const rows = await streamChunks(['a,b\n1,Al', 'ice\n2,Bob']);
    assert.deepStrictEqual(rows, [['a', 'b'], ['1', 'Alice'], ['2', 'Bob']]);
  });

  test('every chunk boundary lands on a different single character (worst case)', async function () {
    const text = 'id,name\n1,Alice\n2,"Smith, Bob"\n3,Carol\n';
    const rows = await streamChunks(text.split(''));
    assert.deepStrictEqual(rows, [['id', 'name'], ['1', 'Alice'], ['2', 'Smith, Bob'], ['3', 'Carol']]);
  });

  test('a quoted field spanning multiple chunks, including an embedded delimiter and newline', async function () {
    const rows = await streamChunks(['a,b\n1,"line1\nhas, a comma', ' and continues"\n2,x']);
    assert.deepStrictEqual(rows, [['a', 'b'], ['1', 'line1\nhas, a comma and continues'], ['2', 'x']]);
  });

  test('a doubled-quote escape split exactly at the chunk boundary', async function () {
    // Field content is `She said "hi"` -- as CSV-escaped text that's `"She said ""hi"""`.
    // Split so chunk 1 ends right after the FIRST quote of the `""` pair before "hi".
    const rows = await streamChunks(['a\n"She said "', '"hi"""']);
    assert.deepStrictEqual(rows, [['a'], ['She said "hi"']]);
  });

  test("a chunk boundary right after a field's real closing quote (not a doubled escape)", async function () {
    const rows = await streamChunks(['a,b\n"Smith"', ',John\n2,x']);
    assert.deepStrictEqual(rows, [['a', 'b'], ['Smith', 'John'], ['2', 'x']]);
  });

  test('a file ending exactly on a quoted field\'s closing quote, with no trailing content', async function () {
    const rows = await streamChunks(['a\n"abc']);
    assert.deepStrictEqual(rows, [['a'], ['abc']]);
    const rowsSplit = await streamChunks(['a\n"ab', 'c"']);
    assert.deepStrictEqual(rowsSplit, [['a'], ['abc']]);
  });

  test('a \\r\\n line ending split exactly between the \\r and the \\n', async function () {
    const rows = await streamChunks(['a,b\r', '\n1,2']);
    assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
  });

  test('a bare trailing \\r at a chunk boundary NOT followed by \\n is still just one line ending', async function () {
    const rows = await streamChunks(['a,b\r', 'c,d']);
    assert.deepStrictEqual(rows, [['a', 'b'], ['c', 'd']]);
  });

  test('the header row is the first yielded row', async function () {
    const rows = await streamChunks(['id,name\n1,Alice']);
    assert.deepStrictEqual(rows[0], ['id', 'name']);
  });

  test('skips a genuinely blank trailing line rather than yielding a spurious all-empty row', async function () {
    const rows = await streamChunks(['a,b\n1,2\n\n']);
    assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
  });

  test('strips a leading UTF-8 BOM exactly once, even when the BOM and first char land in the same chunk', async function () {
    const rows = await streamChunks(['﻿a,b\n1,2']);
    assert.deepStrictEqual(rows[0], ['a', 'b']);
  });

  test('a tab delimiter works the same as parseDelimited()', async function () {
    const rows = await streamChunks(['a\tb\n1\t2'], '\t');
    assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
  });

  test('produces the exact same result as parseDelimited() for the same input, whole or chunked', async function () {
    const text = 'id,name,note\n1,Alice,"hi, there"\n2,Bob,"multi\nline"\n3,Carol,plain\n';
    const whole = parseDelimited(text, ',');
    const chunked = await streamChunks([text.slice(0, 10), text.slice(10, 25), text.slice(25)]);
    assert.deepStrictEqual(chunked, whole);
  });
});

suite('flat-file-parser – parseCsv()', function () {
  test('treats the first row as headers', function () {
    const { headers, rows } = parseCsv('id,name\n1,Alice\n2,Bob');
    assert.deepStrictEqual(headers, ['id', 'name']);
    assert.deepStrictEqual(rows, [['1', 'Alice'], ['2', 'Bob']]);
  });

  test('auto-sniffs the delimiter when none is given', function () {
    const { headers, rows } = parseCsv('id;name\n1;Alice');
    assert.deepStrictEqual(headers, ['id', 'name']);
    assert.deepStrictEqual(rows, [['1', 'Alice']]);
  });

  test('respects an explicit delimiter override', function () {
    const { headers } = parseCsv('id\tname\n1\tAlice', '\t');
    assert.deepStrictEqual(headers, ['id', 'name']);
  });

  test('returns empty headers/rows for empty input', function () {
    assert.deepStrictEqual(parseCsv(''), { headers: [], rows: [] });
  });
});

suite('flat-file-parser – parseJsonRows()', function () {
  test('parses an array of objects using the first object\'s keys as headers', function () {
    const { headers, rows } = parseJsonRows('[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]');
    assert.deepStrictEqual(headers, ['id', 'name']);
    assert.deepStrictEqual(rows, [['1', 'Alice'], ['2', 'Bob']]);
  });

  test('converts null/undefined values to empty strings', function () {
    const { rows } = parseJsonRows('[{"id":1,"name":null}]');
    assert.deepStrictEqual(rows, [['1', '']]);
  });

  test('stringifies nested objects/arrays', function () {
    const { rows } = parseJsonRows('[{"id":1,"tags":["a","b"]}]');
    assert.deepStrictEqual(rows, [['1', '["a","b"]']]);
  });

  test('returns empty headers/rows for an empty array', function () {
    assert.deepStrictEqual(parseJsonRows('[]'), { headers: [], rows: [] });
  });
});

suite('flat-file-parser – parseFlatFile()', function () {
  test('dispatches .csv to parseCsv with a sniffed delimiter', function () {
    const { headers } = parseFlatFile('data.csv', 'id,name\n1,Alice');
    assert.deepStrictEqual(headers, ['id', 'name']);
  });

  test('dispatches .tsv to parseCsv with a tab delimiter', function () {
    const { headers, rows } = parseFlatFile('data.tsv', 'id\tname\n1\tAlice');
    assert.deepStrictEqual(headers, ['id', 'name']);
    assert.deepStrictEqual(rows, [['1', 'Alice']]);
  });

  test('dispatches .json to parseJsonRows', function () {
    const { headers } = parseFlatFile('data.json', '[{"id":1}]');
    assert.deepStrictEqual(headers, ['id']);
  });
});

suite('flat-file-parser – inferColumnType()', function () {
  test('infers INTEGER for small whole numbers', function () {
    assert.strictEqual(inferColumnType(['1', '2', '-3']), 'INTEGER');
  });

  test('infers BIGINT when a value overflows a 32-bit INTEGER', function () {
    assert.strictEqual(inferColumnType(['1', '9999999999']), 'BIGINT');
  });

  test('infers NUMERIC(precision,scale) for decimals', function () {
    assert.strictEqual(inferColumnType(['1.5', '12.34']), 'NUMERIC(4,2)');
  });

  test('infers BOOLEAN for true/false values', function () {
    assert.strictEqual(inferColumnType(['true', 'false', 'TRUE']), 'BOOLEAN');
  });

  test('infers DATE for yyyy-mm-dd values', function () {
    assert.strictEqual(inferColumnType(['2024-01-15', '2024-02-01']), 'DATE');
  });

  test('infers TIMESTAMP for date+time values', function () {
    assert.strictEqual(inferColumnType(['2024-01-15 10:30:00', '2024-02-01T00:00:00']), 'TIMESTAMP');
  });

  test('falls back to VARCHAR(n) for free text, sized off the longest sample', function () {
    assert.strictEqual(inferColumnType(['hi', 'hello there']), 'VARCHAR(14)');
  });

  test('a mixed column (not all values matching one type) falls back to VARCHAR', function () {
    assert.strictEqual(inferColumnType(['1', 'not a number']), 'VARCHAR(15)');
  });

  test('defaults to VARCHAR(255) when every sample is empty', function () {
    assert.strictEqual(inferColumnType(['', '']), 'VARCHAR(255)');
  });

  test('ignores empty values when sniffing amongst otherwise-typed values', function () {
    assert.strictEqual(inferColumnType(['1', '', '2']), 'INTEGER');
  });
});

suite('flat-file-parser – sanitizeIdentifier()', function () {
  test('uppercases the name', function () {
    assert.strictEqual(sanitizeIdentifier('customer_id'), 'CUSTOMER_ID');
  });

  test('replaces invalid characters with underscores', function () {
    assert.strictEqual(sanitizeIdentifier('First Name!'), 'FIRST_NAME_');
  });

  test('prefixes a name that starts with a digit', function () {
    assert.strictEqual(sanitizeIdentifier('2024_total'), 'COL_2024_TOTAL');
  });

  test('truncates to the Firebird 3.0-safe 31-character limit', function () {
    const id = sanitizeIdentifier('a_very_long_column_name_that_exceeds_the_limit');
    assert.ok(id.length <= 31, `expected length <= 31, got ${id.length}`);
  });

  test('replaces every character of a non-alphanumeric name with underscores rather than going empty', function () {
    assert.strictEqual(sanitizeIdentifier('???'), '___');
  });

  test('prefixes an empty name (e.g. a blank CSV header) so it never sanitizes to nothing', function () {
    assert.strictEqual(sanitizeIdentifier(''), 'COL_');
  });
});

suite('flat-file-parser – inferSchema()', function () {
  test('infers one column per header, with sniffed type and nullability', function () {
    const headers = ['id', 'name', 'notes'];
    const rows = [
      ['1', 'Alice', ''],
      ['2', 'Bob', 'likes SQL'],
    ];
    const schema = inferSchema(headers, rows);
    assert.strictEqual(schema.length, 3);
    assert.deepStrictEqual(schema[0], { name: 'ID', sqlType: 'INTEGER', nullable: false });
    assert.strictEqual(schema[1].name, 'NAME');
    assert.strictEqual(schema[2].nullable, true, 'notes has an empty value in one row');
  });

  test('disambiguates two headers that sanitize to the same identifier', function () {
    const schema = inferSchema(['ID', 'id'], [['1', '2']]);
    assert.strictEqual(schema[0].name, 'ID');
    assert.notStrictEqual(schema[1].name, 'ID', 'the second column must not collide with the first');
  });

  test('only samples the first sampleSize rows', function () {
    const rows = [['1'], ['2'], ['not-a-number']];
    const schema = inferSchema(['n'], rows, 2);
    assert.strictEqual(schema[0].sqlType, 'INTEGER', 'the 3rd row should be outside the 2-row sample');
  });
});

suite('flat-file-parser – buildCreateTableDDL()', function () {
  test('builds a CREATE TABLE with one line per column', function () {
    const ddl = buildCreateTableDDL('CUSTOMERS', [
      { name: 'ID', sqlType: 'INTEGER', nullable: false },
      { name: 'NAME', sqlType: 'VARCHAR(50)', nullable: true },
    ]);
    assert.strictEqual(ddl, 'CREATE TABLE CUSTOMERS (\n  ID INTEGER NOT NULL,\n  NAME VARCHAR(50)\n);');
  });
});

suite('flat-file-parser – cellToSqlLiteral()', function () {
  test('emits NULL for an empty cell', function () {
    assert.strictEqual(cellToSqlLiteral('', 'VARCHAR(50)'), 'NULL');
  });

  test('emits an unquoted numeric literal for INTEGER/BIGINT/NUMERIC columns', function () {
    assert.strictEqual(cellToSqlLiteral('42', 'INTEGER'), '42');
    assert.strictEqual(cellToSqlLiteral('9999999999', 'BIGINT'), '9999999999');
    assert.strictEqual(cellToSqlLiteral('12.34', 'NUMERIC(4,2)'), '12.34');
  });

  test('emits an unquoted true/false literal for BOOLEAN columns', function () {
    assert.strictEqual(cellToSqlLiteral('true', 'BOOLEAN'), 'true');
    assert.strictEqual(cellToSqlLiteral('False', 'BOOLEAN'), 'false');
  });

  test('emits a quoted, escaped string literal for VARCHAR/DATE/TIMESTAMP columns', function () {
    assert.strictEqual(cellToSqlLiteral("O'Brien", 'VARCHAR(50)'), "'O''Brien'");
    assert.strictEqual(cellToSqlLiteral('2024-01-15', 'DATE'), "'2024-01-15'");
  });

  test('falls back to a quoted string literal for a value that does not match its column type', function () {
    // e.g. a row outside inferSchema()'s sample window that turns out not to be numeric after all
    assert.strictEqual(cellToSqlLiteral('N/A', 'INTEGER'), "'N/A'");
  });
});

suite('flat-file-parser – buildInsertStatement()', function () {
  test('builds one INSERT with a literal per column, in column order', function () {
    const columns = [
      { name: 'ID', sqlType: 'INTEGER', nullable: false },
      { name: 'NAME', sqlType: 'VARCHAR(50)', nullable: true },
      { name: 'ACTIVE', sqlType: 'BOOLEAN', nullable: false },
    ];
    const sql = buildInsertStatement('CUSTOMERS', columns, ['1', "O'Brien", 'true']);
    assert.strictEqual(sql, "INSERT INTO CUSTOMERS (ID, NAME, ACTIVE) VALUES (1, 'O''Brien', true);");
  });

  test('emits NULL for a missing trailing cell', function () {
    const columns = [
      { name: 'ID', sqlType: 'INTEGER', nullable: false },
      { name: 'NOTES', sqlType: 'VARCHAR(50)', nullable: true },
    ];
    const sql = buildInsertStatement('T', columns, ['1']);
    assert.strictEqual(sql, 'INSERT INTO T (ID, NOTES) VALUES (1, NULL);');
  });
});

// ── "Map onto an existing table" mode (phase 3) ──────────────────────────────

suite('flat-file-parser – mapFirebirdFieldToSqlType()', function () {
  test('maps SMALLINT/INTEGER/INT64 to INTEGER/BIGINT', function () {
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'SMALLINT' })), 'INTEGER');
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'INTEGER' })), 'INTEGER');
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'INT64' })), 'BIGINT');
  });

  test('maps a NUMERIC/DECIMAL-backed INTEGER/INT64 (subtype 1/2, negative scale) to NUMERIC(p,s)', function () {
    assert.strictEqual(
      mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'PRICE', FIELD_TYPE: 'INTEGER', FIELD_SUB_TYPE: 1, FIELD_PRECISION: 9, FIELD_SCALE: -2 })),
      'NUMERIC(9,2)'
    );
    assert.strictEqual(
      mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'TOTAL', FIELD_TYPE: 'INT64', FIELD_SUB_TYPE: 2, FIELD_PRECISION: 18, FIELD_SCALE: -4 })),
      'NUMERIC(18,4)'
    );
  });

  test('does not treat a plain (subtype 0) INTEGER/INT64 as NUMERIC even with a stray scale', function () {
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'INTEGER', FIELD_SUB_TYPE: 0, FIELD_SCALE: -2 })), 'INTEGER');
  });

  test('maps DOUBLE/FLOAT/D_FLOAT to DOUBLE PRECISION', function () {
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'DOUBLE' })), 'DOUBLE PRECISION');
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'FLOAT' })), 'DOUBLE PRECISION');
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'D_FLOAT' })), 'DOUBLE PRECISION');
  });

  test('maps BOOLEAN/DATE/TIMESTAMP straight through', function () {
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'BOOLEAN' })), 'BOOLEAN');
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'DATE' })), 'DATE');
    assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: 'TIMESTAMP' })), 'TIMESTAMP');
  });

  test('falls back to VARCHAR for TIME/CHAR/VARCHAR/CSTRING/BLOB/UNKNOWN', function () {
    for (const t of ['TIME', 'CHAR', 'VARCHAR', 'CSTRING', 'BLOB', 'QUAD', 'UNKNOWN']) {
      assert.strictEqual(mapFirebirdFieldToSqlType(field({ FIELD_NAME: 'A', FIELD_TYPE: t })), 'VARCHAR');
    }
  });

  test('trims a space-padded FIELD_TYPE (regression: Firebird pads every CASE branch shorter than the longest, "TIMESTAMP", to 9 chars) — verified against a real server', function () {
    assert.strictEqual(mapFirebirdFieldToSqlType({ FIELD_NAME: 'A', FIELD_TYPE: 'INTEGER  ', FIELD_SUB_TYPE: null, FIELD_PRECISION: null, FIELD_SCALE: null }), 'INTEGER');
    assert.strictEqual(mapFirebirdFieldToSqlType({ FIELD_NAME: 'A', FIELD_TYPE: 'BOOLEAN  ', FIELD_SUB_TYPE: null, FIELD_PRECISION: null, FIELD_SCALE: null }), 'BOOLEAN');
    assert.strictEqual(mapFirebirdFieldToSqlType({ FIELD_NAME: 'A', FIELD_TYPE: 'DATE     ', FIELD_SUB_TYPE: null, FIELD_PRECISION: null, FIELD_SCALE: null }), 'DATE');
  });
});

suite('flat-file-parser – cellToSqlLiteral() for DOUBLE PRECISION', function () {
  test('emits an unquoted numeric literal', function () {
    assert.strictEqual(cellToSqlLiteral('3.14', 'DOUBLE PRECISION'), '3.14');
  });
});

suite('flat-file-parser – autoMapColumns()', function () {
  test('matches a target column to a same-named header (case-insensitive)', function () {
    const targets = [field({ FIELD_NAME: 'ID', FIELD_TYPE: 'INTEGER' }), field({ FIELD_NAME: 'NAME', FIELD_TYPE: 'VARCHAR' })];
    const mapping = autoMapColumns(['id', 'Name'], targets);
    assert.deepStrictEqual(mapping, [
      { targetColumn: 'ID', sqlType: 'INTEGER', sourceIndex: 0 },
      { targetColumn: 'NAME', sqlType: 'VARCHAR', sourceIndex: 1 },
    ]);
  });

  test('leaves a target column unmapped (sourceIndex: null) when no header matches', function () {
    const targets = [field({ FIELD_NAME: 'CREATED_AT', FIELD_TYPE: 'TIMESTAMP' })];
    const mapping = autoMapColumns(['id', 'name'], targets);
    assert.strictEqual(mapping[0].sourceIndex, null);
  });

  test('each header is used for at most one target column', function () {
    // Two target columns that both sanitize to "ID" -- only the first should claim the header.
    const targets = [field({ FIELD_NAME: 'ID', FIELD_TYPE: 'INTEGER' }), field({ FIELD_NAME: 'id', FIELD_TYPE: 'INTEGER' })];
    const mapping = autoMapColumns(['id'], targets);
    assert.strictEqual(mapping[0].sourceIndex, 0);
    assert.strictEqual(mapping[1].sourceIndex, null);
  });

  test('matches a header that needs sanitizing (spaces/punctuation) against a plain column name', function () {
    const targets = [field({ FIELD_NAME: 'EMAIL_ADDRESS', FIELD_TYPE: 'VARCHAR' })];
    const mapping = autoMapColumns(['Email Address'], targets);
    assert.strictEqual(mapping[0].sourceIndex, 0);
  });
});

suite('flat-file-parser – buildInsertStatementForMapping()', function () {
  test('builds an INSERT using only mapped columns, in mapping order', function () {
    const mapping = [
      { targetColumn: 'ID', sqlType: 'INTEGER', sourceIndex: 0 },
      { targetColumn: 'NAME', sqlType: 'VARCHAR', sourceIndex: 1 },
    ];
    const sql = buildInsertStatementForMapping('CUSTOMERS', mapping, ['1', "O'Brien"]);
    assert.strictEqual(sql, "INSERT INTO CUSTOMERS (ID, NAME) VALUES (1, 'O''Brien');");
  });

  test('omits an unmapped target column entirely rather than forcing NULL', function () {
    const mapping = [
      { targetColumn: 'ID', sqlType: 'INTEGER', sourceIndex: 0 },
      { targetColumn: 'CREATED_AT', sqlType: 'TIMESTAMP', sourceIndex: null },
    ];
    const sql = buildInsertStatementForMapping('T', mapping, ['1']);
    assert.strictEqual(sql, 'INSERT INTO T (ID) VALUES (1);');
  });

  test('pulls values from the mapped source index, not positionally', function () {
    // Mapping order is ID, NAME but ID's source is row[1] and NAME's source is row[0] -- makes
    // sure buildInsertStatementForMapping() really uses sourceIndex, not array position.
    const mapping = [
      { targetColumn: 'ID', sqlType: 'INTEGER', sourceIndex: 1 },
      { targetColumn: 'NAME', sqlType: 'VARCHAR', sourceIndex: 0 },
    ];
    const sql = buildInsertStatementForMapping('T', mapping, ['Alice', '7']);
    assert.strictEqual(sql, "INSERT INTO T (ID, NAME) VALUES (7, 'Alice');");
  });
});

// ── File-reading helpers (large-file streaming path) — real temp files on disk ─────────────────
// (docs/roadmap/flat-file-import-wizard.md's "Large-file streaming" item), same real-file-on-disk
// testing convention src/test/workspace-config.test.ts's loadWorkspaceConnections() suite uses.

suite('flat-file-parser – detectDelimiterFromFile()', function () {
  let tmpDir: string;

  setup(function () { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-file-parser-test-')); });
  teardown(function () { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('sniffs the delimiter from a real file\'s first line without reading the rest', function () {
    const filePath = path.join(tmpDir, 'data.csv');
    fs.writeFileSync(filePath, 'a;b;c\n1;2;3\n');
    return detectDelimiterFromFile(filePath).then(delimiter => assert.strictEqual(delimiter, ';'));
  });

  test('defaults to comma for a file with no delimiter on its first line', function () {
    const filePath = path.join(tmpDir, 'data.csv');
    fs.writeFileSync(filePath, 'onlyoneword\n1\n');
    return detectDelimiterFromFile(filePath).then(delimiter => assert.strictEqual(delimiter, ','));
  });
});

suite('flat-file-parser – readDelimitedPreview()', function () {
  let tmpDir: string;

  setup(function () { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-file-parser-test-')); });
  teardown(function () { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('truncated is false when the file has fewer rows than the cap — the preview already has everything', async function () {
    const filePath = path.join(tmpDir, 'small.csv');
    fs.writeFileSync(filePath, 'id,name\n1,Alice\n2,Bob\n');
    const { headers, rows, truncated } = await readDelimitedPreview(filePath, ',', 200);
    assert.deepStrictEqual(headers, ['id', 'name']);
    assert.deepStrictEqual(rows, [['1', 'Alice'], ['2', 'Bob']]);
    assert.strictEqual(truncated, false);
  });

  test('truncated is true and stops reading once the cap is hit, on a file with more rows than the cap', async function () {
    const lines = ['id,name', ...Array.from({ length: 10 }, (_, i) => `${i},name${i}`)];
    const filePath = path.join(tmpDir, 'big.csv');
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const { rows, truncated } = await readDelimitedPreview(filePath, ',', 5);
    assert.strictEqual(rows.length, 5);
    assert.deepStrictEqual(rows.map(r => r[0]), ['0', '1', '2', '3', '4']);
    assert.strictEqual(truncated, true);
  });

  test('truncated is false when the file has exactly the cap\'s worth of rows', async function () {
    const lines = ['id', '1', '2', '3'];
    const filePath = path.join(tmpDir, 'exact.csv');
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const { rows, truncated } = await readDelimitedPreview(filePath, ',', 3);
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(truncated, false);
  });
});

suite('flat-file-parser – streamDataRows()', function () {
  let tmpDir: string;

  setup(function () { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-file-parser-test-')); });
  teardown(function () { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('skips the header row and yields every real data row from a real file on disk', async function () {
    const filePath = path.join(tmpDir, 'data.csv');
    fs.writeFileSync(filePath, 'id,name\n1,Alice\n2,Bob\n3,Carol\n');
    const rows: string[][] = [];
    for await (const row of streamDataRows(filePath, ',')) { rows.push(row); }
    assert.deepStrictEqual(rows, [['1', 'Alice'], ['2', 'Bob'], ['3', 'Carol']]);
  });

  test('walks a real file with more rows than any preview cap, in order, none lost or duplicated', async function () {
    const rowCount = 3000; // comfortably beyond PREVIEW_ROW_CAP (200) and past a real fs stream's default chunk size
    const lines = ['id,note', ...Array.from({ length: rowCount }, (_, i) => `${i},row number ${i}`)];
    const filePath = path.join(tmpDir, 'large.csv');
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const ids: number[] = [];
    for await (const row of streamDataRows(filePath, ',')) { ids.push(Number(row[0])); }
    assert.strictEqual(ids.length, rowCount);
    assert.deepStrictEqual(ids, Array.from({ length: rowCount }, (_, i) => i));
  });

  test('correctly parses a quoted field with an embedded newline/delimiter in a real streamed file large enough to span multiple internal read chunks', async function () {
    const padding = Array.from({ length: 2000 }, (_, i) => `${i},plain value ${i}`).join('\n');
    const quotedRow = `9999,"a value, with a comma\nand a newline too"`;
    const filePath = path.join(tmpDir, 'quoted.csv');
    fs.writeFileSync(filePath, `id,note\n${padding}\n${quotedRow}\n10000,after\n`);

    const rows: string[][] = [];
    for await (const row of streamDataRows(filePath, ',')) { rows.push(row); }
    const quoted = rows.find(r => r[0] === '9999');
    assert.ok(quoted, 'the quoted row was found among the streamed results');
    assert.strictEqual(quoted![1], 'a value, with a comma\nand a newline too');
    assert.strictEqual(rows[rows.length - 1][0], '10000', 'the row after the quoted one still parsed correctly');
  });
});
