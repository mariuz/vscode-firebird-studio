/**
 * Builds an OpenAPI 3.0 spec (paths + component schemas, one CRUD route set per table) from a
 * SchemaGraph — the same model the Schema Designer/schema-diff already assemble from
 * getSchemaColumnsQuery(). No vscode/Driver dependency, so it's unit-testable without a database,
 * matching schema-graph.ts's own convention.
 *
 * Per the design doc (docs/roadmap/data-api-builder.md), this is Option A: a reviewable artifact
 * generated for the user's own backend, not a bundled server the extension runs itself — the spec
 * is meant to be opened as plain text for review, the same as this extension's generated DDL.
 *
 * JSON, not YAML: OpenAPI supports both equally, and JSON needs no new serialization dependency
 * (no YAML library is vendored in this extension today).
 */

import { SchemaGraph, SchemaTable, SchemaColumn } from "../schema-designer/schema-graph";

export type TableAccess = "full" | "read-only";

export interface OpenApiSpecOptions {
  title?: string;
  version?: string;
  /**
   * Per-table access override, keyed by table name (docs/roadmap/data-api-builder.md phase 3 —
   * Copilot-assisted scoping, e.g. "expose customers and orders as read-only"). When set, a table
   * *not* present here is excluded from the generated spec entirely — this is both the inclusion
   * list and the access level in one map, so there's no separate "which tables" option to keep in
   * sync with it. Leaving this option unset (the default, used by the plain "generate for the
   * whole schema" command) includes every table with full CRUD access, exactly as before this
   * option existed.
   */
  tableAccess?: Record<string, TableAccess>;
}

interface JsonSchemaType {
  type: string;
  format?: string;
}

/** Firebird's own RDB$FIELD_TYPE names (see getSchemaColumnsQuery()'s CASE) -> JSON Schema type/format. */
const FIREBIRD_TYPE_TO_JSON_SCHEMA: Record<string, JsonSchemaType> = {
  SMALLINT: { type: "integer" },
  INTEGER: { type: "integer" },
  INT64: { type: "integer", format: "int64" },
  FLOAT: { type: "number", format: "float" },
  DOUBLE: { type: "number", format: "double" },
  D_FLOAT: { type: "number" },
  DATE: { type: "string", format: "date" },
  TIME: { type: "string" },
  TIMESTAMP: { type: "string", format: "date-time" },
  CHAR: { type: "string" },
  VARCHAR: { type: "string" },
  CSTRING: { type: "string" },
  BLOB: { type: "string" },
  QUAD: { type: "string" },
};

/** Exported for unit testing. Unknown/UNKNOWN Firebird types fall back to a bare string schema. */
export function jsonSchemaForColumn(column: SchemaColumn): Record<string, any> {
  const mapped = FIREBIRD_TYPE_TO_JSON_SCHEMA[column.type] ?? { type: "string" };
  const schema: Record<string, any> = { ...mapped };
  if ((column.type === "VARCHAR" || column.type === "CHAR") && column.length) {
    schema.maxLength = column.length;
  }
  if (!column.notNull) {
    schema.nullable = true;
  }
  return schema;
}

function buildTableSchema(table: SchemaTable): Record<string, any> {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  table.columns.forEach(col => {
    properties[col.name] = jsonSchemaForColumn(col);
    if (col.notNull) {
      required.push(col.name);
    }
  });
  const schema: Record<string, any> = { type: "object", properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

function primaryKeyColumns(table: SchemaTable): SchemaColumn[] {
  return table.columns.filter(c => c.isPrimaryKey);
}

/** e.g. "orders/{id}" or "order_items/{order_id}/{line_no}" for a composite key. */
function itemPathSuffix(table: SchemaTable): string {
  return primaryKeyColumns(table).map(c => `{${c.name}}`).join("/");
}

/** access "read-only" omits POST/PUT/DELETE — only the GET (list, and get-by-PK if there is one) operations are generated. */
function buildTablePaths(table: SchemaTable, access: TableAccess = "full"): Record<string, any> {
  const schemaRef = { $ref: `#/components/schemas/${table.name}` };
  const listPath = `/${table.name.toLowerCase()}`;
  const listOperations: Record<string, any> = {
    get: {
      summary: `List ${table.name}`,
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: { type: "array", items: schemaRef } } } },
      },
    },
  };
  if (access === "full") {
    listOperations.post = {
      summary: `Create a ${table.name} row`,
      requestBody: { required: true, content: { "application/json": { schema: schemaRef } } },
      responses: {
        "201": { description: "Created", content: { "application/json": { schema: schemaRef } } },
      },
    };
  }
  const paths: Record<string, any> = { [listPath]: listOperations };

  const pkColumns = primaryKeyColumns(table);
  if (pkColumns.length > 0) {
    const itemPath = `${listPath}/${itemPathSuffix(table)}`;
    const itemOperations: Record<string, any> = {
      parameters: pkColumns.map(col => ({ name: col.name, in: "path", required: true, schema: jsonSchemaForColumn(col) })),
      get: {
        summary: `Get one ${table.name} row by primary key`,
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: schemaRef } } },
          "404": { description: "Not found" },
        },
      },
    };
    if (access === "full") {
      itemOperations.put = {
        summary: `Update a ${table.name} row`,
        requestBody: { required: true, content: { "application/json": { schema: schemaRef } } },
        responses: { "200": { description: "OK", content: { "application/json": { schema: schemaRef } } }, "404": { description: "Not found" } },
      };
      itemOperations.delete = {
        summary: `Delete a ${table.name} row`,
        responses: { "204": { description: "Deleted" }, "404": { description: "Not found" } },
      };
    }
    paths[itemPath] = itemOperations;
  }

  return paths;
}

/**
 * Builds a full OpenAPI 3.0 document — a CRUD route set per table, or a scoped-down subset per
 * options.tableAccess (which tables to include, and whether each gets full CRUD or GET-only).
 */
export function buildOpenApiSpec(graph: SchemaGraph, options: OpenApiSpecOptions = {}): Record<string, any> {
  const paths: Record<string, any> = {};
  const schemas: Record<string, any> = {};

  const tables = options.tableAccess
    ? graph.tables.filter(t => options.tableAccess![t.name] !== undefined)
    : graph.tables;

  tables.forEach(table => {
    const access = options.tableAccess?.[table.name] ?? "full";
    schemas[table.name] = buildTableSchema(table);
    Object.assign(paths, buildTablePaths(table, access));
  });

  return {
    openapi: "3.0.3",
    info: { title: options.title ?? "Firebird Data API", version: options.version ?? "1.0.0" },
    paths,
    components: { schemas },
  };
}
