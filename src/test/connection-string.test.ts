import * as assert from 'assert';
import { parseConnectionString } from '../shared/connection-string';

suite('connection-string – parseConnectionString()', function () {
  test('parses host/port/database/user/password', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee');
    assert.deepStrictEqual(parsed, {
      host: 'localhost',
      database: 'employee',
      embedded: false,
      port: 3050,
      user: 'sysdba',
      password: 'masterkey',
    });
  });

  test('parses an absolute database path given with the doubled-slash convention', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050//var/lib/firebird/data/test.fdb');
    assert.strictEqual(parsed?.database, '/var/lib/firebird/data/test.fdb');
  });

  test('restores a missing leading slash when a single-slash path still looks absolute', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/var/lib/firebird/data/test.fdb');
    assert.strictEqual(parsed?.database, '/var/lib/firebird/data/test.fdb');
  });

  test('treats a single path segment with no further slashes as a bare alias', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee');
    assert.strictEqual(parsed?.database, 'employee');
  });

  test('defaults port/user/password to undefined when omitted, for the caller to fill in', function () {
    const parsed = parseConnectionString('firebird://localhost/employee');
    assert.strictEqual(parsed?.port, undefined);
    assert.strictEqual(parsed?.user, undefined);
    assert.strictEqual(parsed?.password, undefined);
    assert.strictEqual(parsed?.host, 'localhost');
  });

  test('parses a role query parameter', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee?role=READER');
    assert.strictEqual(parsed?.role, 'READER');
  });

  test('parses a valid wireCrypt query parameter', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee?wireCrypt=Disabled');
    assert.strictEqual(parsed?.wireCrypt, 'Disabled');
  });

  test('ignores an invalid wireCrypt value rather than passing it through', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee?wireCrypt=Nonsense');
    assert.strictEqual(parsed?.wireCrypt, undefined);
  });

  test('URL-decodes a password containing special characters', function () {
    const parsed = parseConnectionString('firebird://sysdba:p%40ss%3Aword@localhost:3050/employee');
    assert.strictEqual(parsed?.password, 'p@ss:word');
  });

  test('returns undefined for an empty or whitespace-only string', function () {
    assert.strictEqual(parseConnectionString(''), undefined);
    assert.strictEqual(parseConnectionString('   '), undefined);
  });

  test('returns undefined for a non-URL string', function () {
    assert.strictEqual(parseConnectionString('not a connection string'), undefined);
  });

  test('returns undefined for a URL with the wrong scheme', function () {
    assert.strictEqual(parseConnectionString('postgres://user:pass@localhost:5432/db'), undefined);
  });

  test('returns undefined when there is no database path at all', function () {
    assert.strictEqual(parseConnectionString('firebird://sysdba:masterkey@localhost:3050'), undefined);
  });
});
