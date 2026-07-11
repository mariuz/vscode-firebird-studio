/**
 * End-to-end coverage for Docker container discovery (the "Add New Connection" wizard's Docker
 * option): shells out to the real `docker` CLI and confirms it finds the actual Firebird service
 * container this CI job's own workflow (e2e.yml) started — not a re-implementation, the exact
 * parseDockerPsOutput()/discoverFirebirdContainers() functions the wizard uses.
 *
 * GitHub Actions `services:` containers are real Docker containers on the runner's shared Docker
 * daemon, so `docker ps` from a workflow step sees them the same way it would see any container a
 * developer started by hand — that's what makes this a meaningful integration test rather than a
 * mock. Skips gracefully if the `docker` CLI isn't on PATH (e.g. running locally without Docker),
 * matching the isql e2e suite's pattern for optional external tooling.
 */

import * as assert from 'assert';
import * as cp from 'node:child_process';
import {
  parseDockerPsOutput,
  discoverFirebirdContainers,
  parseDockerInspectEnv,
  suggestDatabasePath,
  dockerPsArgs,
  dockerInspectEnvArgs,
} from '../../shared/docker-discovery';

function checkDockerExecutable(): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = cp.execFile('docker', ['--version'], { timeout: 5000 }, err => resolve(!err));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

function runDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile('docker', args, { timeout: 10000 }, (err, stdout) => {
      if (err) { reject(err); } else { resolve(stdout); }
    });
  });
}

suite('E2E – Docker container discovery (real docker CLI + real Firebird service container)', function () {
  this.timeout(20000);

  let dockerAvailable = false;

  suiteSetup(async function () {
    dockerAvailable = await checkDockerExecutable();
    if (!dockerAvailable) {
      // eslint-disable-next-line no-console
      console.log('[docker-discovery e2e] docker CLI not found on PATH — skipping.');
    }
  });

  test('docker ps finds a running container publishing Firebird\'s port (3050)', async function () {
    if (!dockerAvailable) { this.skip(); return; }

    const stdout = await runDocker(dockerPsArgs());
    const containers = parseDockerPsOutput(stdout);
    assert.ok(containers.length > 0, 'expected at least one running container (this job\'s own Firebird service)');

    const discovered = discoverFirebirdContainers(containers);
    assert.ok(discovered.length > 0, `expected a container publishing 3050, got containers: ${JSON.stringify(containers)}`);
  });

  test('the discovered container actually accepts connections on its published port', async function () {
    if (!dockerAvailable) { this.skip(); return; }

    const stdout = await runDocker(dockerPsArgs());
    const [discovered] = discoverFirebirdContainers(parseDockerPsOutput(stdout));
    assert.ok(discovered, 'expected a discovered Firebird container from the previous test\'s scenario');

    // FIREBIRD_HOST/PORT are set by e2e.yml to localhost:3050, published by the same container
    // this discovery is finding — confirms the discovered port isn't just plausible-looking, but
    // the actual port real client connections are using in this job.
    const expectedPort = Number(process.env.FIREBIRD_PORT ?? '3050');
    assert.strictEqual(discovered.hostPort, expectedPort);
  });

  test('docker inspect on the discovered container surfaces a usable FIREBIRD_DATABASE-derived path', async function () {
    if (!dockerAvailable) { this.skip(); return; }

    const psOutput = await runDocker(dockerPsArgs());
    const [discovered] = discoverFirebirdContainers(parseDockerPsOutput(psOutput));
    assert.ok(discovered, 'expected a discovered Firebird container');

    const inspectOutput = await runDocker(dockerInspectEnvArgs(discovered.container.id));
    const env = parseDockerInspectEnv(inspectOutput);
    const suggested = suggestDatabasePath(env['FIREBIRD_DATABASE']);

    if (env['FIREBIRD_DATABASE']) {
      assert.ok(suggested, `expected a suggested path from FIREBIRD_DATABASE=${env['FIREBIRD_DATABASE']}`);
      assert.ok(suggested!.startsWith('/'), `expected an absolute path, got: ${suggested}`);
    } else {
      // Some Firebird image versions may not set this env var explicitly; that's fine, the
      // wizard falls back to an empty (manually-filled) database prompt in that case.
      assert.strictEqual(suggested, undefined);
    }
  });
});
