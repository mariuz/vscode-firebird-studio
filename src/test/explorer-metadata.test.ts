/**
 * Roles, exceptions, and (opt-in) system tables in the DB Explorer tree —
 * covers the pure query builders in shared/queries.ts and the tree-item
 * shape of the new NodeRole/NodeException/NodeSystemTable classes.
 */

import * as assert from 'assert';
import {
  getRolesQuery,
  getExceptionsQuery,
  getSystemTablesQuery,
  dropRoleQuery,
  dropExceptionQuery,
} from '../shared/queries';
import { Driver, ClientI } from '../shared/driver';
import { NodeRole } from '../nodes/node-role';
import { NodeException } from '../nodes/node-exception';
import { NodeSystemTable } from '../nodes/node-system-table';
import { NodeField } from '../nodes/node-field';
import { NodeInfo } from '../nodes/node-info';
import { ConnectionOptions } from '../interfaces';
import { createMockContext } from './mocks/vscode';

class FakeClient implements ClientI<any> {
  async createConnection(_opts: ConnectionOptions): Promise<any> {
    return {};
  }
  async queryPromise<T extends object>(_connection: any, _sql: string): Promise<T[]> {
    return [{ FIELD_NAME: 'RDB$RELATION_NAME', FIELD_TYPE: 'VARCHAR', FIELD_LENGTH: 31 } as unknown as T];
  }
  async detach(_connection: any): Promise<void> {
    // no-op
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

suite('getRolesQuery / getExceptionsQuery / getSystemTablesQuery', function () {

  test('getRolesQuery reads RDB$ROLES and excludes system roles by default', function () {
    const sql = getRolesQuery();
    assert.ok(sql.includes('RDB$ROLES'), sql);
    assert.ok(sql.includes("RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0"), sql);
  });

  test('getExceptionsQuery reads RDB$EXCEPTIONS, name and message, excludes system exceptions', function () {
    const sql = getExceptionsQuery();
    assert.ok(sql.includes('RDB$EXCEPTIONS'), sql);
    assert.ok(sql.includes('RDB$EXCEPTION_NAME'), sql);
    assert.ok(sql.includes('RDB$MESSAGE'), sql);
    assert.ok(sql.includes("RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0"), sql);
  });

  test('getSystemTablesQuery reads RDB$RELATIONS filtered to system relations only (the inverse of getTablesQuery)', function () {
    const sql = getSystemTablesQuery();
    assert.ok(sql.includes('RDB$RELATIONS'), sql);
    assert.ok(sql.includes('RDB$SYSTEM_FLAG = 1'), sql);
    // Unlike the regular Tables query, this one deliberately does NOT exclude system rows.
    assert.ok(!sql.includes('RDB$SYSTEM_FLAG IS NULL'), sql);
  });

  test('dropRoleQuery / dropExceptionQuery produce the expected DDL', function () {
    assert.strictEqual(dropRoleQuery('APP_ADMIN'), 'DROP ROLE APP_ADMIN;');
    assert.strictEqual(dropExceptionQuery('INSUFFICIENT_FUNDS'), 'DROP EXCEPTION INSUFFICIENT_FUNDS;');
  });
});

// ── NodeRole / NodeException tree items ─────────────────────────────────────

suite('NodeRole / NodeException tree item shape', function () {
  const context = createMockContext();

  test('NodeRole exposes its name, a "role" contextValue, and no children', function () {
    const node = new NodeRole('  APP_ADMIN  ', connection());
    const item = node.getTreeItem(context as any);

    assert.strictEqual(item.label, 'APP_ADMIN');
    assert.strictEqual(item.contextValue, 'role');
    assert.deepStrictEqual(node.getChildren(), []);
  });

  test('NodeException surfaces its message in the tooltip', function () {
    const node = new NodeException(
      { EXCEPTION_NAME: 'INSUFFICIENT_FUNDS', MESSAGE: 'Account balance is too low' },
      connection()
    );
    const item = node.getTreeItem(context as any);

    assert.strictEqual(item.label, 'INSUFFICIENT_FUNDS');
    assert.strictEqual(item.contextValue, 'exception');
    assert.ok(String(item.tooltip).includes('Account balance is too low'), String(item.tooltip));
  });

  test('NodeException tolerates a missing message', function () {
    const node = new NodeException({ EXCEPTION_NAME: 'NO_MESSAGE', MESSAGE: null }, connection());
    const item = node.getTreeItem(context as any);

    assert.strictEqual(item.label, 'NO_MESSAGE');
    assert.ok(!String(item.tooltip).includes('null'));
  });
});

// ── NodeSystemTable ──────────────────────────────────────────────────────────

suite('NodeSystemTable (opt-in "System Tables" folder)', function () {
  const originalClient = Driver.client;

  teardown(function () {
    Driver.client = originalClient;
  });

  test('getTreeItem() uses a "systemTable" contextValue, distinct from regular tables', function () {
    const context = createMockContext();
    const node = new NodeSystemTable(connection(), 'RDB$RELATIONS');
    const item = node.getTreeItem(context as any);

    assert.strictEqual(item.label, 'RDB$RELATIONS');
    assert.strictEqual(item.contextValue, 'systemTable');
    assert.strictEqual(node.getTableName(), 'RDB$RELATIONS');
  });

  test('getChildren() lists columns the same way NodeTable does', async function () {
    Driver.client = new FakeClient();
    const node = new NodeSystemTable(connection(), 'RDB$RELATIONS');

    const children = await node.getChildren();

    assert.strictEqual(children.length, 1);
    assert.ok(children[0] instanceof NodeField, `expected NodeField, got: ${children[0]}`);
  });

  test('getChildren() falls back to NodeInfo on a query error', async function () {
    Driver.client = {
      async createConnection() { throw new Error('connection refused'); },
      async queryPromise() { return []; },
      async detach() { /* no-op */ },
    } as unknown as ClientI<any>;

    const node = new NodeSystemTable(connection(), 'RDB$RELATIONS');
    const children = await node.getChildren();

    assert.strictEqual(children.length, 1);
    assert.ok(children[0] instanceof NodeInfo);
  });
});
