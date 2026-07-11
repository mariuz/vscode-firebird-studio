import * as assert from 'assert';
import {
  buildIsqlTarget,
  buildIsqlArgs,
  buildIsqlEnv,
  isqlCandidates,
  resolveIsqlExecutable,
} from '../shared/isql-terminal';
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

suite('buildIsqlTarget', function () {

  test('formats a TCP connection as host/port:database', function () {
    assert.strictEqual(buildIsqlTarget(baseConnection()), 'localhost/3050:/data/test.fdb');
  });

  test('defaults to port 3050 when unset', function () {
    const target = buildIsqlTarget(baseConnection({ port: undefined }));
    assert.strictEqual(target, 'localhost/3050:/data/test.fdb');
  });

  test('uses a custom port', function () {
    const target = buildIsqlTarget(baseConnection({ host: 'db.example.com', port: 3051 }));
    assert.strictEqual(target, 'db.example.com/3051:/data/test.fdb');
  });

  test('an embedded connection is just the database path, no host/port prefix', function () {
    const target = buildIsqlTarget(baseConnection({ embedded: true, database: '/local/embedded.fdb' }));
    assert.strictEqual(target, '/local/embedded.fdb');
  });
});

suite('buildIsqlArgs', function () {

  test('with no role, the target is the only argument', function () {
    assert.deepStrictEqual(buildIsqlArgs(baseConnection()), ['localhost/3050:/data/test.fdb']);
  });

  test('includes -role before the target when a role is set', function () {
    const args = buildIsqlArgs(baseConnection({ role: 'READER' }));
    assert.deepStrictEqual(args, ['-role', 'READER', 'localhost/3050:/data/test.fdb']);
  });

  test('prepends extraArgs (e.g. -i <file>) ahead of -role and the target', function () {
    const args = buildIsqlArgs(baseConnection({ role: 'READER' }), ['-i', '/path/script.sql']);
    assert.deepStrictEqual(args, ['-i', '/path/script.sql', '-role', 'READER', 'localhost/3050:/data/test.fdb']);
  });

  test('extraArgs work without a role too', function () {
    const args = buildIsqlArgs(baseConnection(), ['-i', '/path/script.sql']);
    assert.deepStrictEqual(args, ['-i', '/path/script.sql', 'localhost/3050:/data/test.fdb']);
  });

  test('never includes -user, -password, or the raw password anywhere in the argument list', function () {
    const args = buildIsqlArgs(baseConnection({ password: 'super-secret-value', role: 'READER' }), ['-i', 'f.sql']);
    assert.ok(!args.includes('-user'));
    assert.ok(!args.includes('-password'));
    assert.ok(!args.some(a => a.includes('super-secret-value')));
  });
});

suite('buildIsqlEnv', function () {

  test('maps user/password to ISC_USER/ISC_PASSWORD', function () {
    const env = buildIsqlEnv(baseConnection({ user: 'sysdba', password: 'masterkey' }));
    assert.deepStrictEqual(env, { ISC_USER: 'sysdba', ISC_PASSWORD: 'masterkey' });
  });

  test('defaults ISC_PASSWORD to an empty string when the password is missing', function () {
    const env = buildIsqlEnv(baseConnection({ password: undefined }));
    assert.strictEqual(env.ISC_PASSWORD, '');
  });
});

suite('isqlCandidates', function () {

  test('on Windows, tries isql.exe before isql-fb.exe', function () {
    assert.deepStrictEqual(isqlCandidates('win32'), ['isql.exe', 'isql-fb.exe']);
  });

  test('on Linux/macOS, tries isql-fb before isql (avoids unixODBC\'s isql on many distros)', function () {
    assert.deepStrictEqual(isqlCandidates('linux'), ['isql-fb', 'isql']);
    assert.deepStrictEqual(isqlCandidates('darwin'), ['isql-fb', 'isql']);
  });
});

suite('resolveIsqlExecutable', function () {

  test('a working custom path is used as-is', async function () {
    const result = await resolveIsqlExecutable('/opt/firebird/bin/isql', async () => true, 'linux');
    assert.strictEqual(result, '/opt/firebird/bin/isql');
  });

  test('a custom path that fails its check returns undefined without falling back to PATH candidates', async function () {
    const calls: string[] = [];
    const result = await resolveIsqlExecutable(
      '/bad/path/isql',
      async candidate => { calls.push(candidate); return false; },
      'linux'
    );
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(calls, ['/bad/path/isql'], 'should not have tried PATH candidates after a custom path was given');
  });

  test('with no custom path, returns the first candidate that resolves', async function () {
    const result = await resolveIsqlExecutable(undefined, async candidate => candidate === 'isql-fb', 'linux');
    assert.strictEqual(result, 'isql-fb');
  });

  test('with no custom path, falls back to the second candidate if the first is unavailable', async function () {
    const calls: string[] = [];
    const result = await resolveIsqlExecutable(
      undefined,
      async candidate => { calls.push(candidate); return candidate === 'isql'; },
      'linux'
    );
    assert.strictEqual(result, 'isql');
    assert.deepStrictEqual(calls, ['isql-fb', 'isql'], 'should try isql-fb before isql');
  });

  test('returns undefined when no candidate resolves', async function () {
    const result = await resolveIsqlExecutable(undefined, async () => false, 'linux');
    assert.strictEqual(result, undefined);
  });

  test('an empty-string custom path is treated as "no custom path" (falls back to PATH search)', async function () {
    const result = await resolveIsqlExecutable('', async candidate => candidate === 'isql-fb', 'linux');
    assert.strictEqual(result, 'isql-fb');
  });
});
