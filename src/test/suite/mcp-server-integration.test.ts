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
