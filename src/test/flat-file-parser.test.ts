import * as assert from 'assert';
import {
  detectFormat, detectDelimiter, parseDelimited, parseCsv, parseJsonRows, parseFlatFile,
  inferColumnType, sanitizeIdentifier, inferSchema, buildCreateTableDDL,
  cellToSqlLiteral, buildInsertStatement,
} from '../shared/flat-file-parser';

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
