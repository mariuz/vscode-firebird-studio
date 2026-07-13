import * as assert from 'assert';
import { diffProjects, buildPublishScript, PublishDiff } from '../database-projects/publish-model';
import { ProjectInput } from '../database-projects/project-model';
import { SchemaColumn, SchemaTable, SchemaGraph } from '../schema-designer/schema-graph';

function column(overrides: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name: 'ID', type: 'INTEGER', length: 4, notNull: true, isPrimaryKey: false, ...overrides };
}

function table(name: string, columns: SchemaColumn[]): SchemaTable {
  return { name, columns };
}

function input(overrides: Partial<ProjectInput> = {}): ProjectInput {
  const graph: SchemaGraph = { tables: [], relationships: [] };
  return { graph, procedures: [], triggers: [], views: [], generators: [], pkConstraintNames: {}, ...overrides };
}

suite('database-project-publish – diffProjects()', function () {
  test('detects a table only in the source as new', function () {
    const source = input({ graph: { tables: [table('CUSTOMERS', [column()])], relationships: [] } });
    const target = input();
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.newTables.length, 1);
    assert.strictEqual(diff.newTables[0].name, 'CUSTOMERS');
  });

  test('detects a table only in the target as dropped', function () {
    const source = input();
    const target = input({ graph: { tables: [table('OLD_TABLE', [column()])], relationships: [] } });
    const diff = diffProjects(source, target);
    assert.deepStrictEqual(diff.droppedTables, ['OLD_TABLE']);
  });

  test('detects an added column on a table present in both', function () {
    const source = input({ graph: { tables: [table('T', [column({ name: 'ID' }), column({ name: 'NAME', type: 'VARCHAR', length: 50, notNull: false })])], relationships: [] } });
    const target = input({ graph: { tables: [table('T', [column({ name: 'ID' })])], relationships: [] } });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.modifiedTables.length, 1);
    assert.strictEqual(diff.modifiedTables[0].addedColumns.length, 1);
    assert.strictEqual(diff.modifiedTables[0].addedColumns[0].name, 'NAME');
  });

  test('detects a dropped column', function () {
    const source = input({ graph: { tables: [table('T', [column({ name: 'ID' })])], relationships: [] } });
    const target = input({ graph: { tables: [table('T', [column({ name: 'ID' }), column({ name: 'OLD_COL' })])], relationships: [] } });
    const diff = diffProjects(source, target);
    assert.deepStrictEqual(diff.modifiedTables[0].droppedColumns, ['OLD_COL']);
  });

  test('detects a changed column (type)', function () {
    const source = input({ graph: { tables: [table('T', [column({ name: 'NOTE', type: 'VARCHAR', length: 100 })])], relationships: [] } });
    const target = input({ graph: { tables: [table('T', [column({ name: 'NOTE', type: 'VARCHAR', length: 20 })])], relationships: [] } });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.modifiedTables[0].changedColumns.length, 1);
    assert.strictEqual(diff.modifiedTables[0].changedColumns[0].name, 'NOTE');
  });

  test('a table with no differences is not reported as modified', function () {
    const source = input({ graph: { tables: [table('T', [column()])], relationships: [] } });
    const target = input({ graph: { tables: [table('T', [column()])], relationships: [] } });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.modifiedTables.length, 0);
  });

  test('detects a primary key change', function () {
    const source = input({ graph: { tables: [table('T', [column({ name: 'ID', isPrimaryKey: true }), column({ name: 'CODE', isPrimaryKey: false, type: 'VARCHAR', length: 10 })])], relationships: [] } });
    const target = input({ graph: { tables: [table('T', [column({ name: 'ID', isPrimaryKey: false }), column({ name: 'CODE', isPrimaryKey: true, type: 'VARCHAR', length: 10 })])], relationships: [] } });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.modifiedTables[0].pkChanged, true);
    assert.deepStrictEqual(diff.modifiedTables[0].newPkColumns, ['ID']);
  });

  test('detects new and dropped foreign keys', function () {
    const source = input({ graph: { tables: [], relationships: [{ constraintName: 'FK_NEW', table: 'CHILD', column: 'PARENT_ID', refTable: 'PARENT', refColumn: 'ID' }] } });
    const target = input({ graph: { tables: [], relationships: [{ constraintName: 'FK_OLD', table: 'CHILD', column: 'OTHER_ID', refTable: 'OTHER', refColumn: 'ID' }] } });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.newForeignKeys.length, 1);
    assert.strictEqual(diff.newForeignKeys[0].constraintName, 'FK_NEW');
    assert.strictEqual(diff.droppedForeignKeys.length, 1);
    assert.strictEqual(diff.droppedForeignKeys[0].constraintName, 'FK_OLD');
  });

  test('detects a changed procedure by comparing source text', function () {
    const source = input({ procedures: [{ name: 'P1', source: 'AS BEGIN EXIT; END' }] });
    const target = input({ procedures: [{ name: 'P1', source: 'AS BEGIN SUSPEND; END' }] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedProcedures.length, 1);
    assert.strictEqual(diff.newProcedures.length, 0);
  });

  test('does not report a procedure as changed when its source text is identical', function () {
    const source = input({ procedures: [{ name: 'P1', source: 'AS BEGIN EXIT; END' }] });
    const target = input({ procedures: [{ name: 'P1', source: 'AS BEGIN EXIT; END' }] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedProcedures.length, 0);
  });

  test('detects new and dropped generators', function () {
    const source = input({ generators: ['GEN_NEW'] });
    const target = input({ generators: ['GEN_OLD'] });
    const diff = diffProjects(source, target);
    assert.deepStrictEqual(diff.newGenerators, ['GEN_NEW']);
    assert.deepStrictEqual(diff.droppedGenerators, ['GEN_OLD']);
  });

  test('a renamed column shows up as a drop + add, not a rename (documented limitation)', function () {
    const source = input({ graph: { tables: [table('T', [column({ name: 'NEW_NAME', type: 'VARCHAR', length: 20, notNull: false })])], relationships: [] } });
    const target = input({ graph: { tables: [table('T', [column({ name: 'OLD_NAME', type: 'VARCHAR', length: 20, notNull: false })])], relationships: [] } });
    const diff = diffProjects(source, target);
    assert.deepStrictEqual(diff.modifiedTables[0].droppedColumns, ['OLD_NAME']);
    assert.strictEqual(diff.modifiedTables[0].addedColumns[0].name, 'NEW_NAME');
  });
});

suite('database-project-publish – buildPublishScript()', function () {
  function emptyDiff(): PublishDiff {
    return {
      newTables: [], droppedTables: [], modifiedTables: [],
      newForeignKeys: [], droppedForeignKeys: [],
      newViews: [], changedViews: [], droppedViews: [],
      newProcedures: [], changedProcedures: [], droppedProcedures: [],
      newTriggers: [], changedTriggers: [], droppedTriggers: [],
      newGenerators: [], droppedGenerators: [],
    };
  }

  test('reports no changes when the diff is empty', function () {
    const script = buildPublishScript(emptyDiff(), input());
    assert.ok(script.includes('No changes detected'));
  });

  test('emits a CREATE TABLE for a new table', function () {
    const diff = { ...emptyDiff(), newTables: [table('CUSTOMERS', [column()])] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('CREATE TABLE CUSTOMERS'));
  });

  test('does not emit a DROP TABLE by default (includeDrops omitted)', function () {
    const diff = { ...emptyDiff(), droppedTables: ['OLD_TABLE'] };
    const script = buildPublishScript(diff, input());
    assert.ok(!script.includes('DROP TABLE OLD_TABLE'));
    assert.ok(script.includes('OLD_TABLE'), 'should still mention it was skipped');
  });

  test('emits a DROP TABLE when includeDrops is true', function () {
    const diff = { ...emptyDiff(), droppedTables: ['OLD_TABLE'] };
    const script = buildPublishScript(diff, input(), { includeDrops: true });
    assert.ok(script.includes('DROP TABLE OLD_TABLE;'));
  });

  test('emits ADD COLUMN for an added column', function () {
    const diff = {
      ...emptyDiff(),
      modifiedTables: [{ name: 'T', addedColumns: [column({ name: 'NEW_COL', type: 'VARCHAR', length: 10, notNull: false })], droppedColumns: [], changedColumns: [], pkChanged: false, newPkColumns: [] }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('ALTER TABLE T ADD NEW_COL VARCHAR(10);'));
  });

  test('emits a DROP for a dropped column (Firebird has no "COLUMN" keyword there)', function () {
    const diff = {
      ...emptyDiff(),
      modifiedTables: [{ name: 'T', addedColumns: [], droppedColumns: ['OLD_COL'], changedColumns: [], pkChanged: false, newPkColumns: [] }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('ALTER TABLE T DROP OLD_COL;'));
    assert.ok(!script.includes('DROP COLUMN'));
  });

  test('emits ALTER COLUMN ... TYPE for a type change', function () {
    const src = column({ name: 'NOTE', type: 'VARCHAR', length: 100 });
    const tgt = column({ name: 'NOTE', type: 'VARCHAR', length: 20 });
    const diff = {
      ...emptyDiff(),
      modifiedTables: [{ name: 'T', addedColumns: [], droppedColumns: [], changedColumns: [{ name: 'NOTE', source: src, target: tgt }], pkChanged: false, newPkColumns: [] }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('ALTER TABLE T ALTER COLUMN NOTE TYPE VARCHAR(100);'));
  });

  test('emits SET NOT NULL when a column becomes required', function () {
    const src = column({ name: 'NOTE', type: 'VARCHAR', length: 20, notNull: true });
    const tgt = column({ name: 'NOTE', type: 'VARCHAR', length: 20, notNull: false });
    const diff = {
      ...emptyDiff(),
      modifiedTables: [{ name: 'T', addedColumns: [], droppedColumns: [], changedColumns: [{ name: 'NOTE', source: src, target: tgt }], pkChanged: false, newPkColumns: [] }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('ALTER TABLE T ALTER COLUMN NOTE SET NOT NULL;'));
  });

  test('emits DROP NOT NULL when a column becomes optional', function () {
    const src = column({ name: 'NOTE', type: 'VARCHAR', length: 20, notNull: false });
    const tgt = column({ name: 'NOTE', type: 'VARCHAR', length: 20, notNull: true });
    const diff = {
      ...emptyDiff(),
      modifiedTables: [{ name: 'T', addedColumns: [], droppedColumns: [], changedColumns: [{ name: 'NOTE', source: src, target: tgt }], pkChanged: false, newPkColumns: [] }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('ALTER TABLE T ALTER COLUMN NOTE DROP NOT NULL;'));
  });

  test('emits SET DEFAULT / DROP DEFAULT for default changes', function () {
    const withDefault = column({ name: 'STATUS', type: 'VARCHAR', length: 10, dflt: "'ACTIVE'" });
    const withoutDefault = column({ name: 'STATUS', type: 'VARCHAR', length: 10 });
    const addingDefault = {
      ...emptyDiff(),
      modifiedTables: [{ name: 'T', addedColumns: [], droppedColumns: [], changedColumns: [{ name: 'STATUS', source: withDefault, target: withoutDefault }], pkChanged: false, newPkColumns: [] }],
    };
    assert.ok(buildPublishScript(addingDefault, input()).includes("ALTER TABLE T ALTER COLUMN STATUS SET DEFAULT 'ACTIVE';"));

    const droppingDefault = {
      ...emptyDiff(),
      modifiedTables: [{ name: 'T', addedColumns: [], droppedColumns: [], changedColumns: [{ name: 'STATUS', source: withoutDefault, target: withDefault }], pkChanged: false, newPkColumns: [] }],
    };
    assert.ok(buildPublishScript(droppingDefault, input()).includes('ALTER TABLE T ALTER COLUMN STATUS DROP DEFAULT;'));
  });

  test('a primary key change drops the old constraint by its real name and adds the new one', function () {
    const diff = {
      ...emptyDiff(),
      modifiedTables: [{ name: 'T', addedColumns: [], droppedColumns: [], changedColumns: [], pkChanged: true, newPkColumns: ['NEW_ID'] }],
    };
    const target = input({ pkConstraintNames: { T: 'PK_T_OLD' } });
    const script = buildPublishScript(diff, target);
    assert.ok(script.includes('ALTER TABLE T DROP CONSTRAINT PK_T_OLD;'));
    assert.ok(script.includes('ALTER TABLE T ADD PRIMARY KEY (NEW_ID);'));
    // Drop must appear before add.
    assert.ok(script.indexOf('DROP CONSTRAINT PK_T_OLD') < script.indexOf('ADD PRIMARY KEY'));
  });

  test('a foreign key referencing a table whose PK is changing is dropped then re-added by the same constraint name', function () {
    const rel = { constraintName: 'FK_CHILD_PARENT', table: 'CHILD', column: 'PARENT_ID', refTable: 'PARENT', refColumn: 'ID' };
    const diff = {
      ...emptyDiff(),
      modifiedTables: [{ name: 'PARENT', addedColumns: [], droppedColumns: [], changedColumns: [], pkChanged: true, newPkColumns: ['NEW_ID'] }],
    };
    const target = input({ graph: { tables: [], relationships: [rel] }, pkConstraintNames: { PARENT: 'PK_PARENT_OLD' } });
    const script = buildPublishScript(diff, target);

    const dropIdx = script.indexOf('ALTER TABLE CHILD DROP CONSTRAINT FK_CHILD_PARENT;');
    const pkDropIdx = script.indexOf('ALTER TABLE PARENT DROP CONSTRAINT PK_PARENT_OLD;');
    const fkReAddIdx = script.indexOf('ALTER TABLE CHILD ADD CONSTRAINT FK_CHILD_PARENT FOREIGN KEY (PARENT_ID) REFERENCES PARENT (ID);');

    assert.ok(dropIdx >= 0, 'expected the FK to be dropped');
    assert.ok(pkDropIdx >= 0, 'expected the old PK to be dropped');
    assert.ok(fkReAddIdx >= 0, 'expected the FK to be re-added with its original name');
    assert.ok(dropIdx < pkDropIdx, 'FK must be dropped before the PK it depends on changes');
    assert.ok(pkDropIdx < fkReAddIdx, 'FK must be re-added after the PK change, not before');
  });

  test('does not re-add a foreign key that was explicitly dropped (only in target)', function () {
    const rel = { constraintName: 'FK_REMOVED', table: 'CHILD', column: 'PARENT_ID', refTable: 'PARENT', refColumn: 'ID' };
    const diff = { ...emptyDiff(), droppedForeignKeys: [rel] };
    const target = input({ graph: { tables: [], relationships: [rel] } });
    const script = buildPublishScript(diff, target);
    assert.ok(script.includes('ALTER TABLE CHILD DROP CONSTRAINT FK_REMOVED;'));
    assert.ok(!script.includes('ADD CONSTRAINT FK_REMOVED'));
  });

  test('emits CREATE OR ALTER for a new procedure', function () {
    const diff = { ...emptyDiff(), newProcedures: [{ name: 'P1', source: 'AS BEGIN EXIT; END' }] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('CREATE OR ALTER PROCEDURE P1'));
  });

  test('emits CREATE OR ALTER for a changed trigger', function () {
    const diff = { ...emptyDiff(), changedTriggers: [{ name: 'TRG1', table: 'T', inactive: false, type: 1, source: 'AS BEGIN END' }] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('CREATE OR ALTER TRIGGER TRG1'));
  });

  test('emits CREATE SEQUENCE for a new generator', function () {
    const diff = { ...emptyDiff(), newGenerators: ['GEN_NEW'] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('CREATE SEQUENCE GEN_NEW;'));
  });
});
