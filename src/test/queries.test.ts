import * as assert from 'assert';
import {
  getProcedureBodyQuery,
  getTriggerBodyQuery,
  getViewDefinitionQuery,
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
