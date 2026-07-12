import * as assert from 'assert';
import {
  extractNamedParameters,
  rewriteNamedParametersToPositional,
  coerceParamValue,
} from '../shared/parameterized-query';

suite('extractNamedParameters', function () {
  test('finds a single named parameter', function () {
    assert.deepStrictEqual(extractNamedParameters('SELECT * FROM CUSTOMERS WHERE ID = :customerId'), ['customerId']);
  });

  test('finds multiple distinct named parameters in order', function () {
    const sql = 'SELECT * FROM ORDERS WHERE CUSTOMER_ID = :customerId AND STATUS = :status';
    assert.deepStrictEqual(extractNamedParameters(sql), ['customerId', 'status']);
  });

  test('deduplicates a parameter used more than once', function () {
    const sql = 'SELECT * FROM T WHERE A = :x OR B = :x';
    assert.deepStrictEqual(extractNamedParameters(sql), ['x']);
  });

  test('returns an empty array when there are no named parameters', function () {
    assert.deepStrictEqual(extractNamedParameters('SELECT * FROM CUSTOMERS'), []);
  });

  test('ignores a colon inside a single-quoted string literal', function () {
    assert.deepStrictEqual(extractNamedParameters("SELECT * FROM T WHERE TIME_COL = '12:30 PM'"), []);
  });

  test('ignores a colon inside a line comment', function () {
    assert.deepStrictEqual(extractNamedParameters('SELECT 1 -- not a param :fake\nFROM RDB$DATABASE'), []);
  });

  test('ignores a colon inside a block comment', function () {
    assert.deepStrictEqual(extractNamedParameters('SELECT 1 /* :fake */ FROM RDB$DATABASE'), []);
  });

  test('does not treat a bare colon with no identifier after it as a parameter', function () {
    assert.deepStrictEqual(extractNamedParameters('SELECT 1 : 2'), []);
  });

  test('a real parameter after a string literal is still found', function () {
    const sql = "SELECT * FROM T WHERE NAME = 'Alice:Bob' AND ID = :id";
    assert.deepStrictEqual(extractNamedParameters(sql), ['id']);
  });
});

suite('rewriteNamedParametersToPositional', function () {
  test('replaces a single placeholder with ?', function () {
    const result = rewriteNamedParametersToPositional('SELECT * FROM T WHERE ID = :id');
    assert.strictEqual(result.sql, 'SELECT * FROM T WHERE ID = ?');
    assert.deepStrictEqual(result.paramNames, ['id']);
  });

  test('replaces multiple placeholders in source order', function () {
    const result = rewriteNamedParametersToPositional('SELECT * FROM T WHERE A = :x AND B = :y');
    assert.strictEqual(result.sql, 'SELECT * FROM T WHERE A = ? AND B = ?');
    assert.deepStrictEqual(result.paramNames, ['x', 'y']);
  });

  test('repeats a name in paramNames when the same placeholder is used twice', function () {
    const result = rewriteNamedParametersToPositional('SELECT * FROM T WHERE A = :x OR B = :x');
    assert.strictEqual(result.sql, 'SELECT * FROM T WHERE A = ? OR B = ?');
    assert.deepStrictEqual(result.paramNames, ['x', 'x']);
  });

  test('is a no-op when there are no placeholders', function () {
    const result = rewriteNamedParametersToPositional('SELECT * FROM T');
    assert.strictEqual(result.sql, 'SELECT * FROM T');
    assert.deepStrictEqual(result.paramNames, []);
  });

  test('leaves a colon inside a string literal untouched', function () {
    const result = rewriteNamedParametersToPositional("SELECT * FROM T WHERE TIME_COL = '12:30 PM' AND ID = :id");
    assert.strictEqual(result.sql, "SELECT * FROM T WHERE TIME_COL = '12:30 PM' AND ID = ?");
    assert.deepStrictEqual(result.paramNames, ['id']);
  });
});

suite('coerceParamValue', function () {
  test('null type always returns null, ignoring raw', function () {
    assert.strictEqual(coerceParamValue('null', 'anything'), null);
    assert.strictEqual(coerceParamValue('null', undefined), null);
  });

  test('string type returns the raw string as-is', function () {
    assert.strictEqual(coerceParamValue('string', 'hello'), 'hello');
  });

  test('string type treats undefined as an empty string', function () {
    assert.strictEqual(coerceParamValue('string', undefined), '');
  });

  test('integer type parses a valid integer', function () {
    assert.strictEqual(coerceParamValue('integer', '42'), 42);
  });

  test('integer type throws on an invalid integer', function () {
    assert.throws(() => coerceParamValue('integer', 'abc'), /not a valid integer/);
  });

  test('float type parses a valid decimal', function () {
    assert.strictEqual(coerceParamValue('float', '3.14'), 3.14);
  });

  test('float type throws on an invalid number', function () {
    assert.throws(() => coerceParamValue('float', 'abc'), /not a valid number/);
  });

  test('boolean type accepts "true" (case-insensitive)', function () {
    assert.strictEqual(coerceParamValue('boolean', 'True'), true);
  });

  test('boolean type accepts "1"', function () {
    assert.strictEqual(coerceParamValue('boolean', '1'), true);
  });

  test('boolean type treats anything else as false', function () {
    assert.strictEqual(coerceParamValue('boolean', 'no'), false);
  });

  test('date type parses a valid date string into a Date', function () {
    const d = coerceParamValue('date', '2026-07-13');
    assert.ok(d instanceof Date);
    assert.strictEqual(d.toISOString().slice(0, 10), '2026-07-13');
  });

  test('date type throws on an invalid date string', function () {
    assert.throws(() => coerceParamValue('date', 'not-a-date'), /not a valid date/);
  });
});
