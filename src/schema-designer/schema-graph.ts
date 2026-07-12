/**
 * Assembles the raw rows from getSchemaColumnsQuery()/getForeignKeysQuery() into a SchemaGraph
 * — the shape the Schema Designer's webview renders as an ER diagram and edits in place. Kept
 * free of any vscode/Driver dependency so it's unit-testable without a database.
 */

export interface SchemaColumn {
  name: string;
  type: string;
  length: number;
  notNull: boolean;
  isPrimaryKey: boolean;
  /** Bare default value expression (no leading "DEFAULT" keyword), if any. */
  dflt?: string;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
}

export interface SchemaRelationship {
  constraintName: string;
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export interface SchemaGraph {
  tables: SchemaTable[];
  relationships: SchemaRelationship[];
}

/** Row shape returned by getSchemaColumnsQuery(). */
export interface SchemaColumnRow {
  TABLE_NAME: string;
  FIELD_NAME: string;
  FIELD_TYPE: string;
  FIELD_LENGTH: number | null;
  NOT_NULL: number;
  IS_PRIMARY_KEY: number;
  /** Raw RDB$DEFAULT_SOURCE text (e.g. "DEFAULT 0"), or null/empty if there's no default. */
  DFLT_VALUE?: string | null;
}

/** Row shape returned by getForeignKeysQuery(). */
export interface ForeignKeyRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  CONSTRAINT_NAME: string;
  REF_TABLE_NAME: string;
  REF_COLUMN_NAME: string;
}

/** Strips a leading "DEFAULT" keyword from RDB$DEFAULT_SOURCE, leaving just the value expression. */
function normalizeDefault(raw: string | null | undefined): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^DEFAULT\s+/i, "").trim() || undefined;
}

/**
 * Groups column rows by table (in query order, so columns stay in RDB$FIELD_POSITION order) and
 * attaches the foreign key relationships, ready for the webview to lay out, draw, and edit.
 */
export function buildSchemaGraph(columnRows: SchemaColumnRow[], fkRows: ForeignKeyRow[]): SchemaGraph {
  const tablesByName = new Map<string, SchemaTable>();

  for (const row of columnRows) {
    const tableName = row.TABLE_NAME.trim();
    let table = tablesByName.get(tableName);
    if (!table) {
      table = { name: tableName, columns: [] };
      tablesByName.set(tableName, table);
    }
    table.columns.push({
      name: row.FIELD_NAME.trim(),
      type: row.FIELD_TYPE.trim(),
      length: row.FIELD_LENGTH ?? 0,
      notNull: !!row.NOT_NULL,
      isPrimaryKey: !!row.IS_PRIMARY_KEY,
      dflt: normalizeDefault(row.DFLT_VALUE),
    });
  }

  const relationships: SchemaRelationship[] = fkRows.map(row => ({
    constraintName: row.CONSTRAINT_NAME.trim(),
    table: row.TABLE_NAME.trim(),
    column: row.COLUMN_NAME.trim(),
    refTable: row.REF_TABLE_NAME.trim(),
    refColumn: row.REF_COLUMN_NAME.trim(),
  }));

  return {
    tables: Array.from(tablesByName.values()),
    relationships,
  };
}
