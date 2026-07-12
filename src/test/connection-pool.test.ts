/**
 * Unit tests for PooledClient, using a fake ClientI (no real Firebird connection).
 */

import * as assert from 'assert';
import { PooledClient } from '../shared/connection-pool';
import { ClientI } from '../shared/driver';
import { ConnectionOptions } from '../interfaces';

interface FakeConnection {
  n: number;
  isValid?: boolean;
}

class FakeClient implements ClientI<any> {
  public createConnectionCalls = 0;
  public detachCalls: FakeConnection[] = [];

  async createConnection(_opts: ConnectionOptions): Promise<FakeConnection> {
    this.createConnectionCalls++;
    return { n: this.createConnectionCalls, isValid: true };
  }

  async queryPromise<T extends object>(_connection: FakeConnection, _sql: string): Promise<T[]> {
    return [] as T[];
  }

  async detach(connection: FakeConnection): Promise<void> {
    this.detachCalls.push(connection);
  }
}

function baseConnection(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    id: 'conn-a',
    host: 'localhost',
    port: 3050,
    database: '/data/test.fdb',
    user: 'sysdba',
    password: 'masterkey',
    role: null,
    ...overrides,
  };
}

suite('PooledClient', function () {

  test('reuses a detached connection instead of opening a new one', async function () {
    const inner = new FakeClient();
    const pool = new PooledClient<any>(inner, { maxSize: 5, idleTimeoutMs: 60000 });

    const conn1 = await pool.createConnection(baseConnection());
    await pool.detach(conn1);
    const conn2 = await pool.createConnection(baseConnection());

    assert.strictEqual(inner.createConnectionCalls, 1, 'should not have opened a second connection');
    assert.strictEqual(conn1, conn2, 'should hand back the same pooled connection object');

    await pool.shutdown();
  });

  test('does not share connections between different connection ids', async function () {
    const inner = new FakeClient();
    const pool = new PooledClient<any>(inner, { maxSize: 5, idleTimeoutMs: 60000 });

    const connA = await pool.createConnection(baseConnection({ id: 'conn-a' }));
    await pool.detach(connA);
    const connB = await pool.createConnection(baseConnection({ id: 'conn-b' }));

    assert.strictEqual(inner.createConnectionCalls, 2);
    assert.notStrictEqual(connA, connB);

    await pool.shutdown();
  });

  test('closes the connection for real once the idle pool for that id is full', async function () {
    const inner = new FakeClient();
    const pool = new PooledClient<any>(inner, { maxSize: 1, idleTimeoutMs: 60000 });

    const conn1 = await pool.createConnection(baseConnection());
    const conn2 = await pool.createConnection(baseConnection());

    await pool.detach(conn1); // fills the single idle slot
    await pool.detach(conn2); // pool already full for this id -> real detach

    assert.strictEqual(pool.idleCount('conn-a'), 1);
    assert.deepStrictEqual(inner.detachCalls, [conn2]);

    await pool.shutdown();
  });

  test('does not reuse a connection that has gone invalid, and closes it for real', async function () {
    const inner = new FakeClient();
    const pool = new PooledClient<any>(inner, { maxSize: 5, idleTimeoutMs: 60000 });

    const conn1 = await pool.createConnection(baseConnection());
    await pool.detach(conn1);
    conn1.isValid = false; // e.g. the server closed the attachment while it sat idle

    const conn2 = await pool.createConnection(baseConnection());

    assert.strictEqual(inner.createConnectionCalls, 2, 'should have opened a fresh connection');
    assert.deepStrictEqual(inner.detachCalls, [conn1], 'the dead connection should have been closed for real');
    assert.notStrictEqual(conn1, conn2);

    await pool.shutdown();
  });

  test('evictIdle() closes connections that have been idle past the timeout', async function () {
    const inner = new FakeClient();
    const pool = new PooledClient<any>(inner, { maxSize: 5, idleTimeoutMs: 1000 });

    const conn1 = await pool.createConnection(baseConnection());
    const detachedAt = Date.now();
    await pool.detach(conn1);

    await pool.evictIdle(detachedAt + 500); // well within the timeout
    assert.strictEqual(pool.idleCount('conn-a'), 1, 'not stale yet');

    await pool.evictIdle(detachedAt + 5000); // now well past the timeout
    assert.strictEqual(pool.idleCount('conn-a'), 0);
    assert.deepStrictEqual(inner.detachCalls, [conn1]);

    await pool.shutdown();
  });

  test('shutdown() closes every idle connection and stops the sweep timer', async function () {
    const inner = new FakeClient();
    const pool = new PooledClient<any>(inner, { maxSize: 5, idleTimeoutMs: 60000 });

    const connA = await pool.createConnection(baseConnection({ id: 'conn-a' }));
    const connB = await pool.createConnection(baseConnection({ id: 'conn-b' }));
    await pool.detach(connA);
    await pool.detach(connB);

    await pool.shutdown();

    assert.strictEqual(pool.idleCount('conn-a'), 0);
    assert.strictEqual(pool.idleCount('conn-b'), 0);
    assert.strictEqual(inner.detachCalls.length, 2);
  });
});
