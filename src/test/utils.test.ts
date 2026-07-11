import * as assert from 'assert';
import { getDatabaseFileName, getConnectionLabel, withTruncationWarning } from '../shared/utils';
import { MAX_SOURCE_CAST_LENGTH } from '../shared/queries';
import { ConnectionOptions } from '../interfaces';

function baseConnection(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    id: 'test',
    host: 'localhost',
    port: 3050,
    database: '/data/test.fdb',
    user: 'sysdba',
    password: 'masterkey',
    role: null,
    ...overrides,
  };
}

suite('getDatabaseFileName', function () {

  test('extracts the filename from a POSIX path', function () {
    assert.strictEqual(getDatabaseFileName('/var/lib/firebird/data/test.fdb'), 'test.fdb');
  });

  test('extracts the filename from a Windows path', function () {
    assert.strictEqual(getDatabaseFileName('C:\\Firebird\\data\\test.fdb'), 'test.fdb');
  });

  test('returns the input unchanged when there is no path separator', function () {
    assert.strictEqual(getDatabaseFileName('test.fdb'), 'test.fdb');
  });

  test('handles a mixed Windows/POSIX path (backslash split first, then forward slash)', function () {
    assert.strictEqual(getDatabaseFileName('C:\\data/nested\\test.fdb'), 'test.fdb');
  });

  test('returns an empty string for an empty path', function () {
    assert.strictEqual(getDatabaseFileName(''), '');
  });
});

suite('getConnectionLabel', function () {

  test('formats a non-embedded connection as host:filename', function () {
    const label = getConnectionLabel(baseConnection({ host: 'db.example.com', database: '/data/prod.fdb' }));
    assert.strictEqual(label, 'db.example.com:prod.fdb');
  });

  test('formats an embedded connection with an [embedded] prefix instead of a host', function () {
    const label = getConnectionLabel(baseConnection({ embedded: true, database: '/local/test.fdb' }));
    assert.strictEqual(label, '[embedded] test.fdb');
  });

  test('uses just the filename, not the full path', function () {
    const label = getConnectionLabel(baseConnection({ database: 'C:\\Firebird\\data\\test.fdb' }));
    assert.ok(!label.includes('\\'), `label should not contain the full path: ${label}`);
    assert.ok(label.endsWith('test.fdb'));
  });
});

// ── withTruncationWarning ─────────────────────────────────────────────────────
//
// Regression coverage for "SQL error code = -204, Data type unknown,
// Implementation limit exceeded, COLUMN" when editing a procedure/trigger/view:
// RDB$PROCEDURE_SOURCE etc. are fetched via CAST(... AS VARCHAR(n) CHARACTER SET
// UTF8) to sidestep node-firebird's async BLOB callback API, which caps how much
// source text can come back in one query. MAX_SOURCE_CAST_LENGTH must stay small
// enough to fit Firebird's 32767-byte column limit under UTF8 (up to 4
// bytes/char), and callers should warn rather than silently hand back a
// truncated ALTER statement.

suite('withTruncationWarning', function () {

  test('MAX_SOURCE_CAST_LENGTH fits within Firebird\'s 32767-byte column limit under UTF8 (4 bytes/char)', function () {
    // 2 bytes are reserved for the VARCHAR length prefix, leaving 32765 usable bytes.
    assert.ok(MAX_SOURCE_CAST_LENGTH * 4 <= 32765, `${MAX_SOURCE_CAST_LENGTH} chars * 4 bytes exceeds the VARCHAR byte limit`);
  });

  test('returns the text unchanged when the source is well under the limit', function () {
    const text = 'ALTER PROCEDURE P AS\nBEGIN\n  SUSPEND;\nEND';
    assert.strictEqual(withTruncationWarning('short source', text), text);
  });

  test('prepends a warning comment when the raw source reached the cast limit', function () {
    const rawSource = 'x'.repeat(MAX_SOURCE_CAST_LENGTH);
    const text = 'ALTER PROCEDURE P AS\n' + rawSource;
    const result = withTruncationWarning(rawSource, text);
    assert.ok(result.startsWith('/* WARNING'), `expected a warning comment, got: ${result.slice(0, 50)}`);
    assert.ok(result.includes(text), 'the original text should still be present');
  });

  test('does not warn one character below the limit', function () {
    const rawSource = 'x'.repeat(MAX_SOURCE_CAST_LENGTH - 1);
    const text = 'ALTER PROCEDURE P AS\n' + rawSource;
    assert.strictEqual(withTruncationWarning(rawSource, text), text);
  });
});
