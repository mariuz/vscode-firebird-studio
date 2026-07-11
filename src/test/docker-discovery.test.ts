/**
 * Docker container discovery for the "Add New Connection" wizard's Docker option — pure parsing
 * and filtering logic (no vscode/child_process dependency), matching the shared/isql-terminal.ts
 * testing pattern: the real `docker ps`/`docker inspect` spawning lives in
 * shared/connection-wizard.ts and is exercised end-to-end by the e2e suite instead.
 */

import * as assert from 'assert';
import {
  parseDockerPsOutput,
  extractHostPort,
  discoverFirebirdContainers,
  parseDockerInspectEnv,
  suggestDatabasePath,
  dockerCandidates,
  resolveDockerExecutable,
  dockerPsArgs,
  dockerInspectEnvArgs,
} from '../shared/docker-discovery';

suite('parseDockerPsOutput', function () {

  test('parses one JSON object per line', function () {
    const output = [
      '{"ID":"abc123","Names":"my-firebird","Image":"firebirdsql/firebird:5","Ports":"0.0.0.0:3050->3050/tcp","Status":"Up 2 hours"}',
      '{"ID":"def456","Names":"web","Image":"nginx:latest","Ports":"0.0.0.0:8080->80/tcp","Status":"Up 1 hour"}',
    ].join('\n');

    const containers = parseDockerPsOutput(output);

    assert.strictEqual(containers.length, 2);
    assert.deepStrictEqual(containers[0], {
      id: 'abc123', name: 'my-firebird', image: 'firebirdsql/firebird:5',
      ports: '0.0.0.0:3050->3050/tcp', status: 'Up 2 hours',
    });
  });

  test('skips blank lines', function () {
    const output = '\n{"ID":"abc","Names":"x","Image":"y","Ports":"","Status":""}\n\n';
    assert.strictEqual(parseDockerPsOutput(output).length, 1);
  });

  test('skips lines that are not valid JSON instead of throwing', function () {
    const output = [
      'WARNING: something printed to stdout',
      '{"ID":"abc","Names":"x","Image":"y","Ports":"","Status":""}',
    ].join('\n');

    const containers = parseDockerPsOutput(output);
    assert.strictEqual(containers.length, 1);
    assert.strictEqual(containers[0].id, 'abc');
  });

  test('skips JSON lines missing required fields (ID/Image)', function () {
    const output = '{"Names":"no-id-or-image"}';
    assert.strictEqual(parseDockerPsOutput(output).length, 0);
  });

  test('falls back to ID as name and empty strings for missing Ports/Status', function () {
    const output = '{"ID":"abc","Image":"firebirdsql/firebird:5"}';
    const [container] = parseDockerPsOutput(output);
    assert.strictEqual(container.name, 'abc');
    assert.strictEqual(container.ports, '');
    assert.strictEqual(container.status, '');
  });

  test('empty output yields no containers', function () {
    assert.deepStrictEqual(parseDockerPsOutput(''), []);
  });
});

suite('extractHostPort', function () {

  test('extracts a fixed host port (IPv4)', function () {
    assert.strictEqual(extractHostPort('0.0.0.0:3050->3050/tcp'), 3050);
  });

  test('extracts a random host port mapping', function () {
    assert.strictEqual(extractHostPort('0.0.0.0:32768->3050/tcp'), 32768);
  });

  test('extracts the host port from a combined IPv4+IPv6 mapping', function () {
    assert.strictEqual(extractHostPort('0.0.0.0:3050->3050/tcp, :::3050->3050/tcp'), 3050);
  });

  test('returns undefined when the container port is not published to the host', function () {
    assert.strictEqual(extractHostPort('3050/tcp'), undefined);
  });

  test('returns undefined when the published port is a different container port', function () {
    assert.strictEqual(extractHostPort('0.0.0.0:3050->22/tcp'), undefined);
  });

  test('returns undefined for empty Ports text', function () {
    assert.strictEqual(extractHostPort(''), undefined);
  });

  test('supports a custom container port', function () {
    assert.strictEqual(extractHostPort('0.0.0.0:15432->5432/tcp', 5432), 15432);
  });
});

suite('discoverFirebirdContainers', function () {

  test('keeps only containers publishing port 3050, regardless of image name', function () {
    const containers = parseDockerPsOutput([
      '{"ID":"a","Names":"fb","Image":"firebirdsql/firebird:5","Ports":"0.0.0.0:3050->3050/tcp","Status":"Up"}',
      '{"ID":"b","Names":"custom","Image":"myregistry/custom-fb:latest","Ports":"0.0.0.0:33050->3050/tcp","Status":"Up"}',
      '{"ID":"c","Names":"web","Image":"nginx","Ports":"0.0.0.0:8080->80/tcp","Status":"Up"}',
      '{"ID":"d","Names":"fb-internal-only","Image":"firebirdsql/firebird:5","Ports":"3050/tcp","Status":"Up"}',
    ].join('\n'));

    const discovered = discoverFirebirdContainers(containers);

    assert.strictEqual(discovered.length, 2);
    assert.deepStrictEqual(discovered.map(d => d.container.id), ['a', 'b']);
    assert.strictEqual(discovered[0].hostPort, 3050);
    assert.strictEqual(discovered[1].hostPort, 33050);
  });

  test('returns an empty array when nothing publishes 3050', function () {
    const containers = parseDockerPsOutput('{"ID":"a","Names":"web","Image":"nginx","Ports":"0.0.0.0:8080->80/tcp","Status":"Up"}');
    assert.deepStrictEqual(discoverFirebirdContainers(containers), []);
  });
});

suite('parseDockerInspectEnv / suggestDatabasePath', function () {

  test('parses KEY=VALUE lines into a map', function () {
    const output = [
      'PATH=/usr/local/bin:/usr/bin',
      'FIREBIRD_DATABASE=test.fdb',
      'ISC_USER=sysdba',
    ].join('\n');

    const env = parseDockerInspectEnv(output);
    assert.strictEqual(env.FIREBIRD_DATABASE, 'test.fdb');
    assert.strictEqual(env.ISC_USER, 'sysdba');
  });

  test('handles a value that itself contains an "=" (e.g. base64-ish secrets)', function () {
    const env = parseDockerInspectEnv('SOME_KEY=abc=def==');
    assert.strictEqual(env.SOME_KEY, 'abc=def==');
  });

  test('skips blank lines', function () {
    const env = parseDockerInspectEnv('\nFIREBIRD_DATABASE=test.fdb\n\n');
    assert.strictEqual(Object.keys(env).length, 1);
  });

  test('suggestDatabasePath prefixes a bare filename with the default data directory', function () {
    assert.strictEqual(suggestDatabasePath('test.fdb'), '/var/lib/firebird/data/test.fdb');
  });

  test('suggestDatabasePath leaves an absolute path untouched', function () {
    assert.strictEqual(suggestDatabasePath('/custom/path/mydb.fdb'), '/custom/path/mydb.fdb');
  });

  test('suggestDatabasePath returns undefined when there is no FIREBIRD_DATABASE env var', function () {
    assert.strictEqual(suggestDatabasePath(undefined), undefined);
  });
});

suite('dockerCandidates / resolveDockerExecutable', function () {

  test('dockerCandidates: docker.exe on Windows, docker elsewhere', function () {
    assert.deepStrictEqual(dockerCandidates('win32'), ['docker.exe']);
    assert.deepStrictEqual(dockerCandidates('linux'), ['docker']);
    assert.deepStrictEqual(dockerCandidates('darwin'), ['docker']);
  });

  test('an explicit setting path wins outright and is not silently swapped for PATH', async function () {
    const checked: string[] = [];
    const result = await resolveDockerExecutable('/opt/custom/docker', async candidate => {
      checked.push(candidate);
      return true;
    });
    assert.strictEqual(result, '/opt/custom/docker');
    assert.deepStrictEqual(checked, ['/opt/custom/docker']);
  });

  test('an explicit setting path that fails its check does NOT fall back to PATH', async function () {
    const checked: string[] = [];
    const result = await resolveDockerExecutable('/bad/path', async candidate => {
      checked.push(candidate);
      return false;
    });
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(checked, ['/bad/path']);
  });

  test('with no explicit setting, tries PATH candidates in order', async function () {
    const checked: string[] = [];
    const result = await resolveDockerExecutable(undefined, async candidate => {
      checked.push(candidate);
      return candidate === 'docker';
    }, 'linux');
    assert.strictEqual(result, 'docker');
    assert.deepStrictEqual(checked, ['docker']);
  });

  test('returns undefined when no candidate is found on PATH', async function () {
    const result = await resolveDockerExecutable(undefined, async () => false, 'linux');
    assert.strictEqual(result, undefined);
  });

  test('an empty-string setting is treated as "no explicit path" (falls through to PATH)', async function () {
    const checked: string[] = [];
    const result = await resolveDockerExecutable('', async candidate => {
      checked.push(candidate);
      return true;
    }, 'linux');
    assert.strictEqual(result, 'docker');
    assert.deepStrictEqual(checked, ['docker']);
  });
});

suite('dockerPsArgs / dockerInspectEnvArgs', function () {

  test('dockerPsArgs requests one JSON object per line', function () {
    assert.deepStrictEqual(dockerPsArgs(), ['ps', '--format', '{{json .}}']);
  });

  test('dockerInspectEnvArgs targets the given container id and formats its env vars one per line', function () {
    const args = dockerInspectEnvArgs('abc123');
    assert.deepStrictEqual(args, ['inspect', 'abc123', '--format', '{{range .Config.Env}}{{println .}}{{end}}']);
  });
});
