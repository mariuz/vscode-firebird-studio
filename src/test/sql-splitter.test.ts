import * as assert from 'assert';
import { splitStatements } from '../shared/sql-splitter';

suite('SQL Splitter – basic statement splitting', function () {

  test('returns empty array for empty string', function () {
    assert.deepStrictEqual(splitStatements(''), []);
  });

  test('returns empty array for whitespace-only string', function () {
    assert.deepStrictEqual(splitStatements('   \n\t  '), []);
  });

  test('returns empty array for a lone semicolon', function () {
    assert.deepStrictEqual(splitStatements(';'), []);
  });

  test('splits two simple statements', function () {
    const stmts = splitStatements('SELECT 1 FROM RDB$DATABASE; SELECT 2 FROM RDB$DATABASE;');
    assert.deepStrictEqual(stmts, ['SELECT 1 FROM RDB$DATABASE', 'SELECT 2 FROM RDB$DATABASE']);
  });

  test('splits three simple statements', function () {
    const stmts = splitStatements('SELECT 1; SELECT 2; SELECT 3;');
    assert.strictEqual(stmts.length, 3);
  });

  test('handles a single statement without a trailing semicolon', function () {
    const stmts = splitStatements('SELECT 1 FROM RDB$DATABASE');
    assert.deepStrictEqual(stmts, ['SELECT 1 FROM RDB$DATABASE']);
  });

  test('handles a single statement with a trailing semicolon', function () {
    const stmts = splitStatements('SELECT 1 FROM RDB$DATABASE;');
    assert.deepStrictEqual(stmts, ['SELECT 1 FROM RDB$DATABASE']);
  });

  test('ignores blank statements between consecutive semicolons', function () {
    const stmts = splitStatements('SELECT 1;;;SELECT 2;');
    assert.deepStrictEqual(stmts, ['SELECT 1', 'SELECT 2']);
  });

  test('trims leading/trailing whitespace from each statement', function () {
    const stmts = splitStatements('   SELECT 1   ;   SELECT 2   ;  ');
    assert.deepStrictEqual(stmts, ['SELECT 1', 'SELECT 2']);
  });

  test('preserves internal newlines/whitespace within a statement', function () {
    const stmts = splitStatements('SELECT\n  1,\n  2\nFROM RDB$DATABASE;');
    assert.strictEqual(stmts[0], 'SELECT\n  1,\n  2\nFROM RDB$DATABASE');
  });
});

suite('SQL Splitter – string literals', function () {

  test('does not split on a semicolon inside a string literal', function () {
    const stmts = splitStatements("INSERT INTO T VALUES ('a;b'); SELECT 1;");
    assert.deepStrictEqual(stmts, ["INSERT INTO T VALUES ('a;b')", 'SELECT 1']);
  });

  test('handles escaped single quotes inside a string literal', function () {
    const stmts = splitStatements("INSERT INTO T VALUES ('it''s; here'); SELECT 1;");
    assert.deepStrictEqual(stmts, ["INSERT INTO T VALUES ('it''s; here')", 'SELECT 1']);
  });

  test('does not treat BEGIN/END/CASE keywords inside a string literal as PSQL syntax', function () {
    const stmts = splitStatements("INSERT INTO T VALUES ('BEGIN CASE END'); SELECT 1;");
    assert.deepStrictEqual(stmts, ["INSERT INTO T VALUES ('BEGIN CASE END')", 'SELECT 1']);
  });

  test('handles an unterminated string literal without throwing', function () {
    const stmts = splitStatements("SELECT 'unterminated");
    assert.strictEqual(stmts.length, 1);
  });
});

suite('SQL Splitter – comments', function () {

  test('preserves a semicolon inside a line comment and does not split on it', function () {
    const stmts = splitStatements('SELECT 1; -- comment; with a semicolon\nSELECT 2;');
    assert.deepStrictEqual(stmts, ['SELECT 1', '-- comment; with a semicolon\nSELECT 2']);
  });

  test('preserves a semicolon inside a block comment and does not split on it', function () {
    const stmts = splitStatements('SELECT 1; /* comment; with a semicolon */ SELECT 2;');
    assert.deepStrictEqual(stmts, ['SELECT 1', '/* comment; with a semicolon */ SELECT 2']);
  });

  test('handles an unterminated block comment without throwing', function () {
    const stmts = splitStatements('SELECT 1; /* never closed');
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[1].includes('/* never closed'));
  });

  test('does not treat BEGIN/END keywords inside a comment as PSQL syntax', function () {
    const stmts = splitStatements('SELECT 1; -- BEGIN CASE END example\nSELECT 2;');
    assert.deepStrictEqual(stmts, ['SELECT 1', '-- BEGIN CASE END example\nSELECT 2']);
  });
});

suite('SQL Splitter – bare PSQL blocks (no SET TERM)', function () {

  test('treats a CREATE PROCEDURE body as one statement despite internal semicolons', function () {
    const sql = [
      'CREATE PROCEDURE MY_PROC (P1 INTEGER)',
      'RETURNS (OUT1 INTEGER)',
      'AS',
      'BEGIN',
      '  OUT1 = P1 + 1;',
      '  SUSPEND;',
      'END;',
      'SELECT 1 FROM RDB$DATABASE;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].startsWith('CREATE PROCEDURE MY_PROC'));
    assert.ok(stmts[0].trim().endsWith('END'));
    assert.strictEqual(stmts[1], 'SELECT 1 FROM RDB$DATABASE');
  });

  test('protects a DECLARE VARIABLE section between AS and BEGIN', function () {
    const sql = [
      'CREATE PROCEDURE P (P1 INTEGER)',
      'RETURNS (OUT1 INTEGER)',
      'AS',
      '  DECLARE VARIABLE v_temp INTEGER;',
      'BEGIN',
      '  v_temp = P1 + 1;',
      '  OUT1 = v_temp;',
      '  SUSPEND;',
      'END;',
      'SELECT 1 FROM RDB$DATABASE;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].includes('DECLARE VARIABLE v_temp INTEGER;'));
    assert.ok(stmts[0].trim().endsWith('END'));
  });

  test('handles a bare EXECUTE BLOCK with a declaration section', function () {
    const sql = [
      'EXECUTE BLOCK AS',
      '  DECLARE VARIABLE i INTEGER = 0;',
      'BEGIN',
      '  WHILE (i < 3) DO',
      '  BEGIN',
      '    i = i + 1;',
      '  END',
      'END;',
      'SELECT 1 FROM RDB$DATABASE;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].startsWith('EXECUTE BLOCK'));
  });

  test('handles nested BEGIN...END blocks (IF/ELSE inside a procedure)', function () {
    const sql = [
      'CREATE PROCEDURE P AS',
      'BEGIN',
      '  IF (1 = 1) THEN',
      '  BEGIN',
      '    INSERT INTO T VALUES (1);',
      '    INSERT INTO T VALUES (2);',
      '  END',
      '  ELSE',
      '  BEGIN',
      '    INSERT INTO T VALUES (3);',
      '  END',
      'END;',
      'SELECT 1 FROM RDB$DATABASE;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });

  test('does not split on a semicolon inside a CASE expression within a PSQL block', function () {
    const sql = [
      "CREATE PROCEDURE P (P1 INTEGER) RETURNS (OUT1 VARCHAR(10)) AS",
      'BEGIN',
      "  OUT1 = CASE WHEN P1 = 1 THEN 'one' ELSE 'other' END;",
      '  SUSPEND;',
      'END;',
      'SELECT 1 FROM RDB$DATABASE;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });

  test('handles a top-level CASE expression with no enclosing BEGIN block', function () {
    const stmts = splitStatements("SELECT CASE WHEN 1=1 THEN 'a' ELSE 'b' END FROM RDB$DATABASE; SELECT 2;");
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].includes('CASE WHEN'));
  });

  test('handles CREATE TRIGGER bodies the same way as procedures', function () {
    const sql = [
      'CREATE TRIGGER T_BI FOR T',
      'ACTIVE BEFORE INSERT POSITION 0',
      'AS',
      'BEGIN',
      '  IF (NEW.ID IS NULL) THEN',
      '    NEW.ID = GEN_ID(GEN_T_ID, 1);',
      'END;',
      'SELECT 1 FROM RDB$DATABASE;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].startsWith('CREATE TRIGGER'));
  });

  test('is case-insensitive for BEGIN/END/CASE keywords', function () {
    const sql = [
      'create procedure p as',
      'begin',
      '  insert into t values (1);',
      '  insert into t values (2);',
      'end;',
      'select 1 from rdb$database;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });

  test('does not match BEGIN/END/CASE as substrings of longer identifiers', function () {
    // "BEGINNING", "ENDPOINT", "CASETYPE" must not be mistaken for the keywords
    const stmts = splitStatements('SELECT BEGINNING, ENDPOINT, CASETYPE FROM T;');
    assert.strictEqual(stmts.length, 1);
    assert.strictEqual(stmts[0], 'SELECT BEGINNING, ENDPOINT, CASETYPE FROM T');
  });
});

suite('SQL Splitter – SET TERM directive', function () {

  test('consumes SET TERM lines and does not emit them as statements', function () {
    const sql = [
      'SET TERM ^ ;',
      'CREATE PROCEDURE P AS',
      'BEGIN',
      '  SUSPEND;',
      'END^',
      'SET TERM ; ^',
      'SELECT 1 FROM RDB$DATABASE;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    stmts.forEach(s => assert.ok(!/^SET\s+TERM/i.test(s), `unexpected SET TERM statement: ${s}`));
  });

  test('protects a DECLARE VARIABLE section under SET TERM too', function () {
    const sql = [
      'SET TERM ^ ;',
      'CREATE PROCEDURE P (P1 INTEGER)',
      'RETURNS (OUT1 INTEGER)',
      'AS',
      '  DECLARE VARIABLE v_temp INTEGER;',
      'BEGIN',
      '  v_temp = P1 + 1;',
      '  OUT1 = v_temp;',
      '  SUSPEND;',
      'END^',
      'SET TERM ; ^',
      'SELECT * FROM P(1);',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].includes('DECLARE VARIABLE v_temp INTEGER;'));
  });

  test('handles two procedures declared back-to-back under one SET TERM block', function () {
    const sql = [
      'SET TERM ^ ;',
      'CREATE PROCEDURE P1 AS',
      'BEGIN',
      '  SUSPEND;',
      'END^',
      'CREATE PROCEDURE P2 AS',
      'BEGIN',
      '  SUSPEND;',
      'END^',
      'SET TERM ; ^',
      'SELECT 1 FROM RDB$DATABASE;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 3);
    assert.ok(stmts[0].includes('P1'));
    assert.ok(stmts[1].includes('P2'));
  });

  test('matches the exact CREATE PROCEDURE snippet shipped with the extension', function () {
    const sql = [
      'SET TERM ^ ;',
      'CREATE PROCEDURE procedure_name (param_name param_type)',
      'RETURNS (out_param out_type)',
      'AS',
      '  DECLARE VARIABLE v_temp INTEGER;',
      'BEGIN',
      '  /* procedure body */',
      '  SUSPEND;',
      'END^',
      'SET TERM ; ^',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
    assert.ok(stmts[0].startsWith('CREATE PROCEDURE procedure_name'));
  });

  test('matches the exact CREATE TRIGGER snippet shipped with the extension', function () {
    const sql = [
      'SET TERM ^ ;',
      'CREATE TRIGGER trigger_name FOR table_name',
      'ACTIVE BEFORE INSERT POSITION 0',
      'AS',
      'BEGIN',
      '  /* trigger body */',
      'END^',
      'SET TERM ; ^',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 1);
    assert.ok(stmts[0].startsWith('CREATE TRIGGER trigger_name'));
  });

  test('does not misfire on an unrelated column literally named TERM', function () {
    const stmts = splitStatements('UPDATE T SET TERM = 1 WHERE ID = 1; SELECT 1;');
    assert.strictEqual(stmts.length, 2);
    assert.strictEqual(stmts[0], 'UPDATE T SET TERM = 1 WHERE ID = 1');
  });

  test('supports a multi-character custom terminator token', function () {
    const sql = [
      'SET TERM !! ;',
      'CREATE PROCEDURE P AS',
      'BEGIN',
      '  SUSPEND;',
      'END!!',
      'SET TERM ; !!',
      'SELECT 1 FROM RDB$DATABASE;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
  });
});

suite('SQL Splitter – mixed real-world documents', function () {

  test('handles a document with plain DML followed by a procedure and more DML', function () {
    const sql = [
      'DELETE FROM LOG;',
      'SET TERM ^ ;',
      'CREATE PROCEDURE REBUILD_LOG AS',
      'BEGIN',
      '  INSERT INTO LOG (MSG) VALUES (\'rebuilt\');',
      'END^',
      'SET TERM ; ^',
      'SELECT * FROM REBUILD_LOG;',
      'SELECT COUNT(*) FROM LOG;',
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 4);
    assert.strictEqual(stmts[0], 'DELETE FROM LOG');
    assert.ok(stmts[1].startsWith('CREATE PROCEDURE REBUILD_LOG'));
    assert.strictEqual(stmts[2], 'SELECT * FROM REBUILD_LOG');
    assert.strictEqual(stmts[3], 'SELECT COUNT(*) FROM LOG');
  });
});
