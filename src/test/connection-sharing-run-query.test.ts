/**
 * Unit tests for connection-sharing/run-query.ts (docs/roadmap/cross-extension-connection-api.md,
 * phases 3–4). Approves/write-enables the requesting extension via the same monkey-patched-mock
 * approach connection-sharing-permissions.test.ts uses, then stubs `Driver.client` with a fake
 * in-memory ClientI implementation — no real database needed, the same way a fake ClientI is
 * already accepted elsewhere in this codebase's test suite (see driver.ts's own ClientI doc
 * comment: "fake/test ClientI implementations... can omit" the optional methods).
 */

import * as assert from 'assert';
import * as vscodeMock from './mocks/vscode';
import { createMockContext } from './mocks/vscode';
import { Driver, ClientI } from '../shared/driver';
import { runQuery, runWriteQuery } from '../connection-sharing/run-query';
import { requestConnectionSharingPermission, toggleWriteAccess } from '../connection-sharing/permissions';

const realShowInformationMessage = vscodeMock.window.showInformationMessage;
const realShowWarningMessage = vscodeMock.window.showWarningMessage;
const realClient = Driver.client;

function stubInformationMessage(response: string | undefined) {
  (vscodeMock.window as any).showInformationMessage = () => Promise.resolve(response);
}
function stubWarningMessage(response: string | undefined) {
  (vscodeMock.window as any).showWarningMessage = () => Promise.resolve(response);
}

/** A fake ClientI that just records what it was asked to run and returns canned rows. */
function fakeClient(rows: any[] = [{ N: 1 }]): ClientI<any> & { queries: string[] } {
  return {
    queries: [] as string[],
    async createConnection() { return {}; },
    async detach() { /* no-op */ },
    async queryPromise(_connection: any, sql: string) {
      (this as any).queries.push(sql);
      return rows;
    },
  } as any;
}

async function approvedContext(extensionId: string) {
  const ctx = createMockContext() as any;
  stubInformationMessage('Approve');
  await requestConnectionSharingPermission(ctx, extensionId);
  return ctx;
}

// A real saved connection never carries a password (see saveNewConnection()'s own
// optionsToSave -- it's always resolved from CredentialStore at query time instead). This test
// stub includes one directly so Driver.resolvePassword()'s existing short-circuit
// (`if (connectionOptions.password) { return connectionOptions; }`) skips CredentialStore
// entirely -- CredentialStore's own SecretStorage-backed resolution is already covered by its own
// tests; what's under test here is resolveConnectionById()/runQuery()'s own logic, not that.
async function withSavedConnection(ctx: any, id: string, overrides: Record<string, any> = {}) {
  await ctx.globalState.update('firebird.connections', {
    [id]: { id, host: 'localhost', port: 3050, database: '/data/x.fdb', user: 'sysdba', password: 'test-password', role: null, embedded: false, ...overrides },
  });
}

suite('connection-sharing/run-query – runQuery()', function () {
  teardown(function () {
    (vscodeMock.window as any).showInformationMessage = realShowInformationMessage;
    Driver.client = realClient;
  });

  test('refused when the requesting extension has no permission', async function () {
    const ctx = createMockContext() as any;
    stubInformationMessage('Deny');
    const result = await runQuery(ctx, 'unapproved.extension', 'conn-1', 'SELECT 1 FROM RDB$DATABASE');
    assert.ok(result.error);
    assert.ok(!result.rows);
  });

  test('rejects a non-SELECT statement even for an approved extension', async function () {
    const ctx = await approvedContext('some.extension');
    const result = await runQuery(ctx, 'some.extension', 'conn-1', 'DELETE FROM CUSTOMERS');
    assert.ok(result.error);
    assert.ok(result.error!.includes('read-only'), result.error);
  });

  test('reports a clear error when the connection id is not found', async function () {
    const ctx = await approvedContext('some.extension');
    const result = await runQuery(ctx, 'some.extension', 'no-such-connection', 'SELECT 1 FROM RDB$DATABASE');
    assert.ok(result.error);
    assert.ok(result.error!.includes('no-such-connection'), result.error);
  });

  test('runs a real SELECT through Driver.runQuery() and returns its rows for a known connection', async function () {
    const ctx = await approvedContext('some.extension');
    await withSavedConnection(ctx, 'conn-1');
    const client = fakeClient([{ COUNT: 42 }]);
    Driver.client = client;

    const result = await runQuery(ctx, 'some.extension', 'conn-1', 'SELECT COUNT(*) AS COUNT FROM CUSTOMERS');

    assert.strictEqual(result.error, undefined);
    assert.deepStrictEqual(result.rows, [{ COUNT: 42 }]);
    assert.strictEqual(client.queries[0], 'SELECT COUNT(*) AS COUNT FROM CUSTOMERS');
  });

  test('a Driver.runQuery() failure is reported as an error, not thrown', async function () {
    const ctx = await approvedContext('some.extension');
    await withSavedConnection(ctx, 'conn-1');
    Driver.client = {
      async createConnection() { return {}; },
      async detach() { /* no-op */ },
      async queryPromise() { throw new Error('connection refused'); },
    } as any;

    const result = await runQuery(ctx, 'some.extension', 'conn-1', 'SELECT 1 FROM RDB$DATABASE');
    assert.strictEqual(result.error, 'connection refused');
  });
});

suite('connection-sharing/run-query – runWriteQuery()', function () {
  teardown(function () {
    (vscodeMock.window as any).showInformationMessage = realShowInformationMessage;
    (vscodeMock.window as any).showWarningMessage = realShowWarningMessage;
    Driver.client = realClient;
  });

  test('refused when read-approved but not write-enabled', async function () {
    const ctx = await approvedContext('some.extension');
    await withSavedConnection(ctx, 'conn-1');
    const result = await runWriteQuery(ctx, 'some.extension', 'conn-1', "UPDATE CUSTOMERS SET NAME = 'x' WHERE ID = 1");
    assert.ok(result.error);
    assert.ok(result.error!.includes('write access'), result.error);
  });

  test('refused outright when not even read-approved, before write access is even checked', async function () {
    const ctx = createMockContext() as any;
    stubInformationMessage('Deny');
    const result = await runWriteQuery(ctx, 'unapproved.extension', 'conn-1', "UPDATE CUSTOMERS SET NAME = 'x' WHERE ID = 1");
    assert.ok(result.error);
    assert.ok(result.error!.includes('permission'), result.error);
  });

  test('rejects a SELECT — this path is for INSERT/UPDATE/DELETE only', async function () {
    const ctx = await approvedContext('some.extension');
    stubWarningMessage('Grant Write Access');
    await toggleWriteAccess(ctx, 'some.extension');

    const result = await runWriteQuery(ctx, 'some.extension', 'conn-1', 'SELECT * FROM CUSTOMERS');
    assert.ok(result.error);
    assert.ok(result.error!.includes('INSERT/UPDATE/DELETE'), result.error);
  });

  test('runs a real UPDATE through Driver.runQuery() once write access is granted', async function () {
    const ctx = await approvedContext('some.extension');
    stubWarningMessage('Grant Write Access');
    await toggleWriteAccess(ctx, 'some.extension');
    await withSavedConnection(ctx, 'conn-1');
    const client = fakeClient([{ message: 'Update executed successfully!' }]);
    Driver.client = client;

    const result = await runWriteQuery(ctx, 'some.extension', 'conn-1', "UPDATE CUSTOMERS SET NAME = 'x' WHERE ID = 1");

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(client.queries[0], "UPDATE CUSTOMERS SET NAME = 'x' WHERE ID = 1");
  });
});
