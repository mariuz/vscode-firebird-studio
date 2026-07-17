import * as assert from 'assert';
import {
  buildIndexMetadataQuery,
  renderIndexMetadataPlan,
  validateReadOnlyStatement,
} from '../shared/sql-analysis';

suite('sql-analysis – buildIndexMetadataQuery()', function () {
  test('builds one ? placeholder per table', function () {
    const sql = buildIndexMetadataQuery(['CUSTOMERS', 'ORDERS']);
    assert.ok(sql.includes('IN (?, ?)'), sql);
  });

  test('queries RDB$INDICES joined to RDB$INDEX_SEGMENTS', function () {
    const sql = buildIndexMetadataQuery(['T']);
    assert.ok(sql.includes('FROM RDB$INDICES'));
    assert.ok(sql.includes('JOIN RDB$INDEX_SEGMENTS'));
  });
});

suite('sql-analysis – renderIndexMetadataPlan()', function () {
  test('returns a "not available" message when there are no tables', function () {
    const plan = renderIndexMetadataPlan('SELECT 1 FROM RDB$DATABASE', [], []);
    assert.ok(plan.includes('PLAN not available'), plan);
  });

  test('returns a "no index information" message when the query found tables but no rows came back', function () {
    const plan = renderIndexMetadataPlan('SELECT * FROM CUSTOMERS', ['CUSTOMERS'], []);
    assert.ok(plan.includes('No index information found for table(s): CUSTOMERS'), plan);
  });

  test('groups index rows under a TABLE heading, marking unique indexes', function () {
    const plan = renderIndexMetadataPlan('SELECT * FROM CUSTOMERS', ['CUSTOMERS'], [
      { TABLE_NAME: 'CUSTOMERS', INDEX_NAME: 'PK_CUSTOMERS', FIELD_NAME: 'ID', IS_UNIQUE: 1 },
      { TABLE_NAME: 'CUSTOMERS', INDEX_NAME: 'IX_EMAIL', FIELD_NAME: 'EMAIL', IS_UNIQUE: 0 },
    ]);
    assert.ok(plan.includes('TABLE CUSTOMERS'), plan);
    assert.ok(plan.includes('INDEX PK_CUSTOMERS (UNIQUE) — field: ID'), plan);
    assert.ok(plan.includes('INDEX IX_EMAIL — field: EMAIL'), plan);
    assert.ok(!plan.includes('IX_EMAIL (UNIQUE)'), plan);
  });

  test('includes the original query text as a comment block', function () {
    const plan = renderIndexMetadataPlan('SELECT *\nFROM CUSTOMERS', ['CUSTOMERS'], [
      { TABLE_NAME: 'CUSTOMERS', INDEX_NAME: 'PK', FIELD_NAME: 'ID', IS_UNIQUE: 1 },
    ]);
    assert.ok(plan.includes('--   SELECT *'), plan);
    assert.ok(plan.includes('--   FROM CUSTOMERS'), plan);
  });
});

suite('sql-analysis – validateReadOnlyStatement()', function () {
  test('accepts a plain SELECT', function () {
    assert.strictEqual(validateReadOnlyStatement('SELECT * FROM CUSTOMERS'), undefined);
  });

  test('accepts a SELECT preceded by a line comment', function () {
    assert.strictEqual(validateReadOnlyStatement('-- top customers\nSELECT * FROM CUSTOMERS'), undefined);
  });

  test('accepts a SELECT preceded by a block comment', function () {
    assert.strictEqual(validateReadOnlyStatement('/* top customers */ SELECT * FROM CUSTOMERS'), undefined);
  });

  test('accepts a WITH ... AS (...) SELECT common table expression', function () {
    assert.strictEqual(
      validateReadOnlyStatement('WITH recent AS (SELECT * FROM ORDERS) SELECT * FROM recent'),
      undefined
    );
  });

  test('is case-insensitive', function () {
    assert.strictEqual(validateReadOnlyStatement('select * from customers'), undefined);
  });

  test('rejects an INSERT', function () {
    assert.ok(validateReadOnlyStatement("INSERT INTO T VALUES (1)")?.includes('Only SELECT'));
  });

  test('rejects an UPDATE', function () {
    assert.ok(validateReadOnlyStatement("UPDATE T SET X = 1")?.includes('Only SELECT'));
  });

  test('rejects a DELETE', function () {
    assert.ok(validateReadOnlyStatement("DELETE FROM T")?.includes('Only SELECT'));
  });

  test('rejects DDL (CREATE TABLE)', function () {
    assert.ok(validateReadOnlyStatement("CREATE TABLE T (ID INT)")?.includes('Only SELECT'));
  });

  test('rejects an EXECUTE BLOCK', function () {
    assert.ok(validateReadOnlyStatement("EXECUTE BLOCK AS BEGIN END")?.includes('Only SELECT'));
  });

  test('rejects multiple statements even if all are SELECTs', function () {
    const message = validateReadOnlyStatement('SELECT 1 FROM RDB$DATABASE; SELECT 2 FROM RDB$DATABASE;');
    assert.ok(message?.includes('single SELECT statement'), message);
    assert.ok(message?.includes('2 statements'), message);
  });

  test('rejects an empty string', function () {
    assert.ok(validateReadOnlyStatement('')?.includes('No SQL statement found'));
  });

  test('rejects a comment-only input the same way as an empty string (no actual statement, nothing left after stripping the comment) — splitStatements() filters comment-only chunks entirely, so this is now indistinguishable from truly empty input, which is a more accurate message than the old "Only SELECT..." wording', function () {
    assert.ok(validateReadOnlyStatement('-- just a comment, nothing else')?.includes('No SQL statement found'));
  });
});
