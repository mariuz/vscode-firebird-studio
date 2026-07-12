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
  source: string;
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
}

export interface ProjectFile {
  /** Relative to the project's destination folder, forward-slash separated. */
  path: string;
  content: string;
}

export const MANIFEST_FILE_NAME = "firebird.project.json";
const FOREIGN_KEYS_FILE = "foreign-keys.sql";

/**
 * Best-effort reconstruction of a column's DDL type from getSchemaColumnsQuery()'s bare Firebird
 * type name + length. Known gap: NUMERIC/DECIMAL columns are stored as an underlying integer/
 * double type in RDB$FIELDS (distinguished only by RDB$FIELD_SUB_TYPE/RDB$FIELD_PRECISION/
 * RDB$FIELD_SCALE, none of which getSchemaColumnsQuery() selects today), so a NUMERIC(9,2) column
 * round-trips as plain INTEGER here, losing its declared precision/scale. Exported for testing.
 */
export function columnTypeToDDL(column: SchemaColumn): string {
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
 * has the object — RDB$PROCEDURE_SOURCE/RDB$TRIGGER_SOURCE/RDB$VIEW_SOURCE each already contain
 * everything after the object's name (params/RETURNS/AS/body, or ACTIVE...AS body, or just the
 * SELECT), confirmed against how NodeProcedure#editProcedure()/NodeTrigger#editTrigger()/
 * NodeView#editView() already reconstruct a runnable ALTER from the same source columns.
 */
export function buildProcedureCreateDDL(procedure: ProcedureSource): string {
  return `CREATE OR ALTER PROCEDURE ${procedure.name}\n${procedure.source.trim()}`;
}

export function buildTriggerCreateDDL(trigger: TriggerSource): string {
  return `CREATE OR ALTER TRIGGER ${trigger.name}\n${trigger.source.trim()}`;
}

export function buildViewCreateDDL(view: ViewSource): string {
  return `CREATE OR ALTER VIEW ${view.name} AS\n${view.source.trim()}`;
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
