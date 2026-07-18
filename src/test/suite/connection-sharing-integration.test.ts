/**
 * Extension Development Host integration test for the Cross-Extension Connection Sharing API,
 * all four phases (docs/roadmap/cross-extension-connection-api.md) — `firebird.connectionSharing.*`
 * commands, driven exactly the way an external caller would: via
 * `vscode.commands.executeCommand()`, not a direct import.
 *
 * This is deliberately the ONLY suite-tier coverage here, distinct from (not a duplicate of)
 * src/test/connection-sharing*.test.ts's unit tests: those exercise the plain-tsc-compiled,
 * unbundled `src/connection-sharing/*.ts` modules directly with a mock ExtensionContext; this one
 * exercises whatever `out/extension.js` (the esbuild bundle) registered at real activation,
 * confirming the wiring itself — not just the underlying logic — actually works. Doesn't attempt
 * to seed a specific saved/active connection first: `Global`/the connections in `globalState` are
 * bundled *inside* `out/extension.js` as a separate module instance from what a suite test file
 * can import and mutate directly (the same gotcha documented in several other suite tests this
 * session), so what's asserted here is deliberately limited to "the real command is wired up and
 * returns a well-shaped result for whatever this environment's real state happens to be" rather
 * than a specific expected value. The phase 2–4 tests below monkey-patch the *real* (unmocked)
 * `vscode.window.showInformationMessage`/`showWarningMessage` for the duration of each test to
 * simulate the user's Approve/Deny/Grant response — the same approach
 * `mcp-server-integration.test.ts` already established for exactly this reason (there's no person
 * available to click a real dialog's button in a test run).
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

suite('Cross-Extension Connection Sharing API – phases 2–4: permission gate, runQuery, write access (extension host)', function () {
  this.timeout(10000);

  const realShowInformationMessage = vscode.window.showInformationMessage;
  const realShowWarningMessage = vscode.window.showWarningMessage;

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio');
    if (ext && !ext.isActive) { await ext.activate(); }
  });

  teardown(function () {
    (vscode.window as any).showInformationMessage = realShowInformationMessage;
    (vscode.window as any).showWarningMessage = realShowWarningMessage;
  });

  test('runQuery is refused with a clear error when the user denies the permission prompt', async function () {
    (vscode.window as any).showInformationMessage = () => Promise.resolve('Deny');
    const result = await vscode.commands.executeCommand(
      'firebird.connectionSharing.runQuery', 'test.denied.extension', 'some-connection-id', 'SELECT 1 FROM RDB$DATABASE'
    ) as any;
    assert.ok(result.error, `expected a real error, got: ${JSON.stringify(result)}`);
    assert.ok(!result.rows);
  });

  test('runQuery reports "connection not found" for an approved extension and an unknown connection id, not a crash', async function () {
    (vscode.window as any).showInformationMessage = () => Promise.resolve('Approve');
    const result = await vscode.commands.executeCommand(
      'firebird.connectionSharing.runQuery', 'test.approved.extension', 'no-such-connection-id', 'SELECT 1 FROM RDB$DATABASE'
    ) as any;
    assert.ok(result.error, `expected a real error, got: ${JSON.stringify(result)}`);
    assert.ok(result.error.includes('no-such-connection-id'), result.error);
  });

  test('runWriteQuery is refused for an extension that has read approval but no write grant', async function () {
    (vscode.window as any).showInformationMessage = () => Promise.resolve('Approve');
    // Establish read approval first (cached from here on for this extension id).
    await vscode.commands.executeCommand('firebird.connectionSharing.runQuery', 'test.readonly.extension', 'x', 'SELECT 1 FROM RDB$DATABASE');

    const result = await vscode.commands.executeCommand(
      'firebird.connectionSharing.runWriteQuery', 'test.readonly.extension', 'x', "UPDATE T SET C = 1"
    ) as any;
    assert.ok(result.error, `expected a real error, got: ${JSON.stringify(result)}`);
    assert.ok(result.error.includes('write access'), result.error);
  });

  test('firebird.connectionSharing.editPermissions does not throw or hang, whether or not a grant already exists', async function () {
    // Earlier tests in this suite may have already created real grants (SecretStorage persists
    // for the whole session) -- stubbing both showInformationMessage (the "no grants yet" path)
    // and showQuickPick (the "review an existing grant" path, dismissed here) covers either case
    // without needing to know which one this run will actually take.
    (vscode.window as any).showInformationMessage = () => Promise.resolve(undefined);
    const realShowQuickPick = vscode.window.showQuickPick;
    (vscode.window as any).showQuickPick = () => Promise.resolve(undefined);
    try {
      await assert.doesNotReject(
        Promise.resolve(vscode.commands.executeCommand('firebird.connectionSharing.editPermissions'))
      );
    } finally {
      (vscode.window as any).showQuickPick = realShowQuickPick;
    }
  });
});
