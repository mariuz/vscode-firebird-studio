/**
 * End-to-end coverage for Firebird SQL-based user and role management (CREATE/ALTER/DROP USER,
 * CREATE ROLE): runs the actual query builders from shared/queries.ts against a real Firebird
 * server and confirms SEC$USERS/RDB$ROLES reflect each change — the same thing the extension's
 * own Users/Roles tree folders do (NodeDatabase#getUserChildren/#getRoleChildren).
 *
 * Deliberately does NOT try to log in *as* a newly created/altered user to prove its password:
 * that hit a real, 100%-reproducible hang in node-firebird's pure-JS driver (the wire-protocol
 * auth handshake against a SQL-CREATE USER-created login never completes — neither success nor
 * error — while the exact same driver, config, and server authenticate the seeded SYSDBA
 * connection instantly). That's a limitation in the vendored dependency's auth negotiation, not
 * in this extension's query-building logic — the extension itself never authenticates as a user
 * other than the one already configured on the active connection, so this suite sticks to
 * verifying what the extension actually does: that CREATE/ALTER/DROP USER run cleanly against a
 * real server and that SEC$USERS reflects the result.
 *
 * Same connection env vars as firebird-connection.test.ts:
 *   FIREBIRD_HOST / FIREBIRD_PORT / FIREBIRD_DATABASE / FIREBIRD_USER / FIREBIRD_PASSWORD
 */

import * as assert from 'assert';
import * as Firebird from 'node-firebird';
import {
  getUsersQuery,
  createUserQuery,
  alterUserPasswordQuery,
  dropUserQuery,
  getRolesQuery,
  createRoleQuery,
  dropRoleQuery,
} from '../../shared/queries';

function baseOptions(): Firebird.Options {
  return {
    host:      process.env.FIREBIRD_HOST     ?? 'localhost',
    port:      Number(process.env.FIREBIRD_PORT ?? '3050'),
    database:  process.env.FIREBIRD_DATABASE ?? '/var/lib/firebird/data/test.fdb',
    user:      process.env.FIREBIRD_USER     ?? 'sysdba',
    password:  process.env.FIREBIRD_PASSWORD ?? 'masterkey',
    wireCrypt: Firebird.WIRE_CRYPT_DISABLE,
  };
}

function attach(options: Firebird.Options): Promise<Firebird.Database> {
  return new Promise<Firebird.Database>((resolve, reject) => {
    Firebird.attach(options, (err, db) => {
      if (err) { reject(err); } else { resolve(db); }
    });
  });
}

function query<T = any>(db: Firebird.Database, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    db.query(sql, params, (err: any, rows: T[]) => {
      if (err) { reject(err); } else { resolve(rows); }
    });
  });
}

function detach(db: Firebird.Database): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    db.detach((err: any) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });
}

suite('E2E – SQL-based user management (CREATE/ALTER/DROP USER)', function () {
  this.timeout(20000);

  let db: Firebird.Database;
  const userName = 'FS_TEST_USER';

  suiteSetup(async function () {
    db = await attach(baseOptions());
    try { await query(db, dropUserQuery(userName)); } catch { /* didn't exist yet */ }
  });

  suiteTeardown(async function () {
    if (db) {
      try { await query(db, dropUserQuery(userName)); } catch { /* already gone */ }
      await detach(db);
    }
  });

  test('createUserQuery() actually creates a login visible in SEC$USERS', async function () {
    await query(db, createUserQuery(userName, 'InitialPass1'));

    const rows = await query<{ USER_NAME: string }>(db, getUsersQuery());
    const names = rows.map(r => r.USER_NAME.trim());
    assert.ok(names.includes(userName), `expected ${userName} among: ${names.join(', ')}`);
  });

  test('alterUserPasswordQuery() runs cleanly against a real server', async function () {
    await query(db, alterUserPasswordQuery(userName, 'ChangedPass2'));

    // ALTER USER doesn't change SEC$USER_NAME's visibility — just confirms the user is still
    // there and the statement didn't error (a bad USER_NAME would throw "record not found").
    const rows = await query<{ USER_NAME: string }>(db, getUsersQuery());
    assert.ok(rows.map(r => r.USER_NAME.trim()).includes(userName));
  });

  test('dropUserQuery() actually removes the login from SEC$USERS', async function () {
    await query(db, dropUserQuery(userName));

    const rows = await query<{ USER_NAME: string }>(db, getUsersQuery());
    assert.ok(!rows.map(r => r.USER_NAME.trim()).includes(userName));
  });
});

suite('E2E – createRoleQuery()', function () {
  this.timeout(15000);

  let db: Firebird.Database;
  const roleName = 'FS_TEST_CREATED_ROLE';

  suiteSetup(async function () {
    db = await attach(baseOptions());
    try { await query(db, dropRoleQuery(roleName)); } catch { /* didn't exist yet */ }
  });

  suiteTeardown(async function () {
    if (db) {
      try { await query(db, dropRoleQuery(roleName)); } catch { /* already gone */ }
      await detach(db);
    }
  });

  test('createRoleQuery() actually creates a role findable via getRolesQuery()', async function () {
    await query(db, createRoleQuery(roleName));

    const rows = await query<{ ROLE_NAME: string }>(db, getRolesQuery());
    const names = rows.map(r => r.ROLE_NAME.trim());
    assert.ok(names.includes(roleName), `expected ${roleName} among: ${names.join(', ')}`);
  });
});
