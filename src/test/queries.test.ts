import * as assert from 'assert';
import {
  getProcedureBodyQuery,
  getTriggerBodyQuery,
  getViewDefinitionQuery,
  getAllProcedureSourcesQuery,
  getAllTriggerSourcesQuery,
  getAllViewSourcesQuery,
  getPrimaryKeyColumnsQuery,
  getAllPrimaryKeyConstraintNamesQuery,
  getSchemaColumnsQuery,
  getForeignKeysQuery,
  MAX_SOURCE_CAST_LENGTH,
  createGeneratorQuery,
  generatorCurrentValueQuery,
  createViewScaffold,
  createProcedureScaffold,
  createTriggerScaffold,
  createDomainScaffold,
  alterDomainScaffold,
  profilerActivityQuery,
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

// ── getAllProcedureSourcesQuery / getAllTriggerSourcesQuery / getAllViewSourcesQuery ──────────
//
// The "all objects at once" counterparts of the single-name source queries above, used by the
// Database Projects Extract command so it fetches every procedure/trigger/view's source in one
// round trip instead of one query per object.

suite('getAllProcedureSourcesQuery / getAllTriggerSourcesQuery / getAllViewSourcesQuery', function () {
  test('all three cast with an explicit CHARACTER SET UTF8, same as the single-name versions', function () {
    for (const sql of [getAllProcedureSourcesQuery(), getAllTriggerSourcesQuery(), getAllViewSourcesQuery()]) {
      assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
    }
  });

  test('all three exclude system objects', function () {
    assert.ok(getAllProcedureSourcesQuery().includes('RDB$SYSTEM_FLAG'));
    assert.ok(getAllTriggerSourcesQuery().includes('RDB$SYSTEM_FLAG'));
    assert.ok(getAllViewSourcesQuery().includes('RDB$SYSTEM_FLAG'));
  });

  test('getAllViewSourcesQuery filters to actual views (RDB$VIEW_BLR IS NOT NULL)', function () {
    assert.ok(getAllViewSourcesQuery().includes('RDB$VIEW_BLR IS NOT NULL'));
  });

  test('getAllTriggerSourcesQuery normalizes INACTIVE to 0/1', function () {
    assert.ok(getAllTriggerSourcesQuery().includes('CASE WHEN RDB$TRIGGER_INACTIVE = 1 THEN 1 ELSE 0 END AS INACTIVE'));
  });

  test('none fetch just one named object (no name filter, unlike the single-object queries)', function () {
    for (const sql of [getAllProcedureSourcesQuery(), getAllTriggerSourcesQuery(), getAllViewSourcesQuery()]) {
      assert.ok(!/TRIM\([^)]+\)\s*=\s*'/.test(sql), `expected no name filter: ${sql}`);
    }
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

// ── getAllPrimaryKeyConstraintNamesQuery ──────────────────────────────────────
//
// Used by the Schema Designer to DROP CONSTRAINT before adding a new primary key when a table's
// set of PK columns changes — one round trip for every table's PK constraint name at once.

suite('getAllPrimaryKeyConstraintNamesQuery', function () {
  const sql = getAllPrimaryKeyConstraintNamesQuery();

  test('takes no parameters — it covers every table in one query', function () {
    assert.strictEqual(getAllPrimaryKeyConstraintNamesQuery.length, 0);
  });

  test('filters constraints down to PRIMARY KEY', function () {
    assert.ok(sql.includes("RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'"), sql);
  });

  test('selects both the table name and the constraint name', function () {
    assert.ok(sql.includes('TABLE_NAME'), sql);
    assert.ok(sql.includes('CONSTRAINT_NAME'), sql);
  });
});

// ── getSchemaColumnsQuery — default value column ──────────────────────────────

suite('getSchemaColumnsQuery default value column', function () {
  const sql = getSchemaColumnsQuery();

  test('casts the default source with an explicit CHARACTER SET UTF8', function () {
    assert.ok(sql.includes('CAST(r.RDB$DEFAULT_SOURCE AS VARCHAR(100) CHARACTER SET UTF8) AS DFLT_VALUE'), sql);
  });
});

// ── getSchemaColumnsQuery — NUMERIC/DECIMAL fidelity ───────────────────────────
//
// Regression coverage for the "a NUMERIC(9,2) column round-trips as plain INTEGER" gap: this
// query used to select only the simplified type name + length, with nothing to distinguish a
// NUMERIC/DECIMAL column from its underlying INTEGER/BIGINT/DOUBLE storage type.

suite('getSchemaColumnsQuery NUMERIC/DECIMAL columns', function () {
  const sql = getSchemaColumnsQuery();

  test('selects RDB$FIELD_SUB_TYPE/PRECISION/SCALE from the already-joined RDB$FIELDS table', function () {
    assert.ok(sql.includes('f.RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE'), sql);
    assert.ok(sql.includes('f.RDB$FIELD_PRECISION AS FIELD_PRECISION'), sql);
    assert.ok(sql.includes('f.RDB$FIELD_SCALE AS FIELD_SCALE'), sql);
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

// ── "Create new object" scaffolds/queries ─────────────────────────────────────

suite('createGeneratorQuery', function () {
  test('produces a CREATE SEQUENCE statement', function () {
    assert.strictEqual(createGeneratorQuery('GEN_CUSTOMER_ID'), 'CREATE SEQUENCE GEN_CUSTOMER_ID;');
  });

  test('rejects an unsafe generator name instead of interpolating it unescaped', function () {
    assert.throws(() => createGeneratorQuery('BAD; DROP TABLE X'), /Invalid generator name/);
  });
});

suite('generatorCurrentValueQuery', function () {
  test('reads the current value via GEN_ID(name, 0), never advancing it', function () {
    assert.strictEqual(
      generatorCurrentValueQuery('GEN_CUSTOMER_ID'),
      'SELECT GEN_ID(GEN_CUSTOMER_ID, 0) AS CURRENT_VALUE FROM RDB$DATABASE;'
    );
  });

  test('rejects an unsafe generator name instead of interpolating it unescaped', function () {
    assert.throws(() => generatorCurrentValueQuery('BAD; DROP TABLE X'), /Invalid generator name/);
  });
});

suite('createViewScaffold / createProcedureScaffold / createTriggerScaffold', function () {
  test('createViewScaffold embeds the name in a CREATE VIEW statement', function () {
    const sql = createViewScaffold('ACTIVE_CUSTOMERS');
    assert.ok(sql.startsWith('CREATE VIEW ACTIVE_CUSTOMERS AS'), sql);
  });

  test('createViewScaffold rejects an unsafe view name', function () {
    assert.throws(() => createViewScaffold('BAD; DROP TABLE X'), /Invalid view name/);
  });

  test('createProcedureScaffold embeds the name in a CREATE PROCEDURE statement', function () {
    const sql = createProcedureScaffold('GET_ACTIVE_CUSTOMERS');
    assert.ok(sql.startsWith('CREATE PROCEDURE GET_ACTIVE_CUSTOMERS'), sql);
    assert.ok(sql.includes('BEGIN') && sql.includes('END'), sql);
  });

  test('createProcedureScaffold rejects an unsafe procedure name', function () {
    assert.throws(() => createProcedureScaffold('BAD; DROP TABLE X'), /Invalid procedure name/);
  });

  test('createTriggerScaffold embeds the name in a CREATE TRIGGER statement', function () {
    const sql = createTriggerScaffold('CUSTOMERS_BI');
    assert.ok(sql.startsWith('CREATE TRIGGER CUSTOMERS_BI'), sql);
    assert.ok(sql.includes('BEGIN') && sql.includes('END'), sql);
  });

  test('createTriggerScaffold rejects an unsafe trigger name', function () {
    assert.throws(() => createTriggerScaffold('BAD; DROP TABLE X'), /Invalid trigger name/);
  });
});

suite('createDomainScaffold / alterDomainScaffold', function () {
  test('createDomainScaffold embeds the name in a CREATE DOMAIN statement', function () {
    const sql = createDomainScaffold('D_EMAIL');
    assert.ok(sql.startsWith('CREATE DOMAIN D_EMAIL AS'), sql);
  });

  test('createDomainScaffold rejects an unsafe domain name', function () {
    assert.throws(() => createDomainScaffold('BAD; DROP TABLE X'), /Invalid domain name/);
  });

  test('alterDomainScaffold pre-fills the current type as a comment and an ALTER DOMAIN template', function () {
    const sql = alterDomainScaffold({ DOMAIN_NAME: 'D_EMAIL', DOMAIN_TYPE: 'VARCHAR', FIELD_LENGTH: 100, NOT_NULL: 1 });
    assert.ok(sql.includes('-- Current definition: D_EMAIL VARCHAR(100) NOT NULL'), sql);
    assert.ok(sql.includes('ALTER DOMAIN D_EMAIL TYPE VARCHAR(100);'), sql);
  });

  test('alterDomainScaffold omits NOT NULL when the domain allows nulls', function () {
    const sql = alterDomainScaffold({ DOMAIN_NAME: 'D_NOTES', DOMAIN_TYPE: 'VARCHAR', FIELD_LENGTH: 200, NOT_NULL: 0 });
    assert.ok(!sql.includes('NOT NULL'), sql);
  });

  test('alterDomainScaffold rejects an unsafe domain name', function () {
    assert.throws(() => alterDomainScaffold({ DOMAIN_NAME: 'BAD; DROP TABLE X', DOMAIN_TYPE: 'INTEGER' }), /Invalid domain name/);
  });
});

// ── profilerActivityQuery ──────────────────────────────────────────────────────
//
// Verified directly against a real Firebird 3.0 server before being written (see the query's
// own doc comment in queries.ts) — these tests just check the SQL shape, not live behavior.

suite('profilerActivityQuery', function () {
  const sql = profilerActivityQuery();

  test('takes no parameters — one query covers every connection', function () {
    assert.strictEqual(profilerActivityQuery.length, 0);
  });

  test('excludes the profiler\'s own dedicated connection', function () {
    assert.ok(sql.includes('a.MON$ATTACHMENT_ID <> CURRENT_CONNECTION'), sql);
  });

  test('excludes internal engine attachments with no remote address', function () {
    assert.ok(sql.includes('a.MON$REMOTE_ADDRESS IS NOT NULL'), sql);
  });

  test('scopes IO/record stats to the attachment-level stat group (1), not transaction/statement', function () {
    assert.ok(sql.includes('io.MON$STAT_GROUP = 1'), sql);
    assert.ok(sql.includes('rs.MON$STAT_GROUP = 1'), sql);
  });

  test('casts the active statement text with an explicit CHARACTER SET UTF8', function () {
    assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
  });

  test('picks only the most recently started active statement/transaction per attachment', function () {
    assert.ok(sql.includes('MAX(MON$STATEMENT_ID)'), sql);
    assert.ok(sql.includes('WHERE MON$STATE = 1'), sql);
    assert.ok(sql.includes('MAX(MON$TRANSACTION_ID)'), sql);
  });
});
