import * as assert from 'assert';
import {
  getProcedureBodyQuery,
  getTriggerBodyQuery,
  getViewDefinitionQuery,
  getPrimaryKeyColumnsQuery,
  getSchemaColumnsQuery,
  getForeignKeysQuery,
  MAX_SOURCE_CAST_LENGTH,
} from '../shared/queries';

// ── Source-fetching queries (procedure/trigger/view "edit source") ────────────
//
// Regression coverage for "SQL error code = -204, Data type unknown,
// Implementation limit exceeded, COLUMN" — these queries used to CAST the
// BLOB source column to VARCHAR(32000) with no explicit character set. Since
// node-firebird's default connection lc_ctype is UTF8 (up to 4 bytes/char),
// that CAST needed up to 128000 bytes, well over Firebird's 32767-byte column
// limit, so it always failed. The fix pins CHARACTER SET UTF8 explicitly (so
// the byte budget doesn't depend on whatever charset the connection
// negotiated) and sizes the VARCHAR to fit under it.

suite('getProcedureBodyQuery / getTriggerBodyQuery / getViewDefinitionQuery', function () {

  test('getProcedureBodyQuery casts with an explicit CHARACTER SET UTF8', function () {
    const sql = getProcedureBodyQuery('MY_PROC');
    assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
  });

  test('getTriggerBodyQuery casts with an explicit CHARACTER SET UTF8', function () {
    const sql = getTriggerBodyQuery('MY_TRIGGER');
    assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
  });

  test('getViewDefinitionQuery casts with an explicit CHARACTER SET UTF8', function () {
    const sql = getViewDefinitionQuery('MY_VIEW');
    assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
  });

  test('none of the source queries fall back to the old unqualified VARCHAR(32000) cast', function () {
    for (const sql of [getProcedureBodyQuery('P'), getTriggerBodyQuery('T'), getViewDefinitionQuery('V')]) {
      assert.ok(!/VARCHAR\(32000\)\s*\)/.test(sql), `still using an unqualified VARCHAR(32000) cast: ${sql}`);
    }
  });

  test('getProcedureBodyQuery filters by the given procedure name', function () {
    assert.ok(getProcedureBodyQuery("MY_PROC").includes("= 'MY_PROC'"));
  });

  test('getTriggerBodyQuery filters by the given trigger name', function () {
    assert.ok(getTriggerBodyQuery("MY_TRIGGER").includes("= 'MY_TRIGGER'"));
  });

  test('getViewDefinitionQuery filters by the given view name', function () {
    assert.ok(getViewDefinitionQuery("MY_VIEW").includes("= 'MY_VIEW'"));
  });
});

// ── getPrimaryKeyColumnsQuery ──────────────────────────────────────────────────
//
// Used by the editable results grid to target UPDATE/DELETE at a single row.

suite('getPrimaryKeyColumnsQuery', function () {

  test('filters by the given table name', function () {
    assert.ok(getPrimaryKeyColumnsQuery('PRODUCTS').includes("= 'PRODUCTS'"));
  });

  test('filters constraints down to PRIMARY KEY', function () {
    assert.ok(getPrimaryKeyColumnsQuery('PRODUCTS').includes("RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'"));
  });

  test('orders by field position so a composite key comes back in key order', function () {
    assert.ok(getPrimaryKeyColumnsQuery('PRODUCTS').includes('ORDER BY s.RDB$FIELD_POSITION'));
  });
});

// ── getSchemaColumnsQuery / getForeignKeysQuery ─────────────────────────────────
//
// Used by the schema visualizer to build the whole database's table/column/
// foreign-key graph in two queries instead of one round trip per table.

suite('getSchemaColumnsQuery', function () {
  const sql = getSchemaColumnsQuery();

  test('takes no parameters — it covers every table in one query', function () {
    assert.strictEqual(typeof getSchemaColumnsQuery, 'function');
    assert.strictEqual(getSchemaColumnsQuery.length, 0);
  });

  test('excludes views (RDB$VIEW_BLR IS NULL)', function () {
    assert.ok(sql.includes('rel.RDB$VIEW_BLR IS NULL'), sql);
  });

  test('excludes system tables', function () {
    assert.ok(sql.includes('RDB$SYSTEM_FLAG'), sql);
  });

  test('flags primary key columns', function () {
    assert.ok(sql.includes('IS_PRIMARY_KEY'), sql);
    assert.ok(sql.includes("RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'"), sql);
  });

  test('orders by table then field position so columns come back in declaration order', function () {
    assert.ok(sql.includes('ORDER BY TABLE_NAME, r.RDB$FIELD_POSITION'), sql);
  });
});

suite('getForeignKeysQuery', function () {
  const sql = getForeignKeysQuery();

  test('takes no parameters — it covers every relationship in one query', function () {
    assert.strictEqual(getForeignKeysQuery.length, 0);
  });

  test('joins through RDB$REF_CONSTRAINTS to find the referenced constraint', function () {
    assert.ok(sql.includes('RDB$REF_CONSTRAINTS'), sql);
  });

  test('pairs composite-key columns up by field position', function () {
    assert.ok(sql.includes('seg2.RDB$FIELD_POSITION = seg.RDB$FIELD_POSITION'), sql);
  });

  test('selects both the local and referenced table/column names', function () {
    ['TABLE_NAME', 'COLUMN_NAME', 'REF_TABLE_NAME', 'REF_COLUMN_NAME'].forEach(col => {
      assert.ok(sql.includes(col), `expected ${col} in: ${sql}`);
    });
  });
});
