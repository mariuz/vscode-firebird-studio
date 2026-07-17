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
  ProjectInput, ProcedureSource, TriggerSource, ViewSource, DomainSource, ExceptionSource, RoleSource, UserSource,
  buildTableCreateDDL, buildForeignKeyDDL, buildProcedureCreateDDL, buildTriggerCreateDDL,
  buildViewCreateDDL, buildGeneratorCreateDDL, buildDomainCreateDDL, buildExceptionCreateDDL,
  buildRoleCreateDDL, buildUserCreateDDL, columnTypeToDDL,
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

export interface DomainChange {
  name: string;
  source: DomainSource;
  target: DomainSource;
}

export interface PublishDiff {
  newTables: SchemaTable[];
  droppedTables: string[];
  modifiedTables: TableDiff[];
  newForeignKeys: SchemaRelationship[];
  droppedForeignKeys: SchemaRelationship[];
  newDomains: DomainSource[];
  changedDomains: DomainChange[];
  droppedDomains: string[];
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
  newExceptions: ExceptionSource[];
  changedExceptions: ExceptionSource[];
  droppedExceptions: string[];
  newRoles: RoleSource[];
  droppedRoles: string[];
  newUsers: UserSource[];
  droppedUsers: string[];
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

/** Diffs by name (no rename detection — see this module's top-of-file comment); a name present in both but not `equal()` is "changed". Generic over whatever "equal" means for T — a DDL-body string compare for views/procedures/triggers/exceptions, a structural field compare for domains. */
function diffNamed<T extends { name: string }>(
  source: T[],
  target: T[],
  equal: (a: T, b: T) => boolean
): { added: T[]; changed: T[]; dropped: string[] } {
  const sourceMap = new Map(source.map(x => [x.name, x]));
  const targetMap = new Map(target.map(x => [x.name, x]));

  const added = source.filter(x => !targetMap.has(x.name));
  const changed = source.filter(x => {
    const t = targetMap.get(x.name);
    return !!t && !equal(x, t);
  });
  const dropped = target.filter(x => !sourceMap.has(x.name)).map(x => x.name);

  return { added, changed, dropped };
}

function sourceEqual(a: { source: string }, b: { source: string }): boolean {
  return a.source.trim() === b.source.trim();
}

function domainsEqual(a: DomainSource, b: DomainSource): boolean {
  return a.type === b.type
    && a.length === b.length
    && (a.subType ?? 0) === (b.subType ?? 0)
    && (a.precision ?? 0) === (b.precision ?? 0)
    && (a.scale ?? 0) === (b.scale ?? 0)
    && a.notNull === b.notNull
    && (a.dflt ?? "") === (b.dflt ?? "")
    && (a.check ?? "") === (b.check ?? "");
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

  const viewsDiff = diffNamed(source.views, target.views, sourceEqual);
  const proceduresDiff = diffNamed(source.procedures, target.procedures, sourceEqual);
  const triggersDiff = diffNamed(source.triggers, target.triggers, sourceEqual);
  const exceptionsDiff = diffNamed(source.exceptions, target.exceptions, (a, b) => a.message === b.message);

  const sourceGens = new Set(source.generators);
  const targetGens = new Set(target.generators);
  const newGenerators = source.generators.filter(g => !targetGens.has(g));
  const droppedGenerators = target.generators.filter(g => !sourceGens.has(g));

  const sourceDomains = new Map(source.domains.map(d => [d.name, d]));
  const targetDomains = new Map(target.domains.map(d => [d.name, d]));
  const newDomains = source.domains.filter(d => !targetDomains.has(d.name));
  const droppedDomains = target.domains.filter(d => !sourceDomains.has(d.name)).map(d => d.name);
  const changedDomains: DomainChange[] = [];
  for (const sourceDomain of source.domains) {
    const targetDomain = targetDomains.get(sourceDomain.name);
    if (targetDomain && !domainsEqual(sourceDomain, targetDomain)) {
      changedDomains.push({ name: sourceDomain.name, source: sourceDomain, target: targetDomain });
    }
  }

  // Roles/users have no "changed" concept: a role has no other properties, and a user's only
  // extractable property (its name) either matches or it's a different user entirely — see
  // UserSource's doc comment for why a password can't be part of this comparison at all.
  const sourceRoleNames = new Set(source.roles.map(r => r.name));
  const targetRoleNames = new Set(target.roles.map(r => r.name));
  const newRoles = source.roles.filter(r => !targetRoleNames.has(r.name));
  const droppedRoles = target.roles.filter(r => !sourceRoleNames.has(r.name)).map(r => r.name);

  const sourceUserNames = new Set(source.users.map(u => u.name));
  const targetUserNames = new Set(target.users.map(u => u.name));
  const newUsers = source.users.filter(u => !targetUserNames.has(u.name));
  const droppedUsers = target.users.filter(u => !sourceUserNames.has(u.name)).map(u => u.name);

  return {
    newTables, droppedTables, modifiedTables,
    newForeignKeys, droppedForeignKeys,
    newDomains, changedDomains, droppedDomains,
    newViews: viewsDiff.added, changedViews: viewsDiff.changed, droppedViews: viewsDiff.dropped,
    newProcedures: proceduresDiff.added, changedProcedures: proceduresDiff.changed, droppedProcedures: proceduresDiff.dropped,
    newTriggers: triggersDiff.added, changedTriggers: triggersDiff.changed, droppedTriggers: triggersDiff.dropped,
    newGenerators, droppedGenerators,
    newExceptions: exceptionsDiff.added, changedExceptions: exceptionsDiff.changed, droppedExceptions: exceptionsDiff.dropped,
    newRoles, droppedRoles,
    newUsers, droppedUsers,
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
 *      can be re-added by their original constraint name in step 7.
 *   2. Column changes on existing tables (drop, alter type/null/default, add).
 *   3. PK changes on existing tables (drop old constraint by its real name — Firebird has no
 *      "DROP PRIMARY KEY" shorthand, confirmed directly against a live server — then add the new one).
 *   4. New generators (CREATE SEQUENCE) — deliberately *first* among "new object" sections, not
 *      grouped with the rest: confirmed directly against a live server that actually running a
 *      generated script fails with "Generator ... is not defined" the moment a trigger body or a
 *      table column DEFAULT calls GEN_ID() on a generator whose own CREATE SEQUENCE hasn't run
 *      yet (a common auto-incrementing-key pattern). This was a real, pre-existing ordering bug
 *      (generators used to be emitted dead last) surfaced by actually executing a generated
 *      script rather than only reviewing it, the same way the bugs documented in
 *      docs/roadmap/database-projects.md's "Four real bugs found and fixed" section were found.
 *   5. New/changed domains (CREATE DOMAIN for new; ALTER DOMAIN clause-by-clause for changed —
 *      Firebird has no "CREATE OR ALTER DOMAIN", confirmed live).
 *   6. CREATE TABLE for new tables.
 *   7. ADD CONSTRAINT for new FKs and any FK cycled out in step 1.
 *   8. New/changed exceptions (CREATE OR ALTER EXCEPTION) — deliberately *before* procedures/
 *      triggers, not just grouped with them: confirmed directly against a live server that
 *      CREATE PROCEDURE/TRIGGER fails outright if any exception it raises doesn't already exist.
 *   9. CREATE OR ALTER for new/changed procedures, triggers, views; CREATE ROLE for new roles;
 *      CREATE USER (commented out — see buildUserCreateDDL()'s doc comment) for new users.
 *   10. (only with includeDrops) DROP TRIGGER/VIEW/PROCEDURE, *then* DROP EXCEPTION (procedures/
 *      triggers that reference an exception must be dropped first, confirmed live — the reverse
 *      of step 8's ordering requirement), then DROP TABLE, DROP DOMAIN (after tables, since a
 *      domain still used by a table column can't be dropped, confirmed live), DROP SEQUENCE,
 *      DROP ROLE, DROP USER.
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

  if (diff.newGenerators.length > 0) {
    // Emitted early, not grouped with the rest of "new objects" below: a real, pre-existing
    // ordering bug (predates this phase's domains/exceptions/roles/users work) had generators
    // emitted dead last, after procedures/triggers — confirmed live that actually running the
    // generated script fails with "Generator ... is not defined" the moment a trigger body calls
    // GEN_ID() on a generator whose own CREATE SEQUENCE hasn't run yet (a common auto-incrementing-
    // key pattern). A table column DEFAULT or a procedure body can reference a generator the same
    // way, so generators go first, before anything that might reference one.
    note("New generators");
    for (const name of diff.newGenerators) {
      statements.push(buildGeneratorCreateDDL(name));
    }
  }

  if (diff.newDomains.length > 0 || diff.changedDomains.length > 0) {
    note("New/changed domains");
    for (const domain of diff.newDomains) {
      statements.push(buildDomainCreateDDL(domain));
    }
    for (const change of diff.changedDomains) {
      statements.push(...buildDomainAlterStatements(change));
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

  if (diff.newExceptions.length > 0 || diff.changedExceptions.length > 0) {
    note("New/changed exceptions (before procedures/triggers, which may reference them)");
    for (const exception of [...diff.newExceptions, ...diff.changedExceptions]) {
      statements.push(buildExceptionCreateDDL(exception));
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

  if (diff.newRoles.length > 0) {
    note("New roles");
    for (const role of diff.newRoles) {
      statements.push(buildRoleCreateDDL(role));
    }
  }

  if (diff.newUsers.length > 0) {
    note("New users (commented out — Firebird cannot export a real password; see buildUserCreateDDL())");
    for (const user of diff.newUsers) {
      statements.push(buildUserCreateDDL(user));
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
    if (diff.droppedExceptions.length > 0) {
      note("Drop exceptions (present in target only — after procedures/triggers, which may reference them)");
      for (const name of diff.droppedExceptions) { statements.push(`DROP EXCEPTION ${name};`); }
    }
    if (diff.droppedTables.length > 0) {
      note("Drop tables (present in target only) — DESTRUCTIVE, review carefully");
      for (const name of diff.droppedTables) { statements.push(`DROP TABLE ${name};`); }
    }
    if (diff.droppedDomains.length > 0) {
      note("Drop domains (present in target only — after tables, which may still use them)");
      for (const name of diff.droppedDomains) { statements.push(`DROP DOMAIN ${name};`); }
    }
    if (diff.droppedGenerators.length > 0) {
      note("Drop generators (present in target only)");
      for (const name of diff.droppedGenerators) { statements.push(`DROP SEQUENCE ${name};`); }
    }
    if (diff.droppedRoles.length > 0) {
      note("Drop roles (present in target only)");
      for (const name of diff.droppedRoles) { statements.push(`DROP ROLE ${name};`); }
    }
    if (diff.droppedUsers.length > 0) {
      note("Drop users (present in target only) — DESTRUCTIVE, review carefully");
      for (const name of diff.droppedUsers) { statements.push(`DROP USER ${name};`); }
    }
  } else if (diff.droppedTables.length > 0 || diff.droppedViews.length > 0 || diff.droppedProcedures.length > 0
    || diff.droppedTriggers.length > 0 || diff.droppedGenerators.length > 0 || diff.droppedDomains.length > 0
    || diff.droppedExceptions.length > 0 || diff.droppedRoles.length > 0 || diff.droppedUsers.length > 0) {
    note("Objects present in the target only were NOT dropped (pass includeDrops to include them):");
    for (const name of diff.droppedTables) { note(`  table ${name}`); }
    for (const name of diff.droppedViews) { note(`  view ${name}`); }
    for (const name of diff.droppedProcedures) { note(`  procedure ${name}`); }
    for (const name of diff.droppedTriggers) { note(`  trigger ${name}`); }
    for (const name of diff.droppedGenerators) { note(`  generator ${name}`); }
    for (const name of diff.droppedDomains) { note(`  domain ${name}`); }
    for (const name of diff.droppedExceptions) { note(`  exception ${name}`); }
    for (const name of diff.droppedRoles) { note(`  role ${name}`); }
    for (const name of diff.droppedUsers) { note(`  user ${name}`); }
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

/**
 * A domain change is emitted as one ALTER DOMAIN statement per changed aspect (type, default,
 * NOT NULL, CHECK) — all confirmed as distinct, valid syntax directly against a live server, the
 * same "type, then NOT NULL, then default" convention buildColumnAlterStatements() already uses
 * for table columns. CHECK is different from the other three: Firebird allows at most one CHECK
 * constraint per domain at a time (confirmed live — a second ADD CONSTRAINT fails outright), so a
 * changed CHECK is DROP CONSTRAINT (only if the target actually had one) followed by ADD CONSTRAINT
 * (only if the source has one) rather than a single statement — source.check/target.check already
 * carry their own "CHECK (...)" wrapper text (see DomainSource's doc comment), so ADD CONSTRAINT
 * just appends it directly.
 */
function buildDomainAlterStatements(change: DomainChange): string[] {
  const statements: string[] = [];
  const { source, target } = change;

  const typeChanged = source.type !== target.type || source.length !== target.length
    || (source.subType ?? 0) !== (target.subType ?? 0)
    || (source.precision ?? 0) !== (target.precision ?? 0)
    || (source.scale ?? 0) !== (target.scale ?? 0);
  if (typeChanged) {
    statements.push(`ALTER DOMAIN ${change.name} TYPE ${columnTypeToDDL(source)};`);
  }

  if (source.notNull !== target.notNull) {
    statements.push(`ALTER DOMAIN ${change.name} ${source.notNull ? "SET" : "DROP"} NOT NULL;`);
  }

  if ((source.dflt ?? "") !== (target.dflt ?? "")) {
    statements.push(source.dflt
      ? `ALTER DOMAIN ${change.name} SET DEFAULT ${source.dflt};`
      : `ALTER DOMAIN ${change.name} DROP DEFAULT;`);
  }

  if ((source.check ?? "") !== (target.check ?? "")) {
    if (target.check) {
      statements.push(`ALTER DOMAIN ${change.name} DROP CONSTRAINT;`);
    }
    if (source.check) {
      statements.push(`ALTER DOMAIN ${change.name} ADD CONSTRAINT ${source.check};`);
    }
  }

  return statements;
}
