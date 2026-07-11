import * as assert from 'assert';
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from '../schema-visualizer/schema-graph';

function columnRow(overrides: Partial<SchemaColumnRow> = {}): SchemaColumnRow {
  return {
    TABLE_NAME: 'PRODUCTS',
    FIELD_NAME: 'ID',
    FIELD_TYPE: 'INTEGER',
    FIELD_LENGTH: 4,
    NOT_NULL: 1,
    IS_PRIMARY_KEY: 1,
    ...overrides,
  };
}

function fkRow(overrides: Partial<ForeignKeyRow> = {}): ForeignKeyRow {
  return {
    TABLE_NAME: 'ORDERS',
    COLUMN_NAME: 'PRODUCT_ID',
    CONSTRAINT_NAME: 'FK_ORDERS_PRODUCT',
    REF_TABLE_NAME: 'PRODUCTS',
    REF_COLUMN_NAME: 'ID',
    ...overrides,
  };
}

suite('buildSchemaGraph', function () {

  test('returns empty tables/relationships for no input', function () {
    const graph = buildSchemaGraph([], []);
    assert.deepStrictEqual(graph.tables, []);
    assert.deepStrictEqual(graph.relationships, []);
  });

  test('groups columns under a single table', function () {
    const graph = buildSchemaGraph(
      [
        columnRow({ FIELD_NAME: 'ID', IS_PRIMARY_KEY: 1 }),
        columnRow({ FIELD_NAME: 'NAME', FIELD_TYPE: 'VARCHAR', FIELD_LENGTH: 50, IS_PRIMARY_KEY: 0 }),
      ],
      []
    );
    assert.strictEqual(graph.tables.length, 1);
    assert.strictEqual(graph.tables[0].name, 'PRODUCTS');
    assert.strictEqual(graph.tables[0].columns.length, 2);
  });

  test('splits columns across multiple tables', function () {
    const graph = buildSchemaGraph(
      [
        columnRow({ TABLE_NAME: 'PRODUCTS', FIELD_NAME: 'ID' }),
        columnRow({ TABLE_NAME: 'ORDERS', FIELD_NAME: 'ID' }),
      ],
      []
    );
    const names = graph.tables.map(t => t.name).sort();
    assert.deepStrictEqual(names, ['ORDERS', 'PRODUCTS']);
  });

  test('preserves column order as given (query already orders by field position)', function () {
    const graph = buildSchemaGraph(
      [
        columnRow({ FIELD_NAME: 'ID' }),
        columnRow({ FIELD_NAME: 'NAME' }),
        columnRow({ FIELD_NAME: 'PRICE' }),
      ],
      []
    );
    assert.deepStrictEqual(graph.tables[0].columns.map(c => c.name), ['ID', 'NAME', 'PRICE']);
  });

  test('trims whitespace-padded names (Firebird CHAR fields)', function () {
    const graph = buildSchemaGraph(
      [columnRow({ TABLE_NAME: 'PRODUCTS   ', FIELD_NAME: 'ID   ', FIELD_TYPE: 'INTEGER ' })],
      []
    );
    assert.strictEqual(graph.tables[0].name, 'PRODUCTS');
    assert.strictEqual(graph.tables[0].columns[0].name, 'ID');
    assert.strictEqual(graph.tables[0].columns[0].type, 'INTEGER');
  });

  test('maps IS_PRIMARY_KEY/NOT_NULL numeric flags to booleans', function () {
    const graph = buildSchemaGraph(
      [columnRow({ IS_PRIMARY_KEY: 1, NOT_NULL: 1 }), columnRow({ FIELD_NAME: 'NOTES', IS_PRIMARY_KEY: 0, NOT_NULL: 0 })],
      []
    );
    assert.strictEqual(graph.tables[0].columns[0].isPrimaryKey, true);
    assert.strictEqual(graph.tables[0].columns[0].notNull, true);
    assert.strictEqual(graph.tables[0].columns[1].isPrimaryKey, false);
    assert.strictEqual(graph.tables[0].columns[1].notNull, false);
  });

  test('defaults a null FIELD_LENGTH to 0', function () {
    const graph = buildSchemaGraph([columnRow({ FIELD_LENGTH: null as unknown as number })], []);
    assert.strictEqual(graph.tables[0].columns[0].length, 0);
  });

  test('builds a single relationship', function () {
    const graph = buildSchemaGraph([], [fkRow()]);
    assert.strictEqual(graph.relationships.length, 1);
    assert.deepStrictEqual(graph.relationships[0], {
      constraintName: 'FK_ORDERS_PRODUCT',
      table: 'ORDERS',
      column: 'PRODUCT_ID',
      refTable: 'PRODUCTS',
      refColumn: 'ID',
    });
  });

  test('builds a composite-key relationship as two relationship entries sharing a constraint name', function () {
    const graph = buildSchemaGraph(
      [],
      [
        fkRow({ COLUMN_NAME: 'ORDER_YEAR', REF_COLUMN_NAME: 'YEAR' }),
        fkRow({ COLUMN_NAME: 'ORDER_SEQ', REF_COLUMN_NAME: 'SEQ' }),
      ]
    );
    assert.strictEqual(graph.relationships.length, 2);
    assert.strictEqual(graph.relationships[0].constraintName, graph.relationships[1].constraintName);
    assert.deepStrictEqual(graph.relationships.map(r => r.column), ['ORDER_YEAR', 'ORDER_SEQ']);
  });

  test('a table with no foreign keys still appears with an empty relationships contribution', function () {
    const graph = buildSchemaGraph([columnRow({ TABLE_NAME: 'STANDALONE' })], []);
    assert.strictEqual(graph.tables.length, 1);
    assert.strictEqual(graph.relationships.length, 0);
  });

  test('trims whitespace on relationship fields too', function () {
    const graph = buildSchemaGraph(
      [],
      [fkRow({ TABLE_NAME: 'ORDERS ', COLUMN_NAME: ' PRODUCT_ID', REF_TABLE_NAME: 'PRODUCTS ', REF_COLUMN_NAME: ' ID' })]
    );
    assert.strictEqual(graph.relationships[0].table, 'ORDERS');
    assert.strictEqual(graph.relationships[0].column, 'PRODUCT_ID');
    assert.strictEqual(graph.relationships[0].refTable, 'PRODUCTS');
    assert.strictEqual(graph.relationships[0].refColumn, 'ID');
  });

  test('a full multi-table schema assembles tables and relationships independently', function () {
    const graph = buildSchemaGraph(
      [
        columnRow({ TABLE_NAME: 'PRODUCTS', FIELD_NAME: 'ID', IS_PRIMARY_KEY: 1 }),
        columnRow({ TABLE_NAME: 'PRODUCTS', FIELD_NAME: 'NAME', IS_PRIMARY_KEY: 0 }),
        columnRow({ TABLE_NAME: 'ORDERS', FIELD_NAME: 'ID', IS_PRIMARY_KEY: 1 }),
        columnRow({ TABLE_NAME: 'ORDERS', FIELD_NAME: 'PRODUCT_ID', IS_PRIMARY_KEY: 0 }),
      ],
      [fkRow()]
    );
    assert.strictEqual(graph.tables.length, 2);
    assert.strictEqual(graph.relationships.length, 1);
    const orders = graph.tables.find(t => t.name === 'ORDERS')!;
    assert.strictEqual(orders.columns.length, 2);
  });
});
