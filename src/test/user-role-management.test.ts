/**
 * User and role management: query builders (src/shared/queries.ts), NodeUser's tree-item shape,
 * and — critically — that creating/changing a user's password never lands in session query
 * history or the output channel log. Driver.runQuery()/runBatch() log the exact SQL text of
 * every statement they execute; CREATE/ALTER USER's PASSWORD clause has no parameterized-query
 * equivalent (it's DDL), so the plaintext password lives directly in that SQL text. NodeUser's
 * createUser()/changePassword() connect via Driver.client directly instead, the same way
 * NodeDatabase's tree-population queries do, specifically to stay off that logging path.
 */

import * as assert from 'assert';
import {
  getUsersQuery,
  createUserQuery,
  alterUserPasswordQuery,
  dropUserQuery,
  createRoleQuery,
} from '../shared/queries';
import { Driver, ClientI, HistoryLogEntry } from '../shared/driver';
import { NodeUser } from '../nodes/node-user';
import { NodeRole } from '../nodes/node-role';
import { ConnectionOptions } from '../interfaces';
import { createMockContext } from './mocks/vscode';

class RecordingClient implements ClientI<any> {
  public queries: string[] = [];
  public detached = false;

  async createConnection(_opts: ConnectionOptions): Promise<any> {
    return {};
  }

  async queryPromise<T extends object>(_connection: any, sql: string): Promise<T[]> {
    this.queries.push(sql);
    // Mirrors node-firebird's real behavior for a successful DDL statement (no result set).
    return undefined as unknown as T[];
  }

  async detach(_connection: any): Promise<void> {
    this.detached = true;
  }
}

function connection(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    id: 'saved-conn',
    host: 'localhost',
    port: 3050,
    database: '/data/employee.fdb',
    user: 'sysdba',
    password: 'masterkey',
    role: null,
    ...overrides,
  };
}

// ── Query builders ──────────────────────────────────────────────────────────

suite('getUsersQuery / createUserQuery / alterUserPasswordQuery / dropUserQuery / createRoleQuery', function () {

  test('getUsersQuery reads SEC$USERS', function () {
    assert.ok(getUsersQuery().includes('SEC$USERS'));
  });

  test('createUserQuery embeds the username and password', function () {
    const sql = createUserQuery('APP_USER', 'hunter2');
    assert.strictEqual(sql, "CREATE USER APP_USER PASSWORD 'hunter2';");
  });

  test('createUserQuery escapes embedded single quotes in the password', function () {
    const sql = createUserQuery('APP_USER', `it's"me`);
    assert.strictEqual(sql, `CREATE USER APP_USER PASSWORD 'it''s"me';`);
  });

  test('createUserQuery rejects an unsafe username instead of interpolating it unescaped', function () {
    assert.throws(() => createUserQuery('APP_USER; DROP DATABASE', 'pw'), /Invalid user name/);
  });

  test('alterUserPasswordQuery embeds the username and new password', function () {
    const sql = alterUserPasswordQuery('APP_USER', 'newpass');
    assert.strictEqual(sql, "ALTER USER APP_USER PASSWORD 'newpass';");
  });

  test('alterUserPasswordQuery escapes embedded single quotes', function () {
    const sql = alterUserPasswordQuery('APP_USER', `o'brien`);
    assert.strictEqual(sql, `ALTER USER APP_USER PASSWORD 'o''brien';`);
  });

  test('alterUserPasswordQuery rejects an unsafe username', function () {
    assert.throws(() => alterUserPasswordQuery('bad name', 'pw'), /Invalid user name/);
  });

  test('dropUserQuery produces the expected DDL and validates the identifier', function () {
    assert.strictEqual(dropUserQuery('APP_USER'), 'DROP USER APP_USER;');
    assert.throws(() => dropUserQuery('bad name'), /Invalid user name/);
  });

  test('createRoleQuery produces the expected DDL and validates the identifier', function () {
    assert.strictEqual(createRoleQuery('APP_ADMIN'), 'CREATE ROLE APP_ADMIN;');
    assert.throws(() => createRoleQuery('bad name'), /Invalid role name/);
  });
});

// ── NodeUser tree item ───────────────────────────────────────────────────────

suite('NodeUser tree item shape', function () {

  test('exposes its name, a "user" contextValue, and no children', function () {
    const context = createMockContext();
    const node = new NodeUser('  APP_USER  ', connection());
    const item = node.getTreeItem(context as any);

    assert.strictEqual(item.label, 'APP_USER');
    assert.strictEqual(item.contextValue, 'user');
    assert.deepStrictEqual(node.getChildren(), []);
  });
});

// ── Password-sensitive operations must bypass query-history logging ────────

suite('User creation/password changes never reach session query history', function () {
  const originalClient = Driver.client;
  const originalLogger = Driver.historyLogger;

  teardown(function () {
    Driver.client = originalClient;
    Driver.historyLogger = originalLogger;
  });

  test('NodeUser.createUser() connects directly and logs nothing to history', async function () {
    const fake = new RecordingClient();
    Driver.client = fake;
    const logged: HistoryLogEntry[] = [];
    Driver.setHistoryLogger(entry => logged.push(entry));

    await NodeUser.createUser(connection(), 'APP_USER', 'topsecret');

    assert.strictEqual(logged.length, 0, 'expected the CREATE USER statement to never reach history logging');
    assert.strictEqual(fake.queries.length, 1);
    assert.ok(fake.queries[0].includes("CREATE USER APP_USER PASSWORD 'topsecret'"));
    assert.ok(fake.detached, 'expected the direct connection to be detached afterwards');
  });

  test('NodeUser#changePassword() connects directly and logs nothing to history', async function () {
    const fake = new RecordingClient();
    Driver.client = fake;
    const logged: HistoryLogEntry[] = [];
    Driver.setHistoryLogger(entry => logged.push(entry));

    const user = new NodeUser('APP_USER', connection());
    await user.changePassword('newsecret');

    assert.strictEqual(logged.length, 0, 'expected the ALTER USER statement to never reach history logging');
    assert.strictEqual(fake.queries.length, 1);
    assert.ok(fake.queries[0].includes("ALTER USER APP_USER PASSWORD 'newsecret'"));
  });

  test('by contrast, NodeRole.createRole() (no secret involved) goes through the normal, logged path', async function () {
    const fake = new RecordingClient();
    Driver.client = fake;
    const logged: HistoryLogEntry[] = [];
    Driver.setHistoryLogger(entry => logged.push(entry));

    await NodeRole.createRole(connection(), 'APP_ADMIN');

    assert.strictEqual(logged.length, 1, 'expected the CREATE ROLE statement to go through the normal logged path');
    assert.ok(logged[0].sql.includes('CREATE ROLE APP_ADMIN'));
  });
});
