/**
 * Extension Development Host integration test for the connection wizard's "Test Connection" step
 * (docs/roadmap/connection-management-enhancements.md, phase 1). The wizard itself is VS Code
 * dialog orchestration (QuickPick/InputBox sequencing) — consistent with this repo's existing
 * boundary for that (see e.g. flat-file-import-wizard.md's "not unit-tested itself" note for
 * node-database.ts's similar wizard-style methods), it has no test file of its own and this
 * doesn't add one. attemptConnection() is different: a real connect-then-detach against a real
 * server, whose whole point is to never throw and always report success/failure as a string —
 * exactly the kind of real, non-orchestration behavior worth verifying against a live server.
 */

import * as assert from 'assert';
import { attemptConnection } from '../../shared/connection-wizard';
import { Driver, NodeClient } from '../../shared/driver';
import { getTestConnectionOptions } from './firebird-test-env';

suite('Connection wizard – attemptConnection() real Firebird integration (extension host)', function () {
  this.timeout(20000);

  suiteSetup(function () {
    Driver.client = new NodeClient();
  });

  test('a real, reachable connection with the right credentials reports success (no error)', async function () {
    const error = await attemptConnection(getTestConnectionOptions());
    assert.strictEqual(error, undefined);
  });

  test('a wrong password is reported as a real error string, not thrown', async function () {
    const error = await attemptConnection({ ...getTestConnectionOptions(), password: 'definitely-not-the-real-password' });
    assert.ok(typeof error === 'string' && error.length > 0, `expected a real error message, got: ${error}`);
  });

  test('an unreachable host is reported as a real error string, not thrown, and not hung', async function () {
    const error = await attemptConnection({ ...getTestConnectionOptions(), host: '127.0.0.1', port: 1 });
    assert.ok(typeof error === 'string' && error.length > 0, `expected a real error message, got: ${error}`);
  });
});
