import * as assert from 'assert';
import { diffProjects, buildPublishScript, PublishDiff } from '../database-projects/publish-model';
import { ProjectInput, DomainSource } from '../database-projects/project-model';
import { SchemaColumn, SchemaTable, SchemaGraph } from '../schema-designer/schema-graph';

function column(overrides: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name: 'ID', type: 'INTEGER', length: 4, notNull: true, isPrimaryKey: false, ...overrides };
}

function table(name: string, columns: SchemaColumn[]): SchemaTable {
  return { name, columns };
}

function domain(overrides: Partial<DomainSource> & { name: string }): DomainSource {
  return { type: 'INTEGER', length: 4, notNull: false, ...overrides };
}

function input(overrides: Partial<ProjectInput> = {}): ProjectInput {
  const graph: SchemaGraph = { tables: [], relationships: [] };
  return {
    graph, domains: [], procedures: [], triggers: [], views: [], generators: [],
    exceptions: [], roles: [], users: [], pkConstraintNames: {}, ...overrides,
  };
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

  // ── domains ──────────────────────────────────────────────────────────────

  test('detects a domain only in the source as new', function () {
    const source = input({ domains: [domain({ name: 'D_NEW' })] });
    const target = input();
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.newDomains.length, 1);
    assert.strictEqual(diff.newDomains[0].name, 'D_NEW');
  });

  test('detects a domain only in the target as dropped', function () {
    const source = input();
    const target = input({ domains: [domain({ name: 'D_OLD' })] });
    const diff = diffProjects(source, target);
    assert.deepStrictEqual(diff.droppedDomains, ['D_OLD']);
  });

  test('an identical domain in both is not reported as changed', function () {
    const source = input({ domains: [domain({ name: 'D1', type: 'VARCHAR', length: 50 })] });
    const target = input({ domains: [domain({ name: 'D1', type: 'VARCHAR', length: 50 })] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedDomains.length, 0);
  });

  test('detects a domain type change', function () {
    const source = input({ domains: [domain({ name: 'D1', type: 'VARCHAR', length: 100 })] });
    const target = input({ domains: [domain({ name: 'D1', type: 'VARCHAR', length: 20 })] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedDomains.length, 1);
    assert.strictEqual(diff.changedDomains[0].name, 'D1');
  });

  test('detects a domain NOT NULL change', function () {
    const source = input({ domains: [domain({ name: 'D1', notNull: true })] });
    const target = input({ domains: [domain({ name: 'D1', notNull: false })] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedDomains.length, 1);
  });

  test('detects a domain default change', function () {
    const source = input({ domains: [domain({ name: 'D1', dflt: '1' })] });
    const target = input({ domains: [domain({ name: 'D1', dflt: '0' })] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedDomains.length, 1);
  });

  test('detects a domain check-constraint change', function () {
    const source = input({ domains: [domain({ name: 'D1', check: 'CHECK (VALUE >= 0)' })] });
    const target = input({ domains: [domain({ name: 'D1', check: 'CHECK (VALUE >= 10)' })] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedDomains.length, 1);
  });

  test('detects a domain check constraint being added where there was none', function () {
    const source = input({ domains: [domain({ name: 'D1', check: 'CHECK (VALUE >= 0)' })] });
    const target = input({ domains: [domain({ name: 'D1' })] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedDomains.length, 1);
    assert.strictEqual(diff.changedDomains[0].target.check, undefined);
    assert.strictEqual(diff.changedDomains[0].source.check, 'CHECK (VALUE >= 0)');
  });

  test('detects a domain check constraint being removed', function () {
    const source = input({ domains: [domain({ name: 'D1' })] });
    const target = input({ domains: [domain({ name: 'D1', check: 'CHECK (VALUE >= 0)' })] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedDomains.length, 1);
  });

  // ── exceptions ───────────────────────────────────────────────────────────

  test('detects new/changed/dropped exceptions by message', function () {
    const source = input({ exceptions: [{ name: 'EXC_A', message: 'new message' }, { name: 'EXC_SAME', message: 'unchanged' }] });
    const target = input({ exceptions: [{ name: 'EXC_SAME', message: 'unchanged' }, { name: 'EXC_OLD', message: 'gone' }] });
    const diff = diffProjects(source, target);
    assert.deepStrictEqual(diff.newExceptions.map(e => e.name), ['EXC_A']);
    assert.deepStrictEqual(diff.droppedExceptions, ['EXC_OLD']);
    assert.strictEqual(diff.changedExceptions.length, 0);
  });

  test('detects a changed exception message for a name present in both', function () {
    const source = input({ exceptions: [{ name: 'EXC_1', message: 'new text' }] });
    const target = input({ exceptions: [{ name: 'EXC_1', message: 'old text' }] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.changedExceptions.length, 1);
    assert.strictEqual(diff.changedExceptions[0].message, 'new text');
  });

  // ── roles/users (existence only — see DomainSource/UserSource doc comments for why there's no "changed" case) ──

  test('detects new/dropped roles', function () {
    const source = input({ roles: [{ name: 'ROLE_NEW' }] });
    const target = input({ roles: [{ name: 'ROLE_OLD' }] });
    const diff = diffProjects(source, target);
    assert.deepStrictEqual(diff.newRoles.map(r => r.name), ['ROLE_NEW']);
    assert.deepStrictEqual(diff.droppedRoles, ['ROLE_OLD']);
  });

  test('a role present in both is neither new nor dropped', function () {
    const source = input({ roles: [{ name: 'SAME_ROLE' }] });
    const target = input({ roles: [{ name: 'SAME_ROLE' }] });
    const diff = diffProjects(source, target);
    assert.strictEqual(diff.newRoles.length, 0);
    assert.strictEqual(diff.droppedRoles.length, 0);
  });

  test('detects new/dropped users', function () {
    const source = input({ users: [{ name: 'USER_NEW' }] });
    const target = input({ users: [{ name: 'USER_OLD' }] });
    const diff = diffProjects(source, target);
    assert.deepStrictEqual(diff.newUsers.map(u => u.name), ['USER_NEW']);
    assert.deepStrictEqual(diff.droppedUsers, ['USER_OLD']);
  });
});

suite('database-project-publish – buildPublishScript()', function () {
  function emptyDiff(): PublishDiff {
    return {
      newTables: [], droppedTables: [], modifiedTables: [],
      newForeignKeys: [], droppedForeignKeys: [],
      newDomains: [], changedDomains: [], droppedDomains: [],
      newViews: [], changedViews: [], droppedViews: [],
      newProcedures: [], changedProcedures: [], droppedProcedures: [],
      newTriggers: [], changedTriggers: [], droppedTriggers: [],
      newGenerators: [], droppedGenerators: [],
      newExceptions: [], changedExceptions: [], droppedExceptions: [],
      newRoles: [], droppedRoles: [],
      newUsers: [], droppedUsers: [],
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

  test('regression: a new generator is scripted before a new trigger/procedure that might GEN_ID() it — confirmed live that Firebird rejects the reverse order', function () {
    const diff = {
      ...emptyDiff(),
      newGenerators: ['GEN_ID_SOURCE'],
      newProcedures: [{ name: 'P1', source: 'BEGIN\n  X = GEN_ID(GEN_ID_SOURCE, 1);\nEND' }],
      newTriggers: [{ name: 'TRG1', table: 'T', inactive: false, type: 1, source: 'AS BEGIN NEW.ID = GEN_ID(GEN_ID_SOURCE, 1); END' }],
      newTables: [table('T', [column()])],
    };
    const script = buildPublishScript(diff, input());
    const genIdx = script.indexOf('CREATE SEQUENCE GEN_ID_SOURCE');
    assert.ok(genIdx >= 0, 'expected the generator to be scripted at all');
    assert.ok(genIdx < script.indexOf('CREATE OR ALTER PROCEDURE P1'), script);
    assert.ok(genIdx < script.indexOf('CREATE OR ALTER TRIGGER TRG1'), script);
    assert.ok(genIdx < script.indexOf('CREATE TABLE T'), 'generators should be scripted before tables too, since a column DEFAULT can reference one');
  });

  // ── domains ──────────────────────────────────────────────────────────────

  test('emits CREATE DOMAIN for a new domain', function () {
    const diff = { ...emptyDiff(), newDomains: [domain({ name: 'D_AGE', type: 'INTEGER' })] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('CREATE DOMAIN D_AGE AS INTEGER;'));
  });

  test('a changed domain emits no "CREATE OR ALTER DOMAIN" — that syntax does not exist in Firebird (confirmed live)', function () {
    const diff = {
      ...emptyDiff(),
      // 'INT64' is Firebird's raw internal type name (what getDomainsQuery()/columnTypeToDDL()
      // actually deal in) — it maps *to* the DDL keyword BIGINT as output, not the other way round.
      changedDomains: [{ name: 'D1', source: domain({ name: 'D1', type: 'INT64' }), target: domain({ name: 'D1', type: 'INTEGER' }) }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(!script.includes('CREATE OR ALTER DOMAIN'));
    assert.ok(script.includes('ALTER DOMAIN D1 TYPE BIGINT;'));
  });

  test('a changed domain emits SET/DROP NOT NULL, matching the column convention', function () {
    const becomingRequired = {
      ...emptyDiff(),
      changedDomains: [{ name: 'D1', source: domain({ name: 'D1', notNull: true }), target: domain({ name: 'D1', notNull: false }) }],
    };
    assert.ok(buildPublishScript(becomingRequired, input()).includes('ALTER DOMAIN D1 SET NOT NULL;'));

    const becomingOptional = {
      ...emptyDiff(),
      changedDomains: [{ name: 'D1', source: domain({ name: 'D1', notNull: false }), target: domain({ name: 'D1', notNull: true }) }],
    };
    assert.ok(buildPublishScript(becomingOptional, input()).includes('ALTER DOMAIN D1 DROP NOT NULL;'));
  });

  test('a changed domain emits SET/DROP DEFAULT', function () {
    const addingDefault = {
      ...emptyDiff(),
      changedDomains: [{ name: 'D1', source: domain({ name: 'D1', dflt: '0' }), target: domain({ name: 'D1' }) }],
    };
    assert.ok(buildPublishScript(addingDefault, input()).includes('ALTER DOMAIN D1 SET DEFAULT 0;'));

    const droppingDefault = {
      ...emptyDiff(),
      changedDomains: [{ name: 'D1', source: domain({ name: 'D1' }), target: domain({ name: 'D1', dflt: '0' }) }],
    };
    assert.ok(buildPublishScript(droppingDefault, input()).includes('ALTER DOMAIN D1 DROP DEFAULT;'));
  });

  test('a changed CHECK constraint drops the old one before adding the new one — Firebird allows only one per domain (confirmed live)', function () {
    const diff = {
      ...emptyDiff(),
      changedDomains: [{
        name: 'D1',
        source: domain({ name: 'D1', check: 'CHECK (VALUE >= 10)' }),
        target: domain({ name: 'D1', check: 'CHECK (VALUE >= 0)' }),
      }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('ALTER DOMAIN D1 DROP CONSTRAINT;'));
    assert.ok(script.includes('ALTER DOMAIN D1 ADD CONSTRAINT CHECK (VALUE >= 10);'));
    assert.ok(script.indexOf('DROP CONSTRAINT') < script.indexOf('ADD CONSTRAINT'), 'must drop the old check before adding the new one');
  });

  test('adding a CHECK constraint where there was none only emits ADD CONSTRAINT, no DROP', function () {
    const diff = {
      ...emptyDiff(),
      changedDomains: [{ name: 'D1', source: domain({ name: 'D1', check: 'CHECK (VALUE >= 0)' }), target: domain({ name: 'D1' }) }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('ALTER DOMAIN D1 ADD CONSTRAINT CHECK (VALUE >= 0);'));
    assert.ok(!script.includes('DROP CONSTRAINT'));
  });

  test('removing a CHECK constraint only emits DROP CONSTRAINT, no ADD', function () {
    const diff = {
      ...emptyDiff(),
      changedDomains: [{ name: 'D1', source: domain({ name: 'D1' }), target: domain({ name: 'D1', check: 'CHECK (VALUE >= 0)' }) }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('ALTER DOMAIN D1 DROP CONSTRAINT;'));
    assert.ok(!script.includes('ADD CONSTRAINT'));
  });

  test('domains are created before tables', function () {
    const diff = { ...emptyDiff(), newDomains: [domain({ name: 'D1' })], newTables: [table('T', [column()])] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.indexOf('CREATE DOMAIN D1') < script.indexOf('CREATE TABLE T'), script);
  });

  // ── exceptions (and the ordering requirement relative to procedures/triggers) ──────────────

  test('emits CREATE OR ALTER EXCEPTION for a new exception', function () {
    const diff = { ...emptyDiff(), newExceptions: [{ name: 'EXC_1', message: 'bad thing' }] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes("CREATE OR ALTER EXCEPTION EXC_1 'bad thing';"));
  });

  test('emits CREATE OR ALTER EXCEPTION for a changed exception', function () {
    const diff = { ...emptyDiff(), changedExceptions: [{ name: 'EXC_1', message: 'updated message' }] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes("CREATE OR ALTER EXCEPTION EXC_1 'updated message';"));
  });

  test('a new exception is scripted before a new procedure that might reference it (confirmed live that Firebird requires this)', function () {
    const diff = {
      ...emptyDiff(),
      newExceptions: [{ name: 'EXC_1', message: 'x' }],
      newProcedures: [{ name: 'P1', source: 'BEGIN\n  EXCEPTION EXC_1;\nEND' }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.indexOf('CREATE OR ALTER EXCEPTION EXC_1') < script.indexOf('CREATE OR ALTER PROCEDURE P1'), script);
  });

  test('a new exception is scripted before a new trigger that might reference it', function () {
    const diff = {
      ...emptyDiff(),
      newExceptions: [{ name: 'EXC_1', message: 'x' }],
      newTriggers: [{ name: 'TRG1', table: 'T', inactive: false, type: 1, source: 'AS BEGIN EXCEPTION EXC_1; END' }],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.indexOf('CREATE OR ALTER EXCEPTION EXC_1') < script.indexOf('CREATE OR ALTER TRIGGER TRG1'), script);
  });

  // ── roles/users ──────────────────────────────────────────────────────────

  test('emits CREATE ROLE for a new role', function () {
    const diff = { ...emptyDiff(), newRoles: [{ name: 'APP_ROLE' }] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('CREATE ROLE APP_ROLE;'));
  });

  test('a new user is scripted commented out, never as a live executable statement', function () {
    const diff = { ...emptyDiff(), newUsers: [{ name: 'JOHN_DOE' }] };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('-- CREATE USER JOHN_DOE PASSWORD'), script);
    // Assert none of the script's *statement* lines (as opposed to "-- " comment lines) actually
    // creates the user, matching the same "review before running" convention the rest of
    // buildPublishScript()'s output already follows.
    const executableLines = script.split('\n').filter(line => line.trim() && !line.trim().startsWith('--'));
    assert.ok(!executableLines.some(line => line.includes('CREATE USER')), 'CREATE USER must never appear as a live, uncommented statement');
  });

  // ── includeDrops ordering for the new object types ──────────────────────

  test('drops a domain only with includeDrops, and after tables (which may still reference it)', function () {
    const diff = { ...emptyDiff(), droppedDomains: ['D_OLD'], droppedTables: ['T_OLD'] };
    assert.ok(!buildPublishScript(diff, input()).includes('DROP DOMAIN'));

    const script = buildPublishScript(diff, input(), { includeDrops: true });
    assert.ok(script.includes('DROP DOMAIN D_OLD;'));
    assert.ok(script.indexOf('DROP TABLE T_OLD') < script.indexOf('DROP DOMAIN D_OLD'), script);
  });

  test('drops an exception only with includeDrops, and after procedures/triggers (which may reference it, confirmed live)', function () {
    const diff = { ...emptyDiff(), droppedExceptions: ['EXC_OLD'], droppedProcedures: ['P_OLD'], droppedTriggers: ['TRG_OLD'] };
    assert.ok(!buildPublishScript(diff, input()).includes('DROP EXCEPTION'));

    const script = buildPublishScript(diff, input(), { includeDrops: true });
    assert.ok(script.includes('DROP EXCEPTION EXC_OLD;'));
    assert.ok(script.indexOf('DROP TRIGGER TRG_OLD') < script.indexOf('DROP EXCEPTION EXC_OLD'), script);
    assert.ok(script.indexOf('DROP PROCEDURE P_OLD') < script.indexOf('DROP EXCEPTION EXC_OLD'), script);
  });

  test('drops a role/user only with includeDrops', function () {
    const diff = { ...emptyDiff(), droppedRoles: ['ROLE_OLD'], droppedUsers: ['USER_OLD'] };
    const withoutDrops = buildPublishScript(diff, input());
    assert.ok(!withoutDrops.includes('DROP ROLE'));
    assert.ok(!withoutDrops.includes('DROP USER'));

    const script = buildPublishScript(diff, input(), { includeDrops: true });
    assert.ok(script.includes('DROP ROLE ROLE_OLD;'));
    assert.ok(script.includes('DROP USER USER_OLD;'));
  });

  test('lists dropped domains/exceptions/roles/users in the "not dropped" note when includeDrops is omitted', function () {
    const diff = {
      ...emptyDiff(),
      droppedDomains: ['D_OLD'], droppedExceptions: ['EXC_OLD'], droppedRoles: ['ROLE_OLD'], droppedUsers: ['USER_OLD'],
    };
    const script = buildPublishScript(diff, input());
    assert.ok(script.includes('domain D_OLD'), script);
    assert.ok(script.includes('exception EXC_OLD'), script);
    assert.ok(script.includes('role ROLE_OLD'), script);
    assert.ok(script.includes('user USER_OLD'), script);
  });
});
