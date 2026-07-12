import * as assert from 'assert';
import {
  dockerRunArgs, parseContainerId, resolveImageReference, resolveDatabasePath, suggestContainerName,
  ProvisionContainerOptions,
} from '../container-provisioning/docker-run';

function baseOptions(overrides: Partial<ProvisionContainerOptions> = {}): ProvisionContainerOptions {
  return {
    containerName: 'firebird-test',
    image: '5.0',
    hostPort: 3050,
    sysdbaPassword: 'masterkey',
    databaseName: 'test.fdb',
    ...overrides,
  };
}

suite('docker-run – resolveImageReference()', function () {
  test('prefixes a bare tag with firebirdsql/firebird:', function () {
    assert.strictEqual(resolveImageReference('5.0'), 'firebirdsql/firebird:5.0');
  });

  test('uses a custom image reference as-is when it contains a "/"', function () {
    assert.strictEqual(resolveImageReference('myrepo/firebird:custom'), 'myrepo/firebird:custom');
  });
});

suite('docker-run – dockerRunArgs()', function () {
  test('builds a detached run with the container name, port mapping, and image', function () {
    const args = dockerRunArgs(baseOptions());
    assert.deepStrictEqual(args.slice(0, 6), ['run', '-d', '--name', 'firebird-test', '-p', '3050:3050']);
    assert.strictEqual(args[args.length - 1], 'firebirdsql/firebird:5.0');
  });

  test('sets FIREBIRD_ROOT_PASSWORD and FIREBIRD_DATABASE', function () {
    const args = dockerRunArgs(baseOptions({ sysdbaPassword: 'secret123', databaseName: 'mydb.fdb' }));
    assert.ok(args.includes('FIREBIRD_ROOT_PASSWORD=secret123'));
    assert.ok(args.includes('FIREBIRD_DATABASE=mydb.fdb'));
  });

  test('omits FIREBIRD_USE_LEGACY_AUTH by default', function () {
    const args = dockerRunArgs(baseOptions());
    assert.ok(!args.some(a => a.startsWith('FIREBIRD_USE_LEGACY_AUTH')));
  });

  test('sets FIREBIRD_USE_LEGACY_AUTH=true when requested', function () {
    const args = dockerRunArgs(baseOptions({ useLegacyAuth: true }));
    assert.ok(args.includes('FIREBIRD_USE_LEGACY_AUTH=true'));
  });

  test('omits a volume mount when no volumeName is given', function () {
    const args = dockerRunArgs(baseOptions());
    assert.ok(!args.includes('-v'));
  });

  test('mounts a named volume at /var/lib/firebird/data when volumeName is given', function () {
    const args = dockerRunArgs(baseOptions({ volumeName: 'firebird-data' }));
    const vIndex = args.indexOf('-v');
    assert.ok(vIndex >= 0);
    assert.strictEqual(args[vIndex + 1], 'firebird-data:/var/lib/firebird/data');
  });

  test('respects a custom host port', function () {
    const args = dockerRunArgs(baseOptions({ hostPort: 33050 }));
    assert.ok(args.includes('33050:3050'));
  });
});

suite('docker-run – parseContainerId()', function () {
  test('trims the trailing newline from docker run -d\'s output', function () {
    assert.strictEqual(parseContainerId('abcdef1234567890\n'), 'abcdef1234567890');
  });

  test('takes the last non-empty line, in case Docker prints anything else first', function () {
    assert.strictEqual(parseContainerId('Unable to find image locally\nabcdef1234567890\n'), 'abcdef1234567890');
  });
});

suite('docker-run – resolveDatabasePath()', function () {
  test('prefixes a bare filename with the image\'s default data directory', function () {
    assert.strictEqual(resolveDatabasePath('test.fdb'), '/var/lib/firebird/data/test.fdb');
  });

  test('leaves an absolute path unchanged', function () {
    assert.strictEqual(resolveDatabasePath('/custom/path/test.fdb'), '/custom/path/test.fdb');
  });
});

suite('docker-run – suggestContainerName()', function () {
  test('is prefixed with "firebird-" and non-empty', function () {
    const name = suggestContainerName();
    assert.ok(name.startsWith('firebird-'));
    assert.ok(name.length > 'firebird-'.length);
  });

  test('generates a different name each call (not a fixed constant)', function () {
    const names = new Set(Array.from({ length: 5 }, () => suggestContainerName()));
    assert.ok(names.size > 1, 'expected at least some variation across calls');
  });
});
