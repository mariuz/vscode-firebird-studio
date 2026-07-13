/**
 * Pure schema-as-code model for the Database Projects feature (Extract + Build). No vscode/fs/
 * Driver dependency — unit-testable without a database, matching schema-graph.ts's/openapi-spec.ts's
 * own convention. See docs/roadmap/database-projects.md for the overall design and known gaps.
 */

import { SchemaGraph, SchemaTable, SchemaColumn, SchemaRelationship } from "../schema-designer/schema-graph";

export interface ProcedureSource {
  name: string;
  source: string;
}

export interface TriggerSource {
  name: string;
  table: string;
  inactive: boolean;
  /** RDB$TRIGGER_TYPE — simple single-event encoding only (1-6); see describeTriggerType(). */
  type: number;
  source: string;
}

/**
 * Decodes RDB$TRIGGER_TYPE's simple single-event encoding into the BEFORE/AFTER <event> clause
 * CREATE TRIGGER needs. Firebird also supports combined multi-event triggers (a different, more
 * complex bitmask-based encoding) — out of scope here, matching the pre-existing tree tooltip's
 * own scope (see the identical switch this replaces in src/nodes/node-trigger.ts).
 */
export function describeTriggerType(type: number): string {
  switch (type) {
    case 1: return "BEFORE INSERT";
    case 2: return "AFTER INSERT";
    case 3: return "BEFORE UPDATE";
    case 4: return "AFTER UPDATE";
    case 5: return "BEFORE DELETE";
    case 6: return "AFTER DELETE";
    default: return `TYPE ${type}`;
  }
}

export interface ViewSource {
  name: string;
  source: string;
}

export interface ProjectInput {
  graph: SchemaGraph;
  procedures: ProcedureSource[];
  triggers: TriggerSource[];
  views: ViewSource[];
  generators: string[];
  /** Table name -> primary key constraint name, from getAllPrimaryKeyConstraintNamesQuery(). Needed by publish-model.ts to DROP CONSTRAINT a changing PK by its real name — Firebird has no "DROP PRIMARY KEY" shorthand (confirmed directly against a live server). */
  pkConstraintNames: Record<string, string>;
}

export interface ProjectFile {
  /** Relative to the project's destination folder, forward-slash separated. */
  path: string;
  content: string;
}

export const MANIFEST_FILE_NAME = "firebird.project.json";
const FOREIGN_KEYS_FILE = "foreign-keys.sql";

/**
 * Reconstructs a column's DDL type from getSchemaColumnsQuery()'s bare Firebird type name +
 * length, or — for a NUMERIC/DECIMAL column — from RDB$FIELD_SUB_TYPE/PRECISION/SCALE instead,
 * since NUMERIC/DECIMAL are stored as an underlying INTEGER/BIGINT/DOUBLE type in RDB$FIELDS with
 * no trace of the declared precision/scale in the bare type name alone. Confirmed directly
 * against a live Firebird server (not assumed): RDB$FIELD_SUB_TYPE is 1 for NUMERIC, 2 for
 * DECIMAL, 0/null for a plain (non-fixed-point) column; RDB$FIELD_SCALE is negative, so decimal
 * places = -scale. Exported for testing.
 */
export function columnTypeToDDL(column: SchemaColumn): string {
  if ((column.subType === 1 || column.subType === 2) && column.precision) {
    const kind = column.subType === 1 ? "NUMERIC" : "DECIMAL";
    const scale = column.scale ? -column.scale : 0;
    return `${kind}(${column.precision},${scale})`;
  }

  switch (column.type) {
    case "VARCHAR":
      return `VARCHAR(${column.length || 1})`;
    case "CHAR":
      return `CHAR(${column.length || 1})`;
    case "CSTRING":
      // Not a valid column type in DDL (it's a parameter/host-variable type) — best-effort VARCHAR.
      return `VARCHAR(${column.length || 1})`;
    case "INT64":
      return "BIGINT";
    case "DOUBLE":
    case "D_FLOAT":
      return "DOUBLE PRECISION";
    case "BLOB":
    case "SMALLINT":
    case "INTEGER":
    case "FLOAT":
    case "DATE":
    case "TIME":
    case "TIMESTAMP":
      return column.type;
    default:
      return "VARCHAR(255)";
  }
}

/** Exported for testing. */
export function buildTableCreateDDL(table: SchemaTable): string {
  const lines = table.columns.map(col => {
    const parts = [`  ${col.name} ${columnTypeToDDL(col)}`];
    if (col.dflt) {
      parts.push(`DEFAULT ${col.dflt}`);
    }
    if (col.notNull) {
      parts.push("NOT NULL");
    }
    return parts.join(" ");
  });

  const pkColumns = table.columns.filter(c => c.isPrimaryKey).map(c => c.name);
  if (pkColumns.length > 0) {
    lines.push(`  PRIMARY KEY (${pkColumns.join(", ")})`);
  }

  return `CREATE TABLE ${table.name} (\n${lines.join(",\n")}\n);`;
}

/** Exported for testing. Firebird has no composite-FK support in SchemaRelationship today (one column pair per relationship — see schema-graph.ts). */
export function buildForeignKeyDDL(rel: SchemaRelationship): string {
  return `ALTER TABLE ${rel.table} ADD CONSTRAINT ${rel.constraintName} FOREIGN KEY (${rel.column}) REFERENCES ${rel.refTable} (${rel.refColumn});`;
}

/**
 * CREATE OR ALTER is used for procedures/triggers/views (not tables, which have no such syntax)
 * so a project's files are safe to (re)run against either a fresh database or one that already
 * has the object.
 *
 * RDB$TRIGGER_SOURCE/RDB$VIEW_SOURCE already contain everything after the object's name (ACTIVE
 * ... AS ... body, or just the SELECT) — but RDB$PROCEDURE_SOURCE, unlike triggers, **never**
 * includes the "AS" keyword, confirmed directly against a live server across three shapes
 * (no params, params+RETURNS, and a bare DECLARE section): it always starts right at BEGIN or
 * DECLARE. A prior comment here claimed otherwise ("already contain ... AS ... confirmed against
 * NodeProcedure#editProcedure()") — that claim was never actually exercised by execution, only by
 * a human reviewing an opened scaffold, so the missing "AS" went unnoticed until Publish/migrate
 * (Phase 3) actually ran the generated script and Firebird rejected it as a syntax error at
 * "BEGIN". NodeProcedure#editProcedure() has the same bug, fixed alongside this.
 *
 * Each of these three ends with an explicit trailing ";" (unlike the raw RDB$*_SOURCE text, which
 * never has one) — also found necessary while building Publish/migrate: without it, several of
 * these concatenated together with no SET TERM (as buildPublishScript() does) have no way for
 * src/shared/sql-splitter.ts to know where one CREATE OR ALTER ends and the next object's DDL
 * begins once the PSQL block's BEGIN/END depth returns to 0 — it just keeps accumulating into one
 * oversized "statement" until it finds the next real ";", silently merging unrelated objects'
 * DDL together. buildTableCreateDDL()/buildForeignKeyDDL() already ended with ";"; this brings
 * the PSQL-body builders in line with that same convention.
 */
export function buildProcedureCreateDDL(procedure: ProcedureSource): string {
  return `CREATE OR ALTER PROCEDURE ${procedure.name}\nAS\n${procedure.source.trim()};`;
}

/**
 * RDB$TRIGGER_SOURCE, unlike RDB$PROCEDURE_SOURCE, already includes "AS" — but it never includes
 * the "FOR <table> {ACTIVE|INACTIVE} {BEFORE|AFTER} <event>" header CREATE TRIGGER requires,
 * confirmed directly against a live server. This was a real, pre-existing gap (not introduced
 * while building Publish/migrate, just exposed by it): every trigger Extract/Build/Publish ever
 * reconstructed was missing this header entirely, a syntax error the moment it was actually run —
 * previously unnoticed since Extract's output was only ever manually reviewed, never executed.
 */
export function buildTriggerCreateDDL(trigger: TriggerSource): string {
  const state = trigger.inactive ? "INACTIVE" : "ACTIVE";
  const header = `FOR ${trigger.table} ${state} ${describeTriggerType(trigger.type)}`;
  return `CREATE OR ALTER TRIGGER ${trigger.name}\n${header}\n${trigger.source.trim()};`;
}

export function buildViewCreateDDL(view: ViewSource): string {
  return `CREATE OR ALTER VIEW ${view.name} AS\n${view.source.trim()};`;
}

export function buildGeneratorCreateDDL(name: string): string {
  return `CREATE SEQUENCE ${name};`;
}

/** Replaces anything not safe in a cross-platform filename with "_" (Firebird identifiers are almost always already filesystem-safe; this guards delimited/quoted exceptions). */
export function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Builds every project file (including the manifest itself, always first) in a dependency-safe
 * order: tables, then foreign keys (added only once every table exists), then views, procedures,
 * triggers, and generators — the same order the manifest's "files" list records for Build to
 * concatenate later.
 */
export function buildProjectFiles(input: ProjectInput): ProjectFile[] {
  const files: ProjectFile[] = [];

  input.graph.tables.forEach(table => {
    files.push({ path: `tables/${sanitizeFileName(table.name)}.sql`, content: buildTableCreateDDL(table) });
  });

  if (input.graph.relationships.length > 0) {
    const fkSql = input.graph.relationships.map(buildForeignKeyDDL).join("\n\n");
    files.push({ path: FOREIGN_KEYS_FILE, content: fkSql });
  }

  input.views.forEach(view => {
    files.push({ path: `views/${sanitizeFileName(view.name)}.sql`, content: buildViewCreateDDL(view) });
  });

  input.procedures.forEach(proc => {
    files.push({ path: `procedures/${sanitizeFileName(proc.name)}.sql`, content: buildProcedureCreateDDL(proc) });
  });

  input.triggers.forEach(trigger => {
    files.push({ path: `triggers/${sanitizeFileName(trigger.name)}.sql`, content: buildTriggerCreateDDL(trigger) });
  });

  input.generators.forEach(name => {
    files.push({ path: `generators/${sanitizeFileName(name)}.sql`, content: buildGeneratorCreateDDL(name) });
  });

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: files.map(f => f.path),
  };
  files.unshift({ path: MANIFEST_FILE_NAME, content: JSON.stringify(manifest, null, 2) });

  return files;
}
