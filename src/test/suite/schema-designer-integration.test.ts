/**
 * Extension Development Host integration tests for the Schema Designer's
 * data pipeline against a real Firebird server.
 *
 * src/test/schema-graph.test.ts covers buildSchemaGraph()'s assembly logic
 * with fake rows; these tests run the real getSchemaColumnsQuery()/
 * getForeignKeysQuery() SQL — the riskiest part, particularly the
 * composite-foreign-key join that pairs columns up by RDB$FIELD_POSITION —
 * against an actual database and check the assembled graph matches what was
 * actually created.
 */

import * as assert from 'assert';
import { Driver, NodeClient } from '../../shared/driver';
import { getSchemaColumnsQuery, getForeignKeysQuery } from '../../shared/queries';
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from '../../schema-designer/schema-graph';
import { getTestConnectionOptions } from './firebird-test-env';

suite('Schema Designer data pipeline – real Firebird integration', function () {
  this.timeout(20000);

  const conn = getTestConnectionOptions();

  suiteSetup(async function () {
    Driver.client = new NodeClient();
    await Driver.runBatch(
      [
        'CREATE TABLE SV_PARENT (ID INTEGER NOT NULL, NAME VARCHAR(50), CONSTRAINT PK_SV_PARENT PRIMARY KEY (ID));',
        'CREATE TABLE SV_CHILD (ID INTEGER NOT NULL, PARENT_ID INTEGER, CONSTRAINT PK_SV_CHILD PRIMARY KEY (ID));',
        'ALTER TABLE SV_CHILD ADD CONSTRAINT FK_SV_CHILD_PARENT FOREIGN KEY (PARENT_ID) REFERENCES SV_PARENT (ID);',
        'CREATE TABLE SV_COMPOSITE_PARENT (A INTEGER NOT NULL, B INTEGER NOT NULL, CONSTRAINT PK_SV_COMP_PARENT PRIMARY KEY (A, B));',
        'CREATE TABLE SV_COMPOSITE_CHILD (X INTEGER, Y INTEGER, LABEL VARCHAR(20));',
        'ALTER TABLE SV_COMPOSITE_CHILD ADD CONSTRAINT FK_SV_COMPOSITE FOREIGN KEY (X, Y) REFERENCES SV_COMPOSITE_PARENT (A, B);',
      ].join('\n'),
      conn
    );
  });

  suiteTeardown(async function () {
    await Driver.runBatch(
      [
        'DROP TABLE SV_COMPOSITE_CHILD;',
        'DROP TABLE SV_COMPOSITE_PARENT;',
        'DROP TABLE SV_CHILD;',
        'DROP TABLE SV_PARENT;',
      ].join('\n'),
      conn
    ).catch(() => { /* best-effort cleanup */ });
  });

  async function fetchGraph() {
    const sql = `${getSchemaColumnsQuery()}\n${getForeignKeysQuery()}`;
    const results = await Driver.runBatch(sql, conn);
    assert.ok(!results[0].error, `getSchemaColumnsQuery failed: ${results[0].error}`);
    assert.ok(!results[1].error, `getForeignKeysQuery failed: ${results[1].error}`);
    return buildSchemaGraph(
      (results[0].rows ?? []) as SchemaColumnRow[],
      (results[1].rows ?? []) as ForeignKeyRow[]
    );
  }

  test('includes the seeded PRODUCTS table alongside the new ones', async function () {
    const graph = await fetchGraph();
    const names = graph.tables.map(t => t.name);
    assert.ok(names.includes('PRODUCTS'), names.join(', '));
    assert.ok(names.includes('SV_PARENT'), names.join(', '));
  });

  test('reports the primary key column for a simple table', async function () {
    const graph = await fetchGraph();
    const parent = graph.tables.find(t => t.name === 'SV_PARENT')!;
    assert.ok(parent, 'SV_PARENT should be present');
    const idCol = parent.columns.find(c => c.name === 'ID')!;
    assert.strictEqual(idCol.isPrimaryKey, true);
    const nameCol = parent.columns.find(c => c.name === 'NAME')!;
    assert.strictEqual(nameCol.isPrimaryKey, false);
    assert.strictEqual(nameCol.type, 'VARCHAR');
    assert.strictEqual(nameCol.length, 50);
  });

  test('finds the simple foreign key relationship between SV_CHILD and SV_PARENT', async function () {
    const graph = await fetchGraph();
    const rel = graph.relationships.find(r => r.table === 'SV_CHILD' && r.refTable === 'SV_PARENT');
    assert.ok(rel, `expected a SV_CHILD -> SV_PARENT relationship, got: ${JSON.stringify(graph.relationships)}`);
    assert.strictEqual(rel!.column, 'PARENT_ID');
    assert.strictEqual(rel!.refColumn, 'ID');
  });

  test('pairs up a composite foreign key\'s columns correctly, by position', async function () {
    const graph = await fetchGraph();
    const rels = graph.relationships.filter(r => r.table === 'SV_COMPOSITE_CHILD' && r.refTable === 'SV_COMPOSITE_PARENT');
    assert.strictEqual(rels.length, 2, `expected 2 composite-key relationship rows, got: ${JSON.stringify(rels)}`);

    const byColumn = new Map(rels.map(r => [r.column, r.refColumn]));
    assert.strictEqual(byColumn.get('X'), 'A');
    assert.strictEqual(byColumn.get('Y'), 'B');
    // Both rows belong to the same constraint.
    assert.strictEqual(rels[0].constraintName, rels[1].constraintName);
  });

  test('a table with no foreign keys (SV_COMPOSITE_PARENT) has none pointing away from it as source', async function () {
    const graph = await fetchGraph();
    const outgoing = graph.relationships.filter(r => r.table === 'SV_COMPOSITE_PARENT');
    assert.strictEqual(outgoing.length, 0);
  });
});
