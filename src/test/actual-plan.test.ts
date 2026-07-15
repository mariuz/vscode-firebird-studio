/**
 * Unit tests for actual-plan.ts. Fixture data (record sources, stats, ACCESS_PATH text, and the
 * elapsed-time magnitudes) captured verbatim from a real Firebird 6.0 server -- see actual-plan.ts's
 * file header for how and why (docs/roadmap/query-plan-visualizer.md phase 3).
 */

import * as assert from 'assert';
import {
  buildActualPlanTree, parseEngineMajorVersion, isProfilerSupported, profilerSchemaPrefix,
  startProfilerSessionQuery, profiledStatementIdQuery, profilerRecordSourcesQuery,
  profilerRecordSourceStatsQuery, cleanupProfilerSessionQuery,
} from '../shared/actual-plan';

// Captured from `SELECT * FROM T1 WHERE NAME = 'a'` against T1(ID PK, NAME) with an index on
// NAME: Select Expression -> Filter -> Table Access By ID -> Bitmap -> Index Range Scan (the last
// three steps bundled into one record source's multi-line ACCESS_PATH, not three separate rows).
const RECORD_SOURCES = [
  { RECORD_SOURCE_ID: 1, PARENT_RECORD_SOURCE_ID: null, ACCESS_PATH: 'Select Expression' },
  { RECORD_SOURCE_ID: 2, PARENT_RECORD_SOURCE_ID: 1, ACCESS_PATH: '-> Filter' },
  {
    RECORD_SOURCE_ID: 3, PARENT_RECORD_SOURCE_ID: 2,
    ACCESS_PATH: '-> Table "PUBLIC"."T1" Access By ID\n    -> Bitmap\n        -> Index "PUBLIC"."IDX_T1_NAME" Range Scan (full match)',
  },
];
const STATS = [
  { RECORD_SOURCE_ID: 1, OPEN_COUNTER: 1, OPEN_TOTAL_ELAPSED_TIME: 370300, FETCH_COUNTER: 2, FETCH_TOTAL_ELAPSED_TIME: 5000 },
  { RECORD_SOURCE_ID: 2, OPEN_COUNTER: 1, OPEN_TOTAL_ELAPSED_TIME: 370000, FETCH_COUNTER: 2, FETCH_TOTAL_ELAPSED_TIME: 5100 },
  { RECORD_SOURCE_ID: 3, OPEN_COUNTER: 1, OPEN_TOTAL_ELAPSED_TIME: 366700, FETCH_COUNTER: 2, FETCH_TOTAL_ELAPSED_TIME: 3400 },
];

suite('buildActualPlanTree()', function () {

  test('nests strictly by PARENT_RECORD_SOURCE_ID, one root', function () {
    const roots = buildActualPlanTree(RECORD_SOURCES, STATS);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].recordSourceId, 1);
    assert.strictEqual(roots[0].children.length, 1);
    assert.strictEqual(roots[0].children[0].recordSourceId, 2);
    assert.strictEqual(roots[0].children[0].children[0].recordSourceId, 3);
  });

  test('derives level from the tree actually built, not a trusted input column', function () {
    const roots = buildActualPlanTree(RECORD_SOURCES, STATS);
    assert.strictEqual(roots[0].level, 0);
    assert.strictEqual(roots[0].children[0].level, 1);
    assert.strictEqual(roots[0].children[0].children[0].level, 2);
  });

  test('label is the first line of ACCESS_PATH with a leading "-> " stripped', function () {
    const roots = buildActualPlanTree(RECORD_SOURCES, STATS);
    assert.strictEqual(roots[0].label, 'Select Expression');
    assert.strictEqual(roots[0].children[0].label, 'Filter');
    assert.strictEqual(roots[0].children[0].children[0].label, 'Table "PUBLIC"."T1" Access By ID');
  });

  test('accessPath keeps the full multi-line text for the detail panel', function () {
    const roots = buildActualPlanTree(RECORD_SOURCES, STATS);
    const leaf = roots[0].children[0].children[0];
    assert.ok(leaf.accessPath.includes('Bitmap'));
    assert.ok(leaf.accessPath.includes('Index "PUBLIC"."IDX_T1_NAME" Range Scan'));
  });

  test('converts nanosecond elapsed times to milliseconds', function () {
    const roots = buildActualPlanTree(RECORD_SOURCES, STATS);
    assert.strictEqual(roots[0].openElapsedMs, 370300 / 1_000_000);
    assert.strictEqual(roots[0].fetchElapsedMs, 5000 / 1_000_000);
  });

  test('carries open/fetch counters through unchanged', function () {
    const roots = buildActualPlanTree(RECORD_SOURCES, STATS);
    const leaf = roots[0].children[0].children[0];
    assert.strictEqual(leaf.openCount, 1);
    assert.strictEqual(leaf.fetchCount, 2);
  });

  test('a record source with no matching stats row gets zeroed counters, not a crash', function () {
    const roots = buildActualPlanTree(RECORD_SOURCES, []);
    assert.strictEqual(roots[0].openCount, 0);
    assert.strictEqual(roots[0].fetchElapsedMs, 0);
  });

  test('a record source whose parent id has no matching row becomes a root, not dropped', function () {
    const orphan = [{ RECORD_SOURCE_ID: 5, PARENT_RECORD_SOURCE_ID: 999, ACCESS_PATH: 'Orphan' }];
    const roots = buildActualPlanTree(orphan, []);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].recordSourceId, 5);
  });

  test('sorts siblings and roots by RECORD_SOURCE_ID for deterministic output', function () {
    const unordered = [
      { RECORD_SOURCE_ID: 4, PARENT_RECORD_SOURCE_ID: 1, ACCESS_PATH: 'B' },
      { RECORD_SOURCE_ID: 1, PARENT_RECORD_SOURCE_ID: null, ACCESS_PATH: 'Root' },
      { RECORD_SOURCE_ID: 3, PARENT_RECORD_SOURCE_ID: 1, ACCESS_PATH: 'A' },
    ];
    const roots = buildActualPlanTree(unordered, []);
    assert.deepStrictEqual(roots[0].children.map(c => c.recordSourceId), [3, 4]);
  });
});

suite('parseEngineMajorVersion() / isProfilerSupported() / profilerSchemaPrefix()', function () {

  test('parses "6.0.0" (the real value seen from RDB$GET_CONTEXT on a live FB6 server) as 6', function () {
    assert.strictEqual(parseEngineMajorVersion('6.0.0'), 6);
  });

  test('parses a longer version string', function () {
    assert.strictEqual(parseEngineMajorVersion('3.0.11.33703'), 3);
  });

  test('returns 0 for unparseable input rather than throwing', function () {
    assert.strictEqual(parseEngineMajorVersion(''), 0);
    assert.strictEqual(parseEngineMajorVersion('not-a-version'), 0);
  });

  test('profiler is supported from Firebird 5.0 onward, not before', function () {
    assert.strictEqual(isProfilerSupported(4), false);
    assert.strictEqual(isProfilerSupported(5), true);
    assert.strictEqual(isProfilerSupported(6), true);
  });

  test('schema qualification is only needed from Firebird 6.0 onward (verified live: FB6 needs PLG$PROFILER., unqualified fails)', function () {
    assert.strictEqual(profilerSchemaPrefix(5), '');
    assert.strictEqual(profilerSchemaPrefix(6), 'PLG$PROFILER.');
  });
});

suite('actual-plan.ts query builders', function () {

  test('startProfilerSessionQuery escapes embedded single quotes in the description', function () {
    const sql = startProfilerSessionQuery("it's a test");
    assert.ok(sql.includes("it''s a test"), sql);
  });

  test('profiledStatementIdQuery matches by exact SQL_TEXT, not STATEMENT_ID position', function () {
    const sql = profiledStatementIdQuery('PLG$PROFILER.', 7, "SELECT * FROM T WHERE X = 1");
    assert.ok(sql.includes('PROFILE_ID = 7'), sql);
    assert.ok(sql.includes("SQL_TEXT AS VARCHAR"), sql);
    assert.ok(sql.includes("= 'SELECT * FROM T WHERE X = 1'"), sql);
    assert.ok(sql.includes('ORDER BY STATEMENT_ID DESC'), sql);
  });

  test('profiledStatementIdQuery escapes embedded single quotes in the SQL text', function () {
    const sql = profiledStatementIdQuery('', 1, "SELECT * FROM T WHERE NAME = 'x'");
    assert.ok(sql.includes("NAME = ''x''"), sql);
  });

  test('profilerRecordSourcesQuery casts ACCESS_PATH with an explicit CHARACTER SET UTF8', function () {
    const sql = profilerRecordSourcesQuery('PLG$PROFILER.', 7, 42);
    assert.ok(sql.includes('CAST(ACCESS_PATH AS VARCHAR'), sql);
    assert.ok(sql.includes('CHARACTER SET UTF8'), sql);
    assert.ok(sql.includes('PLG$PROFILER.PLG$PROF_RECORD_SOURCES'), sql);
    assert.ok(sql.includes('STATEMENT_ID = 42'), sql);
  });

  test('profilerRecordSourcesQuery omits the schema prefix on Firebird 5 (empty prefix)', function () {
    const sql = profilerRecordSourcesQuery('', 7, 42);
    assert.ok(sql.includes('FROM PLG$PROF_RECORD_SOURCES'), sql);
    assert.ok(!sql.includes('PLG$PROFILER.'), sql);
  });

  test('profilerRecordSourceStatsQuery selects the counter/elapsed-time columns actual-plan.ts reads', function () {
    const sql = profilerRecordSourceStatsQuery('PLG$PROFILER.', 7, 42);
    assert.ok(sql.includes('OPEN_COUNTER'), sql);
    assert.ok(sql.includes('OPEN_TOTAL_ELAPSED_TIME'), sql);
    assert.ok(sql.includes('FETCH_COUNTER'), sql);
    assert.ok(sql.includes('FETCH_TOTAL_ELAPSED_TIME'), sql);
  });

  test('cleanupProfilerSessionQuery deletes by PROFILE_ID from PLG$PROF_SESSIONS (cascades)', function () {
    const sql = cleanupProfilerSessionQuery('PLG$PROFILER.', 7);
    assert.strictEqual(sql, 'DELETE FROM PLG$PROFILER.PLG$PROF_SESSIONS WHERE PROFILE_ID = 7;');
  });

  test('the query builders reject a non-integer id rather than interpolating it unchecked', function () {
    assert.throws(() => profiledStatementIdQuery('', 1.5, 'SELECT 1'));
    assert.throws(() => profilerRecordSourcesQuery('', 1, NaN));
    assert.throws(() => profilerRecordSourceStatsQuery('', 1, 2.5));
    assert.throws(() => cleanupProfilerSessionQuery('', 'DROP TABLE X' as any));
  });
});
