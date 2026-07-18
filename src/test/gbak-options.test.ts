import * as assert from 'assert';
import { buildBackupFlags, gbakCandidates, resolveGbakExecutable } from '../shared/gbak-options';

suite('gbak-options – buildBackupFlags() (docs/roadmap/backup-restore-options.md, phase 1)', function () {
  test('no choices at all produces no flags — matches gbak\'s own defaults exactly', function () {
    assert.deepStrictEqual(buildBackupFlags({}), []);
  });

  test('every choice explicitly false also produces no flags', function () {
    assert.deepStrictEqual(buildBackupFlags({
      skipGarbageCollection: false, compress: false, metadataOnly: false, nonTransportable: false,
    }), []);
  });

  test('skipGarbageCollection maps to -G', function () {
    assert.deepStrictEqual(buildBackupFlags({ skipGarbageCollection: true }), ['-G']);
  });

  test('compress maps to -ZIP', function () {
    assert.deepStrictEqual(buildBackupFlags({ compress: true }), ['-ZIP']);
  });

  test('metadataOnly maps to -M', function () {
    assert.deepStrictEqual(buildBackupFlags({ metadataOnly: true }), ['-M']);
  });

  test('nonTransportable maps to -NT', function () {
    assert.deepStrictEqual(buildBackupFlags({ nonTransportable: true }), ['-NT']);
  });

  test('multiple choices combine, in the field-declaration order', function () {
    assert.deepStrictEqual(
      buildBackupFlags({ nonTransportable: true, skipGarbageCollection: true, compress: true, metadataOnly: true }),
      ['-G', '-ZIP', '-M', '-NT']
    );
  });
});

suite('gbak-options – gbakCandidates()', function () {
  test('on Windows, tries gbak.exe', function () {
    assert.deepStrictEqual(gbakCandidates('win32'), ['gbak.exe']);
  });

  test('on Linux/macOS, tries plain gbak', function () {
    assert.deepStrictEqual(gbakCandidates('linux'), ['gbak']);
    assert.deepStrictEqual(gbakCandidates('darwin'), ['gbak']);
  });
});

suite('gbak-options – resolveGbakExecutable()', function () {
  test('a working custom path is used as-is', async function () {
    const result = await resolveGbakExecutable('/opt/firebird/bin/gbak', async () => true, 'linux');
    assert.strictEqual(result, '/opt/firebird/bin/gbak');
  });

  test('a custom path that fails its check returns undefined without falling back to PATH candidates', async function () {
    const calls: string[] = [];
    const result = await resolveGbakExecutable(
      '/bad/path/gbak',
      async candidate => { calls.push(candidate); return false; },
      'linux'
    );
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(calls, ['/bad/path/gbak']);
  });

  test('with no custom path, returns gbak when it resolves on PATH', async function () {
    const result = await resolveGbakExecutable(undefined, async candidate => candidate === 'gbak', 'linux');
    assert.strictEqual(result, 'gbak');
  });

  test('returns undefined when no candidate resolves', async function () {
    const result = await resolveGbakExecutable(undefined, async () => false, 'linux');
    assert.strictEqual(result, undefined);
  });

  test('an empty-string custom path is treated as "no custom path" (falls back to PATH search)', async function () {
    const result = await resolveGbakExecutable('', async candidate => candidate === 'gbak', 'linux');
    assert.strictEqual(result, 'gbak');
  });
});
