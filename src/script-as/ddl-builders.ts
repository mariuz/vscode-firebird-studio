/**
 * Pure DDL builders for the generic "Script as Create" / "Script as Drop" tree actions — one
 * command pair that works regardless of the selected object's type, instead of each type having
 * its own bespoke edit command. No vscode/Driver dependency, unit-testable without a database,
 * matching schema-graph.ts's/database-projects/project-model.ts's own convention.
 *
 * Tables/views/procedures/triggers/generators reuse database-projects/project-model.ts's builders
 * directly — that module already solves "reconstruct this object's CREATE statement from live
 * metadata" for Database Projects' Extract command, and this is the same problem for one object
 * instead of the whole database. Domains, exceptions, and indexes get their own builders here,
 * since Database Projects doesn't extract those object types.
 */

import { SchemaColumn, SchemaTable, normalizeDefault } from "../schema-designer/schema-graph";
import { columnTypeToDDL } from "../database-projects/project-model";

/** Row shape returned by tableInfoQuery(tableName) — a single table's columns, with a primary-key hint via CONSTRAINT_TYPE. */
export interface TableInfoRow {
  FIELD_NAME: string;
  FIELD_TYPE: string;
  FIELD_LENGTH: number | null;
  FIELD_SUB_TYPE?: number | null;
  FIELD_PRECISION?: number | null;
  FIELD_SCALE?: number | null;
  CONSTRAINT_TYPE?: string | null;
  NOT_NULL: number;
  DFLT_VALUE?: string | null;
}

/** Converts tableInfoQuery()'s rows into the same SchemaTable shape database-projects/project-model.ts's buildTableCreateDDL() already knows how to render. */
export function tableInfoRowsToTable(tableName: string, rows: TableInfoRow[]): SchemaTable {
  const columns: SchemaColumn[] = rows.map(row => ({
    name: row.FIELD_NAME.trim(),
    type: row.FIELD_TYPE.trim(),
    length: row.FIELD_LENGTH ?? 0,
    notNull: !!row.NOT_NULL,
    isPrimaryKey: row.CONSTRAINT_TYPE === "PRIMARY KEY",
    dflt: normalizeDefault(row.DFLT_VALUE),
    subType: row.FIELD_SUB_TYPE ?? undefined,
    precision: row.FIELD_PRECISION ?? undefined,
    scale: row.FIELD_SCALE ?? undefined,
  }));
  return { name: tableName, columns };
}

/** Row shape returned by getDomainsQuery(). */
export interface DomainRow {
  DOMAIN_NAME: string;
  DOMAIN_TYPE: string;
  FIELD_LENGTH: number | null;
  FIELD_SUB_TYPE?: number | null;
  FIELD_PRECISION?: number | null;
  FIELD_SCALE?: number | null;
  NOT_NULL: number;
}

/**
 * Best-effort CREATE DOMAIN reconstruction: getDomainsQuery() doesn't select a default-value
 * source or CHECK constraint text, so neither appears here — this is a known, disclosed gap
 * (matching the same "confirmed, not silently shipped" approach used for the Database Projects
 * NUMERIC/DECIMAL gap this same pass fixed for tables).
 */
export function buildDomainCreateDDL(domain: DomainRow): string {
  const column: SchemaColumn = {
    name: domain.DOMAIN_NAME.trim(),
    type: domain.DOMAIN_TYPE.trim(),
    length: domain.FIELD_LENGTH ?? 0,
    notNull: !!domain.NOT_NULL,
    isPrimaryKey: false,
    subType: domain.FIELD_SUB_TYPE ?? undefined,
    precision: domain.FIELD_PRECISION ?? undefined,
    scale: domain.FIELD_SCALE ?? undefined,
  };
  const notNullClause = column.notNull ? " NOT NULL" : "";
  return `CREATE DOMAIN ${column.name} AS ${columnTypeToDDL(column)}${notNullClause};`;
}

export interface ExceptionInfo {
  name: string;
  message: string;
}

export function buildExceptionCreateDDL(exception: ExceptionInfo): string {
  const escaped = String(exception.message ?? "").replace(/'/g, "''");
  return `CREATE EXCEPTION ${exception.name} '${escaped}';`;
}

export interface IndexInfo {
  name: string;
  table: string;
  columns: string;
  unique: boolean;
}

/** Ordering direction (ASC/DESC) isn't available from getIndexesQuery() today, so this always produces an ascending index — a known, disclosed gap. */
export function buildIndexCreateDDL(index: IndexInfo): string {
  const uniqueKeyword = index.unique ? "UNIQUE " : "";
  return `CREATE ${uniqueKeyword}INDEX ${index.name} ON ${index.table} (${index.columns});`;
}

/**
 * Firebird never exposes an existing user's password via SQL, and this extension never stores
 * one in plaintext either — so unlike every other object type, this can't be a genuine
 * reconstruction of the live object. Opened as a clearly-marked placeholder for the user to fill
 * in, same as this extension's other "create new X" scaffolds, but with an explicit note on why.
 */
export function buildUserCreatePlaceholderDDL(userName: string): string {
  return (
    "-- Firebird does not expose an existing user's password, and this extension never stores\n" +
    "-- one in plaintext -- replace the placeholder below with a real password before running.\n" +
    `CREATE USER ${userName} PASSWORD '<new-password>';`
  );
}
