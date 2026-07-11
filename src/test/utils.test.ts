import * as assert from 'assert';
import { getDatabaseFileName, getConnectionLabel } from '../shared/utils';
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
