/**
 * Pure diff-and-generate logic for Database Projects' Publish/migrate command (Phase 3 of
 * docs/roadmap/database-projects.md): compares a saved project snapshot (ProjectInput, written
 * to firebird.project-snapshot.json by Extract) against a target connection's live schema
 * (fetched into the same ProjectInput shape via fetchProjectSnapshot()), and generates an
 * executable migration script — never executed automatically, always opened for review first,
 * matching this codebase's established "always show generated DDL before running it" convention.
 *
 * Diffing is name-based only, the same limitation schema-diff.ts's existing connection-vs-
 * connection comparison already has — there is no "original name" to compare against here (unlike
 * the Schema Designer's own in-session rename tracking), since the two snapshots being compared
 * were fetched independently, possibly months apart. A renamed column/table therefore shows up as
 * a drop of the old name plus an add of the new one, not a rename — a known, disclosed limitation
 * rather than an unreliable renamed-vs-dropped heuristic.
 */

import { SchemaColumn, SchemaTable, SchemaRelationship } from "../schema-designer/schema-graph";
import {
  ProjectInput, ProcedureSource, TriggerSource, ViewSource,
  buildTableCreateDDL, buildForeignKeyDDL, buildProcedureCreateDDL, buildTriggerCreateDDL,
  buildViewCreateDDL, buildGeneratorCreateDDL, columnTypeToDDL,
} from "./project-model";

export interface ColumnChange {
  name: string;
  source: SchemaColumn;
  target: SchemaColumn;
}

export interface TableDiff {
  name: string;
  addedColumns: SchemaColumn[];
  droppedColumns: string[];
  changedColumns: ColumnChange[];
  pkChanged: boolean;
  /** The columns the new primary key should cover — empty if the table no longer has one. */
  newPkColumns: string[];
}

export interface PublishDiff {
  newTables: SchemaTable[];
  droppedTables: string[];
  modifiedTables: TableDiff[];
  newForeignKeys: SchemaRelationship[];
  droppedForeignKeys: SchemaRelationship[];
  newViews: ViewSource[];
  changedViews: ViewSource[];
  droppedViews: string[];
  newProcedures: ProcedureSource[];
  changedProcedures: ProcedureSource[];
  droppedProcedures: string[];
  newTriggers: TriggerSource[];
  changedTriggers: TriggerSource[];
  droppedTriggers: string[];
  newGenerators: string[];
  droppedGenerators: string[];
}

function columnsEqual(a: SchemaColumn, b: SchemaColumn): boolean {
  return a.type === b.type
    && a.length === b.length
    && a.notNull === b.notNull
    && (a.dflt ?? "") === (b.dflt ?? "")
    && a.isPrimaryKey === b.isPrimaryKey
    && (a.subType ?? 0) === (b.subType ?? 0)
    && (a.precision ?? 0) === (b.precision ?? 0)
    && (a.scale ?? 0) === (b.scale ?? 0);
}

function pkColumnsOf(table: SchemaTable): string[] {
  return table.columns.filter(c => c.isPrimaryKey).map(c => c.name);
}

function diffTable(source: SchemaTable, target: SchemaTable): TableDiff | undefined {
  const sourceCols = new Map(source.columns.map(c => [c.name, c]));
  const targetCols = new Map(target.columns.map(c => [c.name, c]));

  const addedColumns = source.columns.filter(c => !targetCols.has(c.name));
  const droppedColumns = target.columns.filter(c => !sourceCols.has(c.name)).map(c => c.name);

  const changedColumns: ColumnChange[] = [];
  for (const sourceCol of source.columns) {
    const targetCol = targetCols.get(sourceCol.name);
    if (targetCol && !columnsEqual(sourceCol, targetCol)) {
      changedColumns.push({ name: sourceCol.name, source: sourceCol, target: targetCol });
    }
  }

  const sourcePk = pkColumnsOf(source).slice().sort().join(",");
  const targetPk = pkColumnsOf(target).slice().sort().join(",");
  const pkChanged = sourcePk !== targetPk;

  if (addedColumns.length === 0 && droppedColumns.length === 0 && changedColumns.length === 0 && !pkChanged) {
    return undefined;
  }

  return { name: source.name, addedColumns, droppedColumns, changedColumns, pkChanged, newPkColumns: pkColumnsOf(source) };
}

function fkKey(rel: SchemaRelationship): string {
  return `${rel.table}.${rel.column}->${rel.refTable}.${rel.refColumn}`;
}

/** Diffs by name (no rename detection — see this module's top-of-file comment) against an object carrying a `.source` DDL body; a name present in both but with different source text is "changed". */
function diffNamedSource<T extends { name: string; source: string }>(
  source: T[],
  target: T[]
): { added: T[]; changed: T[]; dropped: string[] } {
  const sourceMap = new Map(source.map(x => [x.name, x]));
  const targetMap = new Map(target.map(x => [x.name, x]));

  const added = source.filter(x => !targetMap.has(x.name));
  const changed = source.filter(x => {
    const t = targetMap.get(x.name);
    return !!t && t.source.trim() !== x.source.trim();
  });
  const dropped = target.filter(x => !sourceMap.has(x.name)).map(x => x.name);

  return { added, changed, dropped };
}

export function diffProjects(source: ProjectInput, target: ProjectInput): PublishDiff {
  const sourceTables = new Map(source.graph.tables.map(t => [t.name, t]));
  const targetTables = new Map(target.graph.tables.map(t => [t.name, t]));

  const newTables = source.graph.tables.filter(t => !targetTables.has(t.name));
  const droppedTables = target.graph.tables.filter(t => !sourceTables.has(t.name)).map(t => t.name);

  const modifiedTables: TableDiff[] = [];
  for (const sourceTable of source.graph.tables) {
    const targetTable = targetTables.get(sourceTable.name);
    if (!targetTable) { continue; }
    const diff = diffTable(sourceTable, targetTable);
    if (diff) { modifiedTables.push(diff); }
  }

  const sourceFks = new Map(source.graph.relationships.map(r => [fkKey(r), r]));
  const targetFks = new Map(target.graph.relationships.map(r => [fkKey(r), r]));
  const newForeignKeys = source.graph.relationships.filter(r => !targetFks.has(fkKey(r)));
  const droppedForeignKeys = target.graph.relationships.filter(r => !sourceFks.has(fkKey(r)));

  const viewsDiff = diffNamedSource(source.views, target.views);
  const proceduresDiff = diffNamedSource(source.procedures, target.procedures);
  const triggersDiff = diffNamedSource(source.triggers, target.triggers);

  const sourceGens = new Set(source.generators);
  const targetGens = new Set(target.generators);
  const newGenerators = source.generators.filter(g => !targetGens.has(g));
  const droppedGenerators = target.generators.filter(g => !sourceGens.has(g));

  return {
    newTables, droppedTables, modifiedTables,
    newForeignKeys, droppedForeignKeys,
    newViews: viewsDiff.added, changedViews: viewsDiff.changed, droppedViews: viewsDiff.dropped,
    newProcedures: proceduresDiff.added, changedProcedures: proceduresDiff.changed, droppedProcedures: proceduresDiff.dropped,
    newTriggers: triggersDiff.added, changedTriggers: triggersDiff.changed, droppedTriggers: triggersDiff.dropped,
    newGenerators, droppedGenerators,
  };
}

export interface BuildPublishScriptOptions {
  /** Emit DROP TABLE/PROCEDURE/TRIGGER/VIEW/SEQUENCE for objects present in the target but not the source. Defaults to false — a drop is destructive and should be an explicit opt-in, not a side effect of publishing. */
  includeDrops?: boolean;
}

/**
 * Builds an executable migration script from a PublishDiff, always opened for review before
 * execution (this module never runs anything itself). Ordering:
 *   1. Drop FKs being removed outright, and any *kept* FK that references a table whose PK is
 *      changing (Firebird refuses to change a PK a live FK still references) — recorded so they
 *      can be re-added by their original constraint name in step 5.
 *   2. Column changes on existing tables (drop, alter type/null/default, add).
 *   3. PK changes on existing tables (drop old constraint by its real name — Firebird has no
 *      "DROP PRIMARY KEY" shorthand, confirmed directly against a live server — then add the new one).
 *   4. CREATE TABLE for new tables.
 *   5. ADD CONSTRAINT for new FKs and any FK cycled out in step 1.
 *   6. CREATE OR ALTER for new/changed procedures, triggers, views; CREATE SEQUENCE for new generators.
 *   7. (only with includeDrops) DROP TABLE/PROCEDURE/TRIGGER/VIEW/SEQUENCE for anything only in the target.
 */
export function buildPublishScript(
  diff: PublishDiff,
  target: ProjectInput,
  options: BuildPublishScriptOptions = {}
): string {
  const statements: string[] = [];
  const note = (text: string) => statements.push(`-- ${text}`);

  const pkChangedTables = new Set(diff.modifiedTables.filter(t => t.pkChanged).map(t => t.name));
  const keptFksNeedingCycle = target.graph.relationships.filter(
    rel => pkChangedTables.has(rel.refTable) && !diff.droppedForeignKeys.some(d => fkKey(d) === fkKey(rel))
  );

  if (diff.droppedForeignKeys.length > 0 || keptFksNeedingCycle.length > 0) {
    note("Drop foreign keys (removed, or referencing a table whose primary key is changing)");
    for (const rel of diff.droppedForeignKeys) {
      statements.push(`ALTER TABLE ${rel.table} DROP CONSTRAINT ${rel.constraintName};`);
    }
    for (const rel of keptFksNeedingCycle) {
      statements.push(`ALTER TABLE ${rel.table} DROP CONSTRAINT ${rel.constraintName};`);
    }
  }

  for (const table of diff.modifiedTables) {
    const tableStatements: string[] = [];
    for (const name of table.droppedColumns) {
      // Firebird's DROP <column> syntax has no "COLUMN" keyword (confirmed directly against a
      // live server: "ALTER TABLE t DROP COLUMN c" is a syntax error, "ALTER TABLE t DROP c" is not).
      tableStatements.push(`ALTER TABLE ${table.name} DROP ${name};`);
    }
    for (const change of table.changedColumns) {
      tableStatements.push(...buildColumnAlterStatements(table.name, change));
    }
    for (const column of table.addedColumns) {
      const parts = [`${column.name} ${columnTypeToDDL(column)}`];
      if (column.dflt) { parts.push(`DEFAULT ${column.dflt}`); }
      if (column.notNull) { parts.push("NOT NULL"); }
      tableStatements.push(`ALTER TABLE ${table.name} ADD ${parts.join(" ")};`);
    }
    if (tableStatements.length > 0) {
      note(`Table ${table.name}: column changes`);
      statements.push(...tableStatements);
    }
    if (table.pkChanged) {
      note(`Table ${table.name}: primary key change`);
      const oldPkName = target.pkConstraintNames[table.name];
      if (oldPkName) {
        statements.push(`ALTER TABLE ${table.name} DROP CONSTRAINT ${oldPkName};`);
      }
      if (table.newPkColumns.length > 0) {
        statements.push(`ALTER TABLE ${table.name} ADD PRIMARY KEY (${table.newPkColumns.join(", ")});`);
      }
    }
  }

  if (diff.newTables.length > 0) {
    note("New tables");
    for (const table of diff.newTables) {
      statements.push(buildTableCreateDDL(table));
    }
  }

  if (diff.newForeignKeys.length > 0 || keptFksNeedingCycle.length > 0) {
    note("Add foreign keys (new, plus any dropped above to allow a primary key change)");
    for (const rel of diff.newForeignKeys) {
      statements.push(buildForeignKeyDDL(rel));
    }
    for (const rel of keptFksNeedingCycle) {
      statements.push(buildForeignKeyDDL(rel));
    }
  }

  if (diff.newViews.length > 0 || diff.changedViews.length > 0) {
    note("New/changed views");
    for (const view of [...diff.newViews, ...diff.changedViews]) {
      statements.push(buildViewCreateDDL(view));
    }
  }

  if (diff.newProcedures.length > 0 || diff.changedProcedures.length > 0) {
    note("New/changed procedures");
    for (const proc of [...diff.newProcedures, ...diff.changedProcedures]) {
      statements.push(buildProcedureCreateDDL(proc));
    }
  }

  if (diff.newTriggers.length > 0 || diff.changedTriggers.length > 0) {
    note("New/changed triggers");
    for (const trigger of [...diff.newTriggers, ...diff.changedTriggers]) {
      statements.push(buildTriggerCreateDDL(trigger));
    }
  }

  if (diff.newGenerators.length > 0) {
    note("New generators");
    for (const name of diff.newGenerators) {
      statements.push(buildGeneratorCreateDDL(name));
    }
  }

  if (options.includeDrops) {
    if (diff.droppedTriggers.length > 0) {
      note("Drop triggers (present in target only)");
      for (const name of diff.droppedTriggers) { statements.push(`DROP TRIGGER ${name};`); }
    }
    if (diff.droppedViews.length > 0) {
      note("Drop views (present in target only)");
      for (const name of diff.droppedViews) { statements.push(`DROP VIEW ${name};`); }
    }
    if (diff.droppedProcedures.length > 0) {
      note("Drop procedures (present in target only)");
      for (const name of diff.droppedProcedures) { statements.push(`DROP PROCEDURE ${name};`); }
    }
    if (diff.droppedTables.length > 0) {
      note("Drop tables (present in target only) — DESTRUCTIVE, review carefully");
      for (const name of diff.droppedTables) { statements.push(`DROP TABLE ${name};`); }
    }
    if (diff.droppedGenerators.length > 0) {
      note("Drop generators (present in target only)");
      for (const name of diff.droppedGenerators) { statements.push(`DROP SEQUENCE ${name};`); }
    }
  } else if (diff.droppedTables.length > 0 || diff.droppedViews.length > 0 || diff.droppedProcedures.length > 0
    || diff.droppedTriggers.length > 0 || diff.droppedGenerators.length > 0) {
    note("Objects present in the target only were NOT dropped (pass includeDrops to include them):");
    for (const name of diff.droppedTables) { note(`  table ${name}`); }
    for (const name of diff.droppedViews) { note(`  view ${name}`); }
    for (const name of diff.droppedProcedures) { note(`  procedure ${name}`); }
    for (const name of diff.droppedTriggers) { note(`  trigger ${name}`); }
    for (const name of diff.droppedGenerators) { note(`  generator ${name}`); }
  }

  if (statements.length === 0) {
    return "-- No changes detected between the project snapshot and the target database.";
  }

  return statements.join("\n\n");
}

/**
 * A column type/length/subtype change is emitted as a single ALTER COLUMN ... TYPE statement;
 * NOT NULL and DEFAULT changes are their own separate ALTER COLUMN statements — all three
 * confirmed as distinct, valid Firebird 4/5 syntax directly against a live server (there is no
 * combined single-statement form). Order: type, then NOT NULL, then default — a NOT NULL change on
 * a column whose type is also changing is safe to issue right after the type change since Firebird
 * validates NOT NULL against the table's *current* data at the time the statement runs, not a
 * cached pre-change state.
 */
function buildColumnAlterStatements(tableName: string, change: ColumnChange): string[] {
  const statements: string[] = [];
  const { source, target } = change;

  const typeChanged = source.type !== target.type || source.length !== target.length
    || (source.subType ?? 0) !== (target.subType ?? 0)
    || (source.precision ?? 0) !== (target.precision ?? 0)
    || (source.scale ?? 0) !== (target.scale ?? 0);
  if (typeChanged) {
    statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${change.name} TYPE ${columnTypeToDDL(source)};`);
  }

  if (source.notNull !== target.notNull) {
    statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${change.name} ${source.notNull ? "SET" : "DROP"} NOT NULL;`);
  }

  if ((source.dflt ?? "") !== (target.dflt ?? "")) {
    statements.push(source.dflt
      ? `ALTER TABLE ${tableName} ALTER COLUMN ${change.name} SET DEFAULT ${source.dflt};`
      : `ALTER TABLE ${tableName} ALTER COLUMN ${change.name} DROP DEFAULT;`);
  }

  return statements;
}
