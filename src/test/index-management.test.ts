/**
 * Index management: query builders (src/shared/queries.ts), NodeIndex/NodeIndexFolder's tree-item
 * shape, and a regression test for NodeTable.generateMockData() — adding a trailing "Indexes"
 * folder to NodeTable.getChildren()'s result meant generateMockData()'s existing (any-typed)
 * "every child has a .field" assumption would otherwise throw on that new non-field sibling.
 */

import * as assert from 'assert';
import {
  getIndexesQuery,
  createIndexQuery,
  dropIndexQuery,
} from '../shared/queries';
import { Driver, ClientI } from '../shared/driver';
import { NodeTable } from '../nodes/node-table';
import { NodeField } from '../nodes/node-field';
import { NodeIndex, NodeIndexFolder } from '../nodes/node-index';
import { ConnectionOptions, Options } from '../interfaces';
import MockData, { MockField } from '../mock-data/mock-data';
import { createMockContext } from './mocks/vscode';

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

suite('getIndexesQuery / createIndexQuery / dropIndexQuery', function () {

  test('getIndexesQuery excludes constraint-backed and system indexes', function () {
    const sql = getIndexesQuery('CUSTOMERS');
    assert.ok(sql.includes('RDB$INDICES'));
    assert.ok(sql.includes("rc.RDB$CONSTRAINT_NAME IS NULL"), 'expected constraint-backed indexes to be excluded');
    assert.ok(sql.includes('RDB$SYSTEM_FLAG'));
    assert.ok(sql.includes("TRIM(i.RDB$RELATION_NAME) = 'CUSTOMERS'"));
  });

  test('createIndexQuery builds a regular multi-column index', function () {
    const sql = createIndexQuery('IDX_NAME_EMAIL', 'CUSTOMERS', ['LAST_NAME', 'FIRST_NAME'], false);
    assert.strictEqual(sql, 'CREATE INDEX IDX_NAME_EMAIL ON CUSTOMERS (LAST_NAME, FIRST_NAME);');
  });

  test('createIndexQuery builds a UNIQUE index', function () {
    const sql = createIndexQuery('IDX_EMAIL_UNIQUE', 'CUSTOMERS', ['EMAIL'], true);
    assert.strictEqual(sql, 'CREATE UNIQUE INDEX IDX_EMAIL_UNIQUE ON CUSTOMERS (EMAIL);');
  });

  test('createIndexQuery rejects an unsafe index name instead of interpolating it unescaped', function () {
    assert.throws(() => createIndexQuery('X; DROP TABLE CUSTOMERS', 'CUSTOMERS', ['ID'], false), /Invalid index name/);
  });

  test('createIndexQuery rejects an unsafe table name', function () {
    assert.throws(() => createIndexQuery('IDX_X', 'bad table', ['ID'], false), /Invalid table name/);
  });

  test('createIndexQuery rejects an unsafe column name', function () {
    assert.throws(() => createIndexQuery('IDX_X', 'CUSTOMERS', ['ID; DROP TABLE X'], false), /Invalid column name/);
  });

  test('createIndexQuery requires at least one column', function () {
    assert.throws(() => createIndexQuery('IDX_X', 'CUSTOMERS', [], false), /At least one column is required/);
  });

  test('dropIndexQuery produces the expected DDL and validates the identifier', function () {
    assert.strictEqual(dropIndexQuery('IDX_NAME_EMAIL'), 'DROP INDEX IDX_NAME_EMAIL;');
    assert.throws(() => dropIndexQuery('bad name'), /Invalid index name/);
  });
});

// ── NodeIndex / NodeIndexFolder tree items ──────────────────────────────────

suite('NodeIndex / NodeIndexFolder tree item shape', function () {
  const context = createMockContext();

  test('NodeIndexFolder exposes the table name and a "folder.indexes" contextValue', function () {
    const folder = new NodeIndexFolder(connection(), 'CUSTOMERS');
    const item = folder.getTreeItem(context as any);

    assert.strictEqual(item.label, 'Indexes');
    assert.strictEqual(item.contextValue, 'folder.indexes');
    assert.strictEqual(folder.getTableName(), 'CUSTOMERS');
  });

  test('NodeIndex shows its name, columns, and uniqueness in the label/tooltip', function () {
    const node = new NodeIndex(
      { INDEX_NAME: 'IDX_EMAIL', IS_UNIQUE: 1, IS_ACTIVE: 1, COLUMNS: 'EMAIL' },
      connection(),
      'CUSTOMERS'
    );
    const item = node.getTreeItem(context as any);

    assert.strictEqual(item.label, 'IDX_EMAIL (EMAIL)');
    assert.strictEqual(item.contextValue, 'index');
    assert.ok(String(item.tooltip).includes('UNIQUE'));
    assert.ok(String(item.tooltip).includes('CUSTOMERS'));
    assert.deepStrictEqual(node.getChildren(), []);
  });

  test('NodeIndex marks an inactive index in its label', function () {
    const node = new NodeIndex(
      { INDEX_NAME: 'IDX_OLD', IS_UNIQUE: 0, IS_ACTIVE: 0, COLUMNS: 'LEGACY_COL' },
      connection(),
      'CUSTOMERS'
    );
    const item = node.getTreeItem(context as any);

    assert.strictEqual(item.label, 'IDX_OLD (LEGACY_COL) (inactive)');
  });
});

// ── NodeTable.generateMockData() regression ─────────────────────────────────

class FakeFieldClient implements ClientI<any> {
  async createConnection(_opts: ConnectionOptions): Promise<any> {
    return {};
  }
  async queryPromise<T extends object>(_connection: any, _sql: string): Promise<T[]> {
    return [
      { FIELD_NAME: 'ID', FIELD_TYPE: 'INTEGER', FIELD_LENGTH: 4, NOT_NULL: 1 } as unknown as T,
      { FIELD_NAME: 'NAME', FIELD_TYPE: 'VARCHAR', FIELD_LENGTH: 100, NOT_NULL: 0 } as unknown as T,
    ];
  }
  async detach(_connection: any): Promise<void> {
    // no-op
  }
}

suite('NodeTable.generateMockData() ignores the trailing Indexes folder', function () {
  const originalClient = Driver.client;

  teardown(function () {
    Driver.client = originalClient;
  });

  test('only NodeField children are turned into MockField entries, not the NodeIndexFolder sibling', async function () {
    Driver.client = new FakeFieldClient();
    const table = new NodeTable(connection(), 'CUSTOMERS');

    // Sanity check: getChildren() really does mix NodeField[] with a trailing NodeIndexFolder.
    const children = await table.getChildren();
    assert.strictEqual(children.length, 3);
    assert.ok(children[0] instanceof NodeField);
    assert.ok(children[1] instanceof NodeField);
    assert.ok(children[2] instanceof NodeIndexFolder);

    let captured: MockField[] | undefined;
    const fakeMockData = {
      display: (_table: string, fields: MockField[], _apiKey: string) => { captured = fields; }
    } as unknown as MockData;

    await table.generateMockData(fakeMockData, { mockarooApiKey: 'fake-key' } as Options);

    assert.ok(captured, 'expected MockData.display() to be called');
    assert.strictEqual(captured!.length, 2, `expected exactly the 2 real columns, got: ${JSON.stringify(captured)}`);
    assert.deepStrictEqual(captured!.map(f => f.name), ['ID', 'NAME']);
  });
});
