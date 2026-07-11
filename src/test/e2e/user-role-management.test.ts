/**
 * End-to-end coverage for Firebird SQL-based user and role management (CREATE/ALTER/DROP USER,
 * CREATE ROLE): runs the actual query builders from shared/queries.ts against a real Firebird
 * server, then proves the created user can really log in with the password it was given (and
 * that a changed password actually takes effect), not just that the DDL statement didn't throw.
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

  test('createUserQuery() actually creates a login that can authenticate', async function () {
    await query(db, createUserQuery(userName, 'InitialPass1'));

    const rows = await query<{ USER_NAME: string }>(db, getUsersQuery());
    const names = rows.map(r => r.USER_NAME.trim());
    assert.ok(names.includes(userName), `expected ${userName} among: ${names.join(', ')}`);

    const asNewUser = await attach({ ...baseOptions(), user: userName, password: 'InitialPass1' });
    await detach(asNewUser);
  });

  test('alterUserPasswordQuery() actually changes the password used to authenticate', async function () {
    await query(db, alterUserPasswordQuery(userName, 'ChangedPass2'));

    await assert.rejects(
      () => attach({ ...baseOptions(), user: userName, password: 'InitialPass1' }),
      'expected the old password to be rejected after changing it'
    );

    const asNewUser = await attach({ ...baseOptions(), user: userName, password: 'ChangedPass2' });
    await detach(asNewUser);
  });

  test('dropUserQuery() actually removes the login', async function () {
    await query(db, dropUserQuery(userName));

    const rows = await query<{ USER_NAME: string }>(db, getUsersQuery());
    assert.ok(!rows.map(r => r.USER_NAME.trim()).includes(userName));

    await assert.rejects(
      () => attach({ ...baseOptions(), user: userName, password: 'ChangedPass2' }),
      'expected the dropped user to no longer be able to authenticate'
    );
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
