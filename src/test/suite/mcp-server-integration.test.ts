/**
 * Extension Development Host integration test for the MCP server's live-refresh fix
 * (docs/roadmap/mcp-server.md, "Live refresh mid-session"): toggling a
 * connection's mcpExposed flag from the tree (NodeDatabase.toggleMcpExposure()) now calls
 * notifyMcpExposureChanged(), which registerMcpServer() relays into the McpServerDefinitionProvider's
 * onDidChangeMcpServerDefinitions so an already-running MCP client picks up the change without a
 * restart. VS Code's own MCP subsystem consuming that event isn't observable from an extension
 * test (it's internal to VS Code core), so this verifies the full chain this extension owns: the
 * real toggleMcpExposure() command path -> notifyMcpExposureChanged() -> the exported
 * onMcpExposureChanged event actually firing, using the real (unmocked) vscode module the
 * Extension Development Host provides.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { NodeDatabase } from '../../nodes';
import { onMcpExposureChanged } from '../../mcp-server';
import { Constants } from '../../config';
import { getTestConnectionOptions } from './firebird-test-env';
import { FirebirdTreeDataProvider } from '../../firebirdTreeDataProvider';
import { ConnectionOptions } from '../../interfaces';

suite('MCP server – live refresh on mcpExposed toggle (extension host)', function () {
  this.timeout(10000);

  test('NodeDatabase.toggleMcpExposure() fires onMcpExposureChanged', async function () {
    const connectionOptions = getTestConnectionOptions();
    const store = new Map<string, unknown>();
    store.set(Constants.ConectionsKey, { [connectionOptions.id]: { ...connectionOptions } });

    const fakeContext = {
      globalState: {
        get: (key: string) => store.get(key),
        update: async (key: string, value: unknown) => { store.set(key, value); },
      },
    } as unknown as vscode.ExtensionContext;

    const fakeTreeProvider = { refresh: () => { /* no-op */ } } as unknown as FirebirdTreeDataProvider;

    let fired = 0;
    const subscription = onMcpExposureChanged(() => { fired++; });

    try {
      const db = new NodeDatabase(connectionOptions);
      await db.toggleMcpExposure(fakeContext, fakeTreeProvider);
    } finally {
      subscription.dispose();
    }

    assert.strictEqual(fired, 1, 'expected exactly one onMcpExposureChanged notification from a single toggle');

    const saved = store.get(Constants.ConectionsKey) as Record<string, { mcpExposed?: boolean }>;
    assert.strictEqual(saved[connectionOptions.id].mcpExposed, true, 'expected mcpExposed to actually flip to true in the saved connection');
  });

  test('toggleMcpExposure() on a workspace-sourced connection neither saves nor notifies', async function () {
    const connectionOptions = { ...getTestConnectionOptions(), workspace: true };
    const store = new Map<string, unknown>();
    store.set(Constants.ConectionsKey, { [connectionOptions.id]: { ...connectionOptions } });

    const fakeContext = {
      globalState: {
        get: (key: string) => store.get(key),
        update: async (key: string, value: unknown) => { store.set(key, value); },
      },
    } as unknown as vscode.ExtensionContext;
    const fakeTreeProvider = { refresh: () => { /* no-op */ } } as unknown as FirebirdTreeDataProvider;

    let fired = 0;
    const subscription = onMcpExposureChanged(() => { fired++; });

    try {
      const db = new NodeDatabase(connectionOptions);
      await db.toggleMcpExposure(fakeContext, fakeTreeProvider);
    } finally {
      subscription.dispose();
    }

    assert.strictEqual(fired, 0, 'a workspace-sourced connection should refuse the toggle entirely, not notify');
  });
});

/**
 * Extension Development Host integration test for the MCP server's write-query path
 * (docs/roadmap/mcp-server.md's "write-query path" phase): toggleMcpWriteAccess() is the only
 * place in the whole write-query path with a real VS Code UI available to ask the user, since the
 * spawned server.ts subprocess that actually runs a write can't show a dialog of its own. This
 * drives the real command path (fake ExtensionContext, real NodeDatabase/toggleMcpWriteAccess())
 * the same way the mcpExposed suite above does, monkey-patching vscode.window.showWarningMessage
 * for the run of each test (plain property reassignment on the real, unmocked module the Extension
 * Development Host provides — restored in a `finally`) since there's no real person available to
 * click the confirmation dialog's button in a test run.
 */
suite('MCP server – write-query opt-in (extension host)', function () {
  this.timeout(10000);

  function fakeContextAndProvider(connectionOptions: ConnectionOptions) {
    const store = new Map<string, unknown>();
    store.set(Constants.ConectionsKey, { [connectionOptions.id]: { ...connectionOptions } });
    const fakeContext = {
      globalState: {
        get: (key: string) => store.get(key),
        update: async (key: string, value: unknown) => { store.set(key, value); },
      },
    } as unknown as vscode.ExtensionContext;
    const fakeTreeProvider = { refresh: () => { /* no-op */ } } as unknown as FirebirdTreeDataProvider;
    return { store, fakeContext, fakeTreeProvider };
  }

  async function withStubbedWarning<T>(response: string | undefined, fn: () => Promise<T>): Promise<T> {
    const original = vscode.window.showWarningMessage;
    (vscode.window as any).showWarningMessage = async () => response;
    try {
      return await fn();
    } finally {
      (vscode.window as any).showWarningMessage = original;
    }
  }

  test('refuses to enable write access when the connection is not yet mcpExposed', async function () {
    const connectionOptions = getTestConnectionOptions();
    const { store, fakeContext, fakeTreeProvider } = fakeContextAndProvider(connectionOptions);

    let fired = 0;
    const subscription = onMcpExposureChanged(() => { fired++; });
    try {
      const db = new NodeDatabase(connectionOptions);
      await db.toggleMcpWriteAccess(fakeContext, fakeTreeProvider);
    } finally {
      subscription.dispose();
    }

    assert.strictEqual(fired, 0, 'refusing outright should not fire a change notification');
    const saved = store.get(Constants.ConectionsKey) as Record<string, { mcpWriteEnabled?: boolean }>;
    assert.notStrictEqual(saved[connectionOptions.id].mcpWriteEnabled, true, 'write access must not have been granted');
  });

  test('enabling write access requires confirmation, and actually flips mcpWriteEnabled when confirmed', async function () {
    const connectionOptions = { ...getTestConnectionOptions(), mcpExposed: true };
    const { store, fakeContext, fakeTreeProvider } = fakeContextAndProvider(connectionOptions);

    let fired = 0;
    const subscription = onMcpExposureChanged(() => { fired++; });
    try {
      const db = new NodeDatabase(connectionOptions);
      await withStubbedWarning('Grant Write Access', () => db.toggleMcpWriteAccess(fakeContext, fakeTreeProvider));
    } finally {
      subscription.dispose();
    }

    assert.strictEqual(fired, 1, 'expected exactly one notification from a confirmed grant');
    const saved = store.get(Constants.ConectionsKey) as Record<string, { mcpWriteEnabled?: boolean }>;
    assert.strictEqual(saved[connectionOptions.id].mcpWriteEnabled, true);
  });

  test('cancelling the confirmation dialog leaves write access disabled', async function () {
    const connectionOptions = { ...getTestConnectionOptions(), mcpExposed: true };
    const { store, fakeContext, fakeTreeProvider } = fakeContextAndProvider(connectionOptions);

    let fired = 0;
    const subscription = onMcpExposureChanged(() => { fired++; });
    try {
      const db = new NodeDatabase(connectionOptions);
      await withStubbedWarning(undefined, () => db.toggleMcpWriteAccess(fakeContext, fakeTreeProvider));
    } finally {
      subscription.dispose();
    }

    assert.strictEqual(fired, 0, 'a cancelled confirmation must not fire a change notification');
    const saved = store.get(Constants.ConectionsKey) as Record<string, { mcpWriteEnabled?: boolean }>;
    assert.notStrictEqual(saved[connectionOptions.id].mcpWriteEnabled, true);
  });

  test('disabling write access needs no confirmation dialog at all', async function () {
    const connectionOptions = { ...getTestConnectionOptions(), mcpExposed: true, mcpWriteEnabled: true };
    const { store, fakeContext, fakeTreeProvider } = fakeContextAndProvider(connectionOptions);

    let warningShown = false;
    const original = vscode.window.showWarningMessage;
    (vscode.window as any).showWarningMessage = async () => { warningShown = true; return undefined; };

    let fired = 0;
    const subscription = onMcpExposureChanged(() => { fired++; });
    try {
      const db = new NodeDatabase(connectionOptions);
      await db.toggleMcpWriteAccess(fakeContext, fakeTreeProvider);
    } finally {
      subscription.dispose();
      (vscode.window as any).showWarningMessage = original;
    }

    assert.strictEqual(warningShown, false, 'disabling a permission should never need a confirmation dialog');
    assert.strictEqual(fired, 1);
    const saved = store.get(Constants.ConectionsKey) as Record<string, { mcpWriteEnabled?: boolean }>;
    assert.strictEqual(saved[connectionOptions.id].mcpWriteEnabled, false);
  });

  test('turning mcpExposed off also revokes a previously-granted mcpWriteEnabled, so re-exposing later cannot silently reactivate it', async function () {
    const connectionOptions = { ...getTestConnectionOptions(), mcpExposed: true, mcpWriteEnabled: true };
    const { store, fakeContext, fakeTreeProvider } = fakeContextAndProvider(connectionOptions);

    const db = new NodeDatabase(connectionOptions);
    await db.toggleMcpExposure(fakeContext, fakeTreeProvider); // mcpExposed: true -> false

    const saved = store.get(Constants.ConectionsKey) as Record<string, { mcpExposed?: boolean; mcpWriteEnabled?: boolean }>;
    assert.strictEqual(saved[connectionOptions.id].mcpExposed, false);
    assert.strictEqual(saved[connectionOptions.id].mcpWriteEnabled, false, 'write access should be cleared, not left dormant, once exposure is turned off');
  });

  test('a workspace-sourced connection refuses toggleMcpWriteAccess entirely', async function () {
    const connectionOptions = { ...getTestConnectionOptions(), workspace: true, mcpExposed: true };
    const { store, fakeContext, fakeTreeProvider } = fakeContextAndProvider(connectionOptions);

    let fired = 0;
    const subscription = onMcpExposureChanged(() => { fired++; });
    try {
      const db = new NodeDatabase(connectionOptions);
      await db.toggleMcpWriteAccess(fakeContext, fakeTreeProvider);
    } finally {
      subscription.dispose();
    }

    assert.strictEqual(fired, 0);
    const saved = store.get(Constants.ConectionsKey) as Record<string, { mcpWriteEnabled?: boolean }>;
    assert.notStrictEqual(saved[connectionOptions.id].mcpWriteEnabled, true);
  });
});
