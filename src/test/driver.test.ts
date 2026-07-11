/**
 * Unit tests for Driver.
 *
 * Most of this file tests pure utility functions that can be exercised
 * without a live Firebird connection: Driver.constructResponse() and
 * extractTableNames(). The "runBatch()" suite drives Driver.runBatch()
 * against a fake ClientI (no network) to verify batch splitting, per-statement
 * result assembly, and error isolation without needing a real Firebird server
 * — see src/test/suite/driver-integration.test.ts for the real-server version.
 *
 * All vscode API calls are intercepted by the mock registered in setup.ts.
 */

import * as assert from 'assert';
import * as Firebird from 'node-firebird';
import { Driver, ClientI, HistoryLogEntry, extractTableNames, toNodeFirebirdOptions } from '../shared/driver';
import { ConnectionOptions } from '../interfaces';
import { CredentialStore } from '../shared/credential-store';
import { createMockContext } from './mocks/vscode';

// ── Driver.constructResponse ──────────────────────────────────────────────────

suite('Driver – constructResponse()', function () {

  test('returns "Create" for CREATE statement', function () {
    assert.strictEqual(Driver.constructResponse('CREATE TABLE T (ID INT)'), 'Create');
  });

  test('returns "Insert" for INSERT statement', function () {
    assert.strictEqual(Driver.constructResponse('INSERT INTO T VALUES (1)'), 'Insert');
  });

  test('returns "Alter" for ALTER statement', function () {
    assert.strictEqual(Driver.constructResponse('ALTER TABLE T ADD COL VARCHAR(10)'), 'Alter');
  });

  test('returns "Drop" for DROP statement', function () {
    assert.strictEqual(Driver.constructResponse('DROP TABLE T'), 'Drop');
  });

  test('returns "Delete" for DELETE statement', function () {
    assert.strictEqual(Driver.constructResponse('DELETE FROM T WHERE ID = 1'), 'Delete');
  });

  test('returns null for SELECT statement', function () {
    assert.strictEqual(Driver.constructResponse('SELECT * FROM T'), null);
  });

  test('returns null for UPDATE statement', function () {
    assert.strictEqual(Driver.constructResponse('UPDATE T SET COL = 1'), null);
  });

  test('is case-insensitive', function () {
    assert.strictEqual(Driver.constructResponse('create table t (id int)'), 'Create');
    assert.strictEqual(Driver.constructResponse('INSERT INTO t values (1)'), 'Insert');
    assert.strictEqual(Driver.constructResponse('Drop Table T'), 'Drop');
  });

  test('returns "Create" when keyword appears anywhere in the string', function () {
    // The current implementation uses indexOf, so the keyword anywhere triggers it
    assert.strictEqual(Driver.constructResponse('  create procedure p as begin end'), 'Create');
  });

  test('returns null for empty string', function () {
    assert.strictEqual(Driver.constructResponse(''), null);
  });
});

// ── extractTableNames ─────────────────────────────────────────────────────────

suite('Driver – extractTableNames()', function () {

  test('extracts single table from FROM clause', function () {
    const names = extractTableNames('SELECT * FROM CUSTOMERS');
    assert.deepStrictEqual(names, ['CUSTOMERS']);
  });

  test('extracts table from JOIN clause', function () {
    const names = extractTableNames('SELECT * FROM ORDERS JOIN CUSTOMERS ON ORDERS.ID = CUSTOMERS.ID');
    assert.ok(names.includes('ORDERS'), 'Expected ORDERS');
    assert.ok(names.includes('CUSTOMERS'), 'Expected CUSTOMERS');
    assert.strictEqual(names.length, 2);
  });

  test('extracts multiple JOIN tables', function () {
    const sql = 'SELECT * FROM A JOIN B ON A.X = B.X LEFT JOIN C ON B.Y = C.Y';
    const names = extractTableNames(sql);
    assert.ok(names.includes('A'));
    assert.ok(names.includes('B'));
    assert.ok(names.includes('C'));
    assert.strictEqual(names.length, 3);
  });

  test('returns empty array for non-SELECT SQL', function () {
    const names = extractTableNames('INSERT INTO T VALUES (1)');
    assert.deepStrictEqual(names, []);
  });

  test('returns empty array for empty string', function () {
    assert.deepStrictEqual(extractTableNames(''), []);
  });

  test('deduplicates repeated table names', function () {
    const sql = 'SELECT * FROM T JOIN T ON T.ID = T.PARENT_ID';
    const names = extractTableNames(sql);
    assert.strictEqual(names.filter(n => n === 'T').length, 1, 'T should appear only once');
  });

  test('uppercases extracted names', function () {
    const names = extractTableNames('SELECT * FROM customers');
    assert.deepStrictEqual(names, ['CUSTOMERS']);
  });

  test('handles table names with underscores and digits', function () {
    const names = extractTableNames('SELECT * FROM ORDER_LINE_ITEMS_2024');
    assert.deepStrictEqual(names, ['ORDER_LINE_ITEMS_2024']);
  });
});

// ── toNodeFirebirdOptions ────────────────────────────────────────────────────
//
// Regression coverage for a bug where the UI-facing wireCrypt string
// ('Required' | 'Enabled' | 'Disabled') was passed straight through to
// node-firebird, which expects the numeric WIRE_CRYPT_DISABLE/WIRE_CRYPT_ENABLE
// constant written into the wire protocol handshake — a raw string there
// corrupts the handshake and hangs the connection.

suite('Driver – toNodeFirebirdOptions()', function () {
  function baseConnection(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
    return {
      id: 'test',
      host: 'localhost',
      port: 3050,
      database: '/data/test.fdb',
      user: 'sysdba',
      password: 'masterkey',
      role: null,
      ...overrides,
    };
  }

  test('maps wireCrypt "Disabled" to Firebird.WIRE_CRYPT_DISABLE', function () {
    const opts = toNodeFirebirdOptions(baseConnection({ wireCrypt: 'Disabled' }));
    assert.strictEqual(opts.wireCrypt, Firebird.WIRE_CRYPT_DISABLE);
  });

  test('maps wireCrypt "Enabled" to Firebird.WIRE_CRYPT_ENABLE', function () {
    const opts = toNodeFirebirdOptions(baseConnection({ wireCrypt: 'Enabled' }));
    assert.strictEqual(opts.wireCrypt, Firebird.WIRE_CRYPT_ENABLE);
  });

  test('maps wireCrypt "Required" to Firebird.WIRE_CRYPT_ENABLE (node-firebird has no separate "required" value)', function () {
    const opts = toNodeFirebirdOptions(baseConnection({ wireCrypt: 'Required' }));
    assert.strictEqual(opts.wireCrypt, Firebird.WIRE_CRYPT_ENABLE);
  });

  test('omits wireCrypt entirely when not set', function () {
    const opts = toNodeFirebirdOptions(baseConnection());
    assert.strictEqual('wireCrypt' in opts, false);
  });

  test('includes host/port for non-embedded connections', function () {
    const opts = toNodeFirebirdOptions(baseConnection());
    assert.strictEqual(opts.host, 'localhost');
    assert.strictEqual(opts.port, 3050);
  });

  test('omits host/port for embedded connections', function () {
    const opts = toNodeFirebirdOptions(baseConnection({ embedded: true }));
    assert.strictEqual(opts.host, undefined);
    assert.strictEqual(opts.port, undefined);
  });
});

// ── Driver.resolvePassword() ─────────────────────────────────────────────────
//
// Regression coverage for "Your user name and password are not defined":
// saved connections never carry a password (FirebirdTreeDataProvider strips
// it before persisting to globalState — passwords only live in
// SecretStorage), so any code that connects directly via
// Driver.client.createConnection() must resolve it first. This was missing
// from NodeTable/NodeView/NodeProcedure/NodeTrigger's direct-connect methods
// (e.g. expanding a table to list its columns), which failed whenever the
// in-memory ConnectionOptions hadn't already been resolved by something else
// first — see the "NodeTable password resolution" suite below for the
// end-to-end reproduction.

suite('Driver.resolvePassword()', function () {
  function baseConnection(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
    return {
      id: 'test',
      host: 'localhost',
      port: 3050,
      database: '/data/test.fdb',
      user: 'sysdba',
      password: undefined,
      role: null,
      ...overrides,
    };
  }

  test('returns the connection unchanged when it already has a password', async function () {
    const conn = baseConnection({ password: 'already-set' });
    const resolved = await Driver.resolvePassword(conn);
    assert.strictEqual(resolved.password, 'already-set');
  });

  test('fetches the password from CredentialStore when missing', async function () {
    CredentialStore.setContext(createMockContext() as any);
    await CredentialStore.storePassword('conn-x', 'secret123');

    const resolved = await Driver.resolvePassword(baseConnection({ id: 'conn-x' }));
    assert.strictEqual(resolved.password, 'secret123');
  });

  test('resolves to an empty string when no password is stored for that id', async function () {
    CredentialStore.setContext(createMockContext() as any);

    const resolved = await Driver.resolvePassword(baseConnection({ id: 'conn-with-no-stored-password' }));
    assert.strictEqual(resolved.password, '');
  });

  test('does not mutate the original ConnectionOptions object', async function () {
    CredentialStore.setContext(createMockContext() as any);
    await CredentialStore.storePassword('conn-y', 'secret456');

    const conn = baseConnection({ id: 'conn-y' });
    await Driver.resolvePassword(conn);
    assert.strictEqual(conn.password, undefined, 'the input object itself should be untouched');
  });
});

// ── Driver.runBatch() ────────────────────────────────────────────────────────
//
// A fake ClientI stands in for the real node-firebird/native connection, so
// these tests exercise the full split -> execute-per-statement -> assemble
// pipeline (including error isolation and connection lifecycle) without a
// live Firebird server.

type FakeResponder = (sql: string) => any[] | undefined | Promise<any[] | undefined>;

class FakeClient implements ClientI<any> {
  public createConnectionCalls = 0;
  public detachCalls = 0;
  public queries: string[] = [];

  constructor(private readonly responder: FakeResponder) {}

  async createConnection(_opts: ConnectionOptions): Promise<any> {
    this.createConnectionCalls++;
    return { id: this.createConnectionCalls };
  }

  async queryPromise<T extends object>(_connection: any, sql: string): Promise<T[]> {
    this.queries.push(sql);
    const result = await this.responder(sql);
    if (result === undefined) {
      return undefined as unknown as T[];
    }
    return result as T[];
  }

  async detach(_connection: any): Promise<void> {
    this.detachCalls++;
  }
}

function baseConnectionOptions(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    id: 'test',
    host: 'localhost',
    port: 3050,
    database: '/data/test.fdb',
    user: 'sysdba',
    password: 'masterkey',
    role: null,
    ...overrides,
  };
}

suite('Driver.runBatch() (fake client, no live database)', function () {
  const originalClient = Driver.client;

  teardown(function () {
    Driver.client = originalClient;
  });

  test('rejects when neither sql nor an active editor is available', async function () {
    Driver.client = new FakeClient(() => []);
    await assert.rejects(
      Driver.runBatch(undefined, baseConnectionOptions()),
      (err: any) => {
        assert.strictEqual(err.notify, true);
        assert.match(err.message, /No SQL document opened/);
        return true;
      }
    );
  });

  test('rejects when the SQL contains no valid statements', async function () {
    Driver.client = new FakeClient(() => []);
    await assert.rejects(
      Driver.runBatch('   ;  ;  ', baseConnectionOptions()),
      (err: any) => {
        assert.strictEqual(err.notify, false);
        assert.match(err.message, /No valid SQL commands found/);
        return true;
      }
    );
  });

  test('runs a single SELECT and returns one BatchResult with rows', async function () {
    const fake = new FakeClient(() => [{ ONE: 1 }]);
    Driver.client = fake;

    const results = await Driver.runBatch('SELECT 1 AS ONE FROM RDB$DATABASE;', baseConnectionOptions());

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].sql, 'SELECT 1 AS ONE FROM RDB$DATABASE');
    assert.deepStrictEqual(results[0].rows, [{ ONE: 1 }]);
    assert.strictEqual(results[0].error, undefined);
    assert.ok(results[0].durationMs >= 0);
    assert.strictEqual(fake.createConnectionCalls, 1, 'expected exactly one connection to be created');
    assert.strictEqual(fake.detachCalls, 1, 'expected the connection to be detached exactly once');
  });

  test('runs multiple statements and returns one BatchResult per statement, in order', async function () {
    const responses: Record<string, any[] | undefined> = {
      'SELECT 1 FROM RDB$DATABASE': [{ ONE: 1 }],
      'SELECT 2 FROM RDB$DATABASE': [{ TWO: 2 }],
    };
    const fake = new FakeClient(sql => responses[sql]);
    Driver.client = fake;

    const results = await Driver.runBatch(
      'SELECT 1 FROM RDB$DATABASE; SELECT 2 FROM RDB$DATABASE;',
      baseConnectionOptions()
    );

    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(results[0].rows, [{ ONE: 1 }]);
    assert.deepStrictEqual(results[1].rows, [{ TWO: 2 }]);
    assert.strictEqual(fake.createConnectionCalls, 1, 'a batch should reuse a single connection');
  });

  test('reports a DDL/DML statement (undefined rows) as a message result', async function () {
    const fake = new FakeClient(() => undefined);
    Driver.client = fake;

    const results = await Driver.runBatch('CREATE TABLE T (ID INTEGER);', baseConnectionOptions());

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].rows, undefined);
    assert.ok(results[0].message?.includes('Create'));
  });

  test('isolates a per-statement error without aborting the rest of the batch', async function () {
    const fake = new FakeClient(sql => {
      if (sql.includes('NOPE')) {
        throw new Error('table NOPE does not exist');
      }
      return [{ OK: 1 }];
    });
    Driver.client = fake;

    const results = await Driver.runBatch(
      'SELECT 1 AS OK FROM RDB$DATABASE; SELECT * FROM NOPE; SELECT 1 AS OK FROM RDB$DATABASE;',
      baseConnectionOptions()
    );

    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].error, undefined);
    assert.strictEqual(results[1].error, 'table NOPE does not exist');
    assert.strictEqual(results[1].rows, undefined);
    assert.strictEqual(results[2].error, undefined, 'the statement after the failing one should still run');
    assert.strictEqual(fake.queries.length, 3, 'all three statements should have been attempted');
  });

  test('detaches the connection even when a statement throws', async function () {
    const fake = new FakeClient(() => { throw new Error('boom'); });
    Driver.client = fake;

    await Driver.runBatch('SELECT 1;', baseConnectionOptions());

    assert.strictEqual(fake.detachCalls, 1);
  });

  test('runs a CREATE PROCEDURE (SET TERM) followed by a SELECT as two statements', async function () {
    const fake = new FakeClient(sql => {
      if (sql.startsWith('CREATE PROCEDURE')) { return undefined; }
      return [{ RESULT: 42 }];
    });
    Driver.client = fake;

    const sql = [
      'SET TERM ^ ;',
      'CREATE PROCEDURE MY_PROC AS',
      'BEGIN',
      '  SUSPEND;',
      'END^',
      'SET TERM ; ^',
      'SELECT * FROM MY_PROC;',
    ].join('\n');

    const results = await Driver.runBatch(sql, baseConnectionOptions());

    assert.strictEqual(results.length, 2, 'SET TERM lines must not be executed as statements');
    assert.ok(results[0].sql.startsWith('CREATE PROCEDURE MY_PROC'));
    assert.ok(results[0].message?.includes('Create'));
    assert.deepStrictEqual(results[1].rows, [{ RESULT: 42 }]);
  });
});

// ── Driver.runQuery() (fake client, no live database) ───────────────────────

suite('Driver.runQuery() (fake client, no live database)', function () {
  const originalClient = Driver.client;

  teardown(function () {
    Driver.client = originalClient;
  });

  test('rejects when neither sql nor an active editor is available', async function () {
    Driver.client = new FakeClient(() => []);
    await assert.rejects(
      Driver.runQuery(undefined, baseConnectionOptions()),
      (err: any) => {
        assert.strictEqual(err.notify, true);
        assert.match(err.message, /No SQL document opened/);
        return true;
      }
    );
  });

  test('returns rows for a SELECT', async function () {
    Driver.client = new FakeClient(() => [{ ONE: 1 }]);
    const rows = await Driver.runQuery('SELECT 1 AS ONE FROM RDB$DATABASE', baseConnectionOptions());
    assert.deepStrictEqual(rows, [{ ONE: 1 }]);
  });

  test('returns a success message for a DDL/DML statement (undefined rows)', async function () {
    Driver.client = new FakeClient(() => undefined);
    const result = await Driver.runQuery('DROP TABLE T', baseConnectionOptions());
    assert.ok(Array.isArray(result));
    assert.ok(result[0].message.includes('Drop'));
  });

  test('rejects and propagates the underlying error', async function () {
    Driver.client = new FakeClient(() => { throw new Error('connection refused'); });
    await assert.rejects(
      Driver.runQuery('SELECT 1', baseConnectionOptions()),
      /connection refused/
    );
  });

  test('detaches the connection even when the query throws', async function () {
    const fake = new FakeClient(() => { throw new Error('boom'); });
    Driver.client = fake;
    await Driver.runQuery('SELECT 1', baseConnectionOptions()).catch(() => { /* expected */ });
    assert.strictEqual(fake.detachCalls, 1);
  });
});

// ── Automatic session history logging ────────────────────────────────────────
//
// Driver.setHistoryLogger() is how extension.ts wires Driver's execution
// paths (runQuery/runBatch) up to QueryHistoryProvider — every query
// executed through Driver, whether typed by hand or triggered from a
// tree-node context-menu action (Select All Records, Drop Table, etc.),
// should be recorded automatically, including its connection context and
// whether it failed.

suite('Driver – automatic history logging', function () {
  const originalClient = Driver.client;
  const originalLogger = Driver.historyLogger;

  teardown(function () {
    Driver.client = originalClient;
    Driver.historyLogger = originalLogger;
  });

  test('runQuery logs a successful SELECT with row count and connection context', async function () {
    Driver.client = new FakeClient(() => [{ A: 1 }, { A: 2 }]);
    const logged: HistoryLogEntry[] = [];
    Driver.setHistoryLogger(e => logged.push(e));

    await Driver.runQuery('SELECT A FROM T', baseConnectionOptions({ id: 'conn-1', host: 'db1', database: '/data/one.fdb' }));

    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].sql, 'SELECT A FROM T');
    assert.strictEqual(logged[0].rowCount, 2);
    assert.strictEqual(logged[0].error, undefined);
    assert.strictEqual(logged[0].connectionId, 'conn-1');
    assert.strictEqual(logged[0].connectionLabel, 'db1:one.fdb');
    assert.ok(logged[0].durationMs >= 0);
  });

  test('runQuery logs a DDL/DML statement with no rowCount', async function () {
    Driver.client = new FakeClient(() => undefined);
    const logged: HistoryLogEntry[] = [];
    Driver.setHistoryLogger(e => logged.push(e));

    await Driver.runQuery('DROP TABLE T', baseConnectionOptions());

    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].rowCount, undefined);
    assert.strictEqual(logged[0].error, undefined);
  });

  test('runQuery logs a failed statement with the error message', async function () {
    Driver.client = new FakeClient(() => { throw new Error('table NOPE does not exist'); });
    const logged: HistoryLogEntry[] = [];
    Driver.setHistoryLogger(e => logged.push(e));

    await Driver.runQuery('SELECT * FROM NOPE', baseConnectionOptions()).catch(() => { /* expected */ });

    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].error, 'table NOPE does not exist');
    assert.strictEqual(logged[0].rowCount, undefined);
  });

  test('runBatch logs one history entry per statement', async function () {
    const fake = new FakeClient(sql => (sql.includes('NOPE') ? Promise.reject(new Error('nope')) : [{ OK: 1 }]));
    Driver.client = fake;
    const logged: HistoryLogEntry[] = [];
    Driver.setHistoryLogger(e => logged.push(e));

    await Driver.runBatch('SELECT 1 FROM T; SELECT * FROM NOPE;', baseConnectionOptions());

    assert.strictEqual(logged.length, 2);
    assert.strictEqual(logged[0].error, undefined);
    assert.strictEqual(logged[1].error, 'nope');
  });

  test('does not throw when no history logger is registered', async function () {
    Driver.client = new FakeClient(() => [{ A: 1 }]);
    Driver.historyLogger = undefined;
    await assert.doesNotReject(Driver.runQuery('SELECT 1', baseConnectionOptions()));
  });

  test('validation failures (no active connection/editor) are not logged', async function () {
    Driver.client = new FakeClient(() => []);
    const logged: HistoryLogEntry[] = [];
    Driver.setHistoryLogger(e => logged.push(e));

    await Driver.runQuery(undefined, undefined).catch(() => { /* expected */ });

    assert.strictEqual(logged.length, 0, 'nothing was actually executed, so nothing should be logged');
  });
});
