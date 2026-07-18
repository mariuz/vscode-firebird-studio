/**
 * Extension Development Host integration test for the Cross-Extension Connection Sharing API's
 * phase 1 (docs/roadmap/cross-extension-connection-api.md) — `firebird.connectionSharing.*`
 * commands, driven exactly the way an external caller would: via
 * `vscode.commands.executeCommand()`, not a direct import.
 *
 * This is deliberately the ONLY suite-tier coverage here, distinct from (not a duplicate of)
 * src/test/connection-sharing.test.ts's unit tests: those exercise the plain-tsc-compiled,
 * unbundled `src/connection-sharing/index.ts` module directly with a mock ExtensionContext; this
 * one exercises whatever `out/extension.js` (the esbuild bundle) registered at real activation,
 * confirming the wiring itself — not just the underlying logic — actually works. Doesn't attempt
 * to seed a specific saved/active connection first: `Global`/the connections in `globalState` are
 * bundled *inside* `out/extension.js` as a separate module instance from what a suite test file
 * can import and mutate directly (the same gotcha documented in several other suite tests this
 * session), so what's asserted here is deliberately limited to "the real command is wired up and
 * returns a well-shaped result for whatever this environment's real state happens to be" rather
 * than a specific expected value.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Cross-Extension Connection Sharing API – real command invocation (extension host)', function () {
  this.timeout(10000);

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio');
    if (ext && !ext.isActive) { await ext.activate(); }
  });

  test('firebird.connectionSharing.listConnections returns an array, called the way an external extension would', async function () {
    const result = await vscode.commands.executeCommand('firebird.connectionSharing.listConnections', 'some.other.extension');
    assert.ok(Array.isArray(result), `expected an array, got: ${JSON.stringify(result)}`);
  });

  test('every entry listConnections returns has id/label/host/database/embedded and never a password', async function () {
    const result = await vscode.commands.executeCommand('firebird.connectionSharing.listConnections', 'some.other.extension') as any[];
    for (const entry of result) {
      assert.strictEqual(typeof entry.id, 'string');
      assert.strictEqual(typeof entry.label, 'string');
      assert.strictEqual(typeof entry.host, 'string');
      assert.strictEqual(typeof entry.database, 'string');
      assert.strictEqual(typeof entry.embedded, 'boolean');
      assert.ok(!('password' in entry), 'a shared connection entry must never carry a password field');
    }
  });

  test('firebird.connectionSharing.getActiveConnection does not throw, whether or not a connection happens to be active', async function () {
    const result = await vscode.commands.executeCommand('firebird.connectionSharing.getActiveConnection', 'some.other.extension');
    // Either undefined (nothing active in this environment) or a well-shaped SharedConnectionInfo.
    if (result !== undefined) {
      const info = result as any;
      assert.strictEqual(typeof info.id, 'string');
      assert.ok(!('password' in info));
    }
  });

  test('an unset requestingExtensionId does not throw either — the argument is optional', async function () {
    await assert.doesNotReject(Promise.resolve(vscode.commands.executeCommand('firebird.connectionSharing.listConnections')));
    await assert.doesNotReject(Promise.resolve(vscode.commands.executeCommand('firebird.connectionSharing.getActiveConnection')));
  });
});
