/**
 * Extension Development Host integration tests for directly editing query
 * results (update/insert/delete a row) against a real Firebird server.
 *
 * src/test/row-edit.test.ts covers the SQL-building logic in isolation; these
 * tests drive the exact same builders end to end — creating a temporary
 * table, applying changes through Driver.runQuery() the same way
 * src/result-view/index.ts#handleApplyChanges does, and verifying the data
 * actually changed in the database (and, for the PK-based path, that a
 * primary key fetched via getPrimaryKeyColumnsQuery() correctly targets a
 * single row).
 */

import * as assert from 'assert';
import { Driver, NodeClient } from '../../shared/driver';
import { getPrimaryKeyColumnsQuery } from '../../shared/queries';
import { buildStatementForChange, RowChange } from '../../shared/row-edit';
import { getTestConnectionOptions } from './firebird-test-env';

const TABLE = 'ROW_EDIT_IT';
const COLUMNS = ['ID', 'NAME', 'PRICE'];

suite('Row editing (update/insert/delete) – real Firebird integration', function () {
  this.timeout(20000);

  const conn = getTestConnectionOptions();

  suiteSetup(async function () {
    Driver.client = new NodeClient();
    await Driver.runQuery(
      'CREATE TABLE ROW_EDIT_IT (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(50), PRICE NUMERIC(10,2))',
      conn
    );
  });

  suiteTeardown(async function () {
    await Driver.runQuery('DROP TABLE ROW_EDIT_IT', conn).catch(() => { /* best-effort cleanup */ });
  });

  setup(async function () {
    await Driver.runQuery('DELETE FROM ROW_EDIT_IT', conn);
    await Driver.runQuery("INSERT INTO ROW_EDIT_IT (ID, NAME, PRICE) VALUES (1, 'Widget A', 9.99)", conn);
    await Driver.runQuery("INSERT INTO ROW_EDIT_IT (ID, NAME, PRICE) VALUES (2, 'Widget B', 19.99)", conn);
  });

  test('getPrimaryKeyColumnsQuery finds the real primary key', async function () {
    const rows = await Driver.runQuery(getPrimaryKeyColumnsQuery(TABLE), conn);
    assert.deepStrictEqual(rows.map((r: any) => r.FIELD_NAME.trim()), ['ID']);
  });

  test('an update change actually changes the row, targeted by primary key', async function () {
    const change: RowChange = {
      type: 'update',
      originalRow: ['1', 'Widget A', '9.99'],
      values: [{ colIndex: 1, value: 'Widget A (renamed)' }],
    };
    const sql = buildStatementForChange(TABLE, COLUMNS, ['ID'], change);
    await Driver.runQuery(sql, conn);

    const rows = await Driver.runQuery('SELECT NAME FROM ROW_EDIT_IT WHERE ID = 1', conn);
    assert.strictEqual(rows[0].NAME.trim(), 'Widget A (renamed)');

    // The other row must be untouched.
    const other = await Driver.runQuery('SELECT NAME FROM ROW_EDIT_IT WHERE ID = 2', conn);
    assert.strictEqual(other[0].NAME.trim(), 'Widget B');
  });

  test('an update change with no known primary key falls back to matching every column', async function () {
    const change: RowChange = {
      type: 'update',
      originalRow: ['2', 'Widget B', '19.99'],
      values: [{ colIndex: 2, value: '24.99' }],
    };
    const sql = buildStatementForChange(TABLE, COLUMNS, [], change); // no PK columns supplied
    assert.ok(sql.includes('ID = 2') && sql.includes("NAME = 'Widget B'"), sql);
    await Driver.runQuery(sql, conn);

    const rows = await Driver.runQuery('SELECT PRICE FROM ROW_EDIT_IT WHERE ID = 2', conn);
    assert.strictEqual(Number(rows[0].PRICE), 24.99);
  });

  test('an insert change adds a new row with only the supplied columns', async function () {
    const change: RowChange = {
      type: 'insert',
      values: [
        { colIndex: 0, value: '3' },
        { colIndex: 1, value: 'Gizmo' },
      ],
    };
    const sql = buildStatementForChange(TABLE, COLUMNS, ['ID'], change);
    await Driver.runQuery(sql, conn);

    const rows = await Driver.runQuery('SELECT ID, NAME, PRICE FROM ROW_EDIT_IT WHERE ID = 3', conn);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].NAME.trim(), 'Gizmo');
    assert.strictEqual(rows[0].PRICE, null);
  });

  test('a delete change removes exactly the targeted row', async function () {
    const change: RowChange = { type: 'delete', originalRow: ['1', 'Widget A', '9.99'] };
    const sql = buildStatementForChange(TABLE, COLUMNS, ['ID'], change);
    await Driver.runQuery(sql, conn);

    const remaining = await Driver.runQuery('SELECT ID FROM ROW_EDIT_IT ORDER BY ID', conn);
    assert.deepStrictEqual(remaining.map((r: any) => r.ID), [2]);
  });

  test('applying update, insert, and delete changes together leaves the table in the expected state', async function () {
    const changes: RowChange[] = [
      { type: 'update', originalRow: ['1', 'Widget A', '9.99'], values: [{ colIndex: 2, value: '1.00' }] },
      { type: 'insert', values: [{ colIndex: 0, value: '4' }, { colIndex: 1, value: 'New Row' }] },
      { type: 'delete', originalRow: ['2', 'Widget B', '19.99'] },
    ];
    for (const change of changes) {
      const sql = buildStatementForChange(TABLE, COLUMNS, ['ID'], change);
      await Driver.runQuery(sql, conn);
    }

    const rows = await Driver.runQuery('SELECT ID, NAME, PRICE FROM ROW_EDIT_IT ORDER BY ID', conn);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].ID, 1);
    assert.strictEqual(Number(rows[0].PRICE), 1.00);
    assert.strictEqual(rows[1].ID, 4);
    assert.strictEqual(rows[1].NAME.trim(), 'New Row');
  });
});
