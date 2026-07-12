import * as assert from 'assert';
import {
  tableInfoRowsToTable, buildDomainCreateDDL, buildExceptionCreateDDL, buildIndexCreateDDL,
  buildUserCreatePlaceholderDDL, TableInfoRow, DomainRow,
} from '../script-as/ddl-builders';
import { buildTableCreateDDL } from '../database-projects/project-model';

function tableInfoRow(overrides: Partial<TableInfoRow> = {}): TableInfoRow {
  return { FIELD_NAME: 'ID', FIELD_TYPE: 'INTEGER', FIELD_LENGTH: 4, NOT_NULL: 1, ...overrides };
}

suite('script-as-ddl-builders – tableInfoRowsToTable()', function () {
  test('maps FIELD_NAME/TYPE/LENGTH/NOT_NULL onto a SchemaColumn', function () {
    const table = tableInfoRowsToTable('CUSTOMERS', [tableInfoRow({ FIELD_NAME: ' NAME ', FIELD_TYPE: 'VARCHAR', FIELD_LENGTH: 50, NOT_NULL: 0 })]);
    assert.strictEqual(table.name, 'CUSTOMERS');
    assert.deepStrictEqual(table.columns[0], {
      name: 'NAME', type: 'VARCHAR', length: 50, notNull: false, isPrimaryKey: false,
      dflt: undefined, subType: undefined, precision: undefined, scale: undefined,
    });
  });

  test('treats CONSTRAINT_TYPE === "PRIMARY KEY" as the primary-key flag', function () {
    const table = tableInfoRowsToTable('T', [tableInfoRow({ CONSTRAINT_TYPE: 'PRIMARY KEY' })]);
    assert.strictEqual(table.columns[0].isPrimaryKey, true);
  });

  test('a different/absent CONSTRAINT_TYPE is not treated as a primary key', function () {
    const table = tableInfoRowsToTable('T', [tableInfoRow({ CONSTRAINT_TYPE: 'FOREIGN KEY' }), tableInfoRow({ CONSTRAINT_TYPE: null })]);
    assert.strictEqual(table.columns[0].isPrimaryKey, false);
    assert.strictEqual(table.columns[1].isPrimaryKey, false);
  });

  test('carries subType/precision/scale through, for columnTypeToDDL()\'s NUMERIC/DECIMAL detection', function () {
    const table = tableInfoRowsToTable('T', [tableInfoRow({ FIELD_SUB_TYPE: 1, FIELD_PRECISION: 9, FIELD_SCALE: -2 })]);
    assert.strictEqual(table.columns[0].subType, 1);
    assert.strictEqual(table.columns[0].precision, 9);
    assert.strictEqual(table.columns[0].scale, -2);
  });

  test('strips a leading DEFAULT keyword from DFLT_VALUE, same as buildSchemaGraph()', function () {
    const table = tableInfoRowsToTable('T', [tableInfoRow({ DFLT_VALUE: "DEFAULT 'X'" })]);
    assert.strictEqual(table.columns[0].dflt, "'X'");
  });

  test('the resulting SchemaTable is directly usable by buildTableCreateDDL()', function () {
    const table = tableInfoRowsToTable('CUSTOMERS', [
      tableInfoRow({ FIELD_NAME: 'ID', CONSTRAINT_TYPE: 'PRIMARY KEY' }),
      tableInfoRow({ FIELD_NAME: 'NAME', FIELD_TYPE: 'VARCHAR', FIELD_LENGTH: 50, NOT_NULL: 0 }),
    ]);
    const ddl = buildTableCreateDDL(table);
    assert.ok(ddl.startsWith('CREATE TABLE CUSTOMERS ('), ddl);
    assert.ok(ddl.includes('PRIMARY KEY (ID)'), ddl);
  });
});

suite('script-as-ddl-builders – buildDomainCreateDDL()', function () {
  function domainRow(overrides: Partial<DomainRow> = {}): DomainRow {
    return { DOMAIN_NAME: 'D_EMAIL', DOMAIN_TYPE: 'VARCHAR', FIELD_LENGTH: 100, NOT_NULL: 0, ...overrides };
  }

  test('builds a CREATE DOMAIN with the reconstructed type', function () {
    assert.strictEqual(buildDomainCreateDDL(domainRow()), 'CREATE DOMAIN D_EMAIL AS VARCHAR(100);');
  });

  test('appends NOT NULL when the domain disallows nulls', function () {
    assert.strictEqual(buildDomainCreateDDL(domainRow({ NOT_NULL: 1 })), 'CREATE DOMAIN D_EMAIL AS VARCHAR(100) NOT NULL;');
  });

  test('reconstructs NUMERIC/DECIMAL domains via subType/precision/scale, not the underlying storage type', function () {
    const ddl = buildDomainCreateDDL(domainRow({ DOMAIN_NAME: 'D_PRICE', DOMAIN_TYPE: 'INTEGER', FIELD_SUB_TYPE: 1, FIELD_PRECISION: 9, FIELD_SCALE: -2 }));
    assert.strictEqual(ddl, 'CREATE DOMAIN D_PRICE AS NUMERIC(9,2);');
  });
});

suite('script-as-ddl-builders – buildExceptionCreateDDL()', function () {
  test('builds a CREATE EXCEPTION with the message text', function () {
    assert.strictEqual(
      buildExceptionCreateDDL({ name: 'EX_NOT_FOUND', message: 'Record not found' }),
      "CREATE EXCEPTION EX_NOT_FOUND 'Record not found';"
    );
  });

  test('escapes an embedded single quote in the message', function () {
    assert.strictEqual(
      buildExceptionCreateDDL({ name: 'EX_BAD', message: "Can't do that" }),
      "CREATE EXCEPTION EX_BAD 'Can''t do that';"
    );
  });
});

suite('script-as-ddl-builders – buildIndexCreateDDL()', function () {
  test('builds a plain CREATE INDEX', function () {
    assert.strictEqual(
      buildIndexCreateDDL({ name: 'IDX_EMAIL', table: 'CUSTOMERS', columns: 'EMAIL', unique: false }),
      'CREATE INDEX IDX_EMAIL ON CUSTOMERS (EMAIL);'
    );
  });

  test('adds UNIQUE when the index is unique', function () {
    assert.strictEqual(
      buildIndexCreateDDL({ name: 'IDX_EMAIL', table: 'CUSTOMERS', columns: 'EMAIL', unique: true }),
      'CREATE UNIQUE INDEX IDX_EMAIL ON CUSTOMERS (EMAIL);'
    );
  });

  test('supports a composite (multi-column) index', function () {
    assert.strictEqual(
      buildIndexCreateDDL({ name: 'IDX_NAME', table: 'CUSTOMERS', columns: 'LAST_NAME, FIRST_NAME', unique: false }),
      'CREATE INDEX IDX_NAME ON CUSTOMERS (LAST_NAME, FIRST_NAME);'
    );
  });
});

suite('script-as-ddl-builders – buildUserCreatePlaceholderDDL()', function () {
  test('includes a password placeholder and a comment explaining why', function () {
    const ddl = buildUserCreatePlaceholderDDL('APP_USER');
    assert.ok(ddl.includes("CREATE USER APP_USER PASSWORD '<new-password>';"));
    assert.ok(ddl.startsWith('--'), 'expected an explanatory comment before the statement');
  });
});
