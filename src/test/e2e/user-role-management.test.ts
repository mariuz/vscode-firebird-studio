/**
 * End-to-end coverage for Firebird SQL-based user and role management (CREATE/ALTER/DROP USER,
 * CREATE ROLE): runs the actual query builders from shared/queries.ts against a real Firebird
 * server, then proves the created user can really log in with the password it was given (and
 * that a changed password actually takes effect), not just that the DDL statement didn't throw.
 *
 * CREATE/ALTER/DROP USER write to Firebird's *security* database, a separate file the server
 * attaches to internally — unlike ordinary DDL against the test database, so it can briefly
 * contend with the server's own startup initialization of that security database right after
 * the port starts accepting connections (which is all "Wait for Firebird to be ready" checks).
 * withRetry() below rides out that startup race; withTimeout() turns any other hang into a fast,
 * clearly-labeled failure instead of silently exhausting mocha's whole per-test timeout.
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

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[user-role-management e2e +${Date.now() - START}ms] ${message}`);
}
const START = Date.now();

/** Races a promise against a hard deadline so a hang fails fast with a clear label instead of silently eating the whole per-test timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

/** Retries an operation a few times with a short delay, for the brief window right after the server starts accepting connections where security-database operations can still be settling. */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5, delayMs = 2000): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      log(`${label}: attempt ${i}/${attempts}`);
      const result = await withTimeout(fn(), 8000, label);
      log(`${label}: succeeded on attempt ${i}`);
      return result;
    } catch (err) {
      lastErr = err;
      log(`${label}: attempt ${i} failed (${err instanceof Error ? err.message : err})`);
      if (i < attempts) { await new Promise(r => setTimeout(r, delayMs)); }
    }
  }
  throw lastErr;
}

suite('E2E – SQL-based user management (CREATE/ALTER/DROP USER)', function () {
  this.timeout(90000);

  let db: Firebird.Database;
  const userName = 'FS_TEST_USER';

  suiteSetup(async function () {
    db = await withTimeout(attach(baseOptions()), 15000, 'suiteSetup attach');
    try { await withTimeout(query(db, dropUserQuery(userName)), 8000, 'suiteSetup cleanup DROP USER'); } catch { /* didn't exist yet */ }
  });

  suiteTeardown(async function () {
    if (db) {
      try { await withTimeout(query(db, dropUserQuery(userName)), 8000, 'suiteTeardown cleanup DROP USER'); } catch { /* already gone */ }
      try { await withTimeout(detach(db), 8000, 'suiteTeardown detach'); } catch (err) { log(`suiteTeardown detach failed: ${err}`); }
    }
  });

  test('createUserQuery() actually creates a login that can authenticate', async function () {
    await withRetry(() => query(db, createUserQuery(userName, 'InitialPass1')), 'CREATE USER');

    const rows = await withTimeout(query<{ USER_NAME: string }>(db, getUsersQuery()), 8000, 'getUsersQuery after CREATE USER');
    const names = rows.map(r => r.USER_NAME.trim());
    assert.ok(names.includes(userName), `expected ${userName} among: ${names.join(', ')}`);

    const asNewUser = await withRetry(
      () => attach({ ...baseOptions(), user: userName, password: 'InitialPass1' }),
      'attach as newly-created user'
    );
    await withTimeout(detach(asNewUser), 8000, 'detach new-user connection');
  });

  test('alterUserPasswordQuery() actually changes the password used to authenticate', async function () {
    await withRetry(() => query(db, alterUserPasswordQuery(userName, 'ChangedPass2')), 'ALTER USER PASSWORD');

    await assert.rejects(
      () => withTimeout(attach({ ...baseOptions(), user: userName, password: 'InitialPass1' }), 8000, 'attach with old password'),
      'expected the old password to be rejected after changing it'
    );

    const asNewUser = await withRetry(
      () => attach({ ...baseOptions(), user: userName, password: 'ChangedPass2' }),
      'attach with new password'
    );
    await withTimeout(detach(asNewUser), 8000, 'detach new-password connection');
  });

  test('dropUserQuery() actually removes the login', async function () {
    await withRetry(() => query(db, dropUserQuery(userName)), 'DROP USER');

    const rows = await withTimeout(query<{ USER_NAME: string }>(db, getUsersQuery()), 8000, 'getUsersQuery after DROP USER');
    assert.ok(!rows.map(r => r.USER_NAME.trim()).includes(userName));

    await assert.rejects(
      () => withTimeout(attach({ ...baseOptions(), user: userName, password: 'ChangedPass2' }), 8000, 'attach as dropped user'),
      'expected the dropped user to no longer be able to authenticate'
    );
  });
});

suite('E2E – createRoleQuery()', function () {
  this.timeout(30000);

  let db: Firebird.Database;
  const roleName = 'FS_TEST_CREATED_ROLE';

  suiteSetup(async function () {
    db = await withTimeout(attach(baseOptions()), 15000, 'suiteSetup attach');
    try { await withTimeout(query(db, dropRoleQuery(roleName)), 8000, 'suiteSetup cleanup DROP ROLE'); } catch { /* didn't exist yet */ }
  });

  suiteTeardown(async function () {
    if (db) {
      try { await withTimeout(query(db, dropRoleQuery(roleName)), 8000, 'suiteTeardown cleanup DROP ROLE'); } catch { /* already gone */ }
      try { await withTimeout(detach(db), 8000, 'suiteTeardown detach'); } catch (err) { log(`suiteTeardown detach failed: ${err}`); }
    }
  });

  test('createRoleQuery() actually creates a role findable via getRolesQuery()', async function () {
    await withRetry(() => query(db, createRoleQuery(roleName)), 'CREATE ROLE');

    const rows = await withTimeout(query<{ ROLE_NAME: string }>(db, getRolesQuery()), 8000, 'getRolesQuery after CREATE ROLE');
    const names = rows.map(r => r.ROLE_NAME.trim());
    assert.ok(names.includes(roleName), `expected ${roleName} among: ${names.join(', ')}`);
  });
});
