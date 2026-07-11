/**
 * Extension Development Host integration tests for automatic session query
 * history logging against a real Firebird server.
 *
 * Driver.setHistoryLogger() is how extension.ts wires every query executed
 * through Driver (typed queries, predefined tree-node actions, batch runs)
 * up to QueryHistoryProvider. These tests exercise that wiring for real —
 * running actual queries against a live Firebird server and checking the
 * resulting HistoryEntry objects — rather than mocking Driver's client as
 * src/test/query-history-provider.test.ts and the "automatic history
 * logging" suite in src/test/driver.test.ts already do.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { Driver, NodeClient } from '../../shared/driver';
import { QueryHistoryProvider } from '../../query-history/query-history-provider';
import { ConnectionOptions } from '../../interfaces';
import { getTestConnectionOptions } from './firebird-test-env';

/** Minimal ExtensionContext with an in-memory globalState — enough for QueryHistoryProvider. */
function createFakeContext(): vscode.ExtensionContext {
  const store = new Map<string, any>();
  return {
    globalState: {
      get: (key: string, defaultValue?: any) => (store.has(key) ? store.get(key) : defaultValue),
      update: async (key: string, value: any) => { store.set(key, value); },
      keys: () => [...store.keys()],
      setKeysForSync: (_keys: string[]) => { /* no-op */ },
    },
  } as unknown as vscode.ExtensionContext;
}

suite('Query history – automatic logging (real Firebird integration)', function () {
  this.timeout(20000);

  let provider: QueryHistoryProvider;

  suiteSetup(function () {
    Driver.client = new NodeClient();
  });

  setup(function () {
    provider = new QueryHistoryProvider(createFakeContext());
    Driver.setHistoryLogger(entry => { provider.add(entry).catch(() => { /* best-effort */ }); });
  });

  teardown(function () {
    Driver.historyLogger = undefined;
  });

  test('a single runQuery SELECT is logged with connection context', async function () {
    const conn = getTestConnectionOptions();
    await Driver.runQuery('SELECT ID, NAME FROM PRODUCTS ORDER BY ID', conn);

    const entries = provider.getEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].sql, 'SELECT ID, NAME FROM PRODUCTS ORDER BY ID');
    assert.strictEqual(entries[0].rowCount, 5);
    assert.strictEqual(entries[0].error, undefined);
    assert.strictEqual(entries[0].connectionId, conn.id);
    assert.ok(entries[0].connectionLabel?.includes('test.fdb') || entries[0].connectionLabel?.length, entries[0].connectionLabel);
  });

  test('runBatch logs one entry per statement, most recent first', async function () {
    const conn = getTestConnectionOptions();
    await Driver.runBatch('SELECT COUNT(*) AS CNT FROM PRODUCTS; SELECT NAME FROM PRODUCTS WHERE ID = 1;', conn);

    const entries = provider.getEntries();
    assert.strictEqual(entries.length, 2);
    // add() prepends, so the second statement executed ends up first
    assert.ok(entries[0].sql.startsWith('SELECT NAME'));
    assert.ok(entries[1].sql.startsWith('SELECT COUNT(*)'));
  });

  test('a failing query is logged with its error message', async function () {
    const conn = getTestConnectionOptions();
    await Driver.runQuery('SELECT * FROM TABLE_THAT_DOES_NOT_EXIST', conn).catch(() => { /* expected */ });

    const entries = provider.getEntries();
    assert.strictEqual(entries.length, 1);
    assert.ok(entries[0].error, 'expected the failure to be recorded with an error message');
    assert.strictEqual(entries[0].rowCount, undefined);
  });

  test('replaying a history entry by its recorded connectionId targets the same connection', async function () {
    // Simulate two saved connections the way extension.ts's globalState-backed
    // lookup does, both pointing at the same real test server but with
    // distinct ids — exactly the shape firebird.history.run resolves from.
    const connA: ConnectionOptions = { ...getTestConnectionOptions(), id: 'conn-a' };
    const savedConnections: { [id: string]: ConnectionOptions } = { 'conn-a': connA };

    await Driver.runQuery('SELECT 1 AS ONE FROM RDB$DATABASE', connA);
    const original = provider.getEntries()[0];
    assert.strictEqual(original.connectionId, 'conn-a');

    // Replay: look the connection back up by the id recorded on the entry
    // (this is exactly what firebird.history.run does before calling
    // Driver.runBatch) and confirm it runs successfully against it again.
    const resolved = savedConnections[original.connectionId!];
    assert.ok(resolved, 'the original connection should still be resolvable by id');

    const replayResults = await Driver.runBatch(original.sql, resolved);
    assert.strictEqual(replayResults.length, 1);
    assert.ok(!replayResults[0].error);
    assert.strictEqual(Number(replayResults[0].rows![0].ONE), 1);

    const entries = provider.getEntries();
    assert.strictEqual(entries.length, 2, 'the replay should also have logged a new history entry');
    assert.strictEqual(entries[0].connectionId, 'conn-a');
  });
});
