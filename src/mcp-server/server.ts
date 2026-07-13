#!/usr/bin/env node
/**
 * Standalone MCP server subprocess (Phase 2 of docs/roadmap/mcp-server.md: read-only tools only
 * — list_connections + get_schema, no query execution). VS Code's `vscode.lm.
 * registerMcpServerDefinitionProvider` model spawns this as a *separate* child process speaking
 * MCP over stdio — it is NOT part of the extension host and cannot import `vscode` (no such
 * module exists in a plain Node process), so it can't reuse `Driver`/`NodeClient` (which import
 * vscode) or `CredentialStore` (which needs `ExtensionContext.secrets`). It reuses whatever is
 * genuinely dependency-free instead: getSchemaColumnsQuery()/getForeignKeysQuery()/
 * buildSchemaGraph() from the main extension's own shared modules.
 *
 * Connection details for whichever connections the user explicitly exposed (see
 * ConnectionOptions.mcpExposed, toggled from the tree) are handed to this process via the
 * FIREBIRD_MCP_CONNECTIONS environment variable, resolved and populated by the extension host in
 * src/mcp-server/index.ts's resolveMcpServerDefinition() — the same "credentials via env var to a
 * spawned child process," never argv or disk, pattern src/shared/isql-terminal.ts already uses.
 *
 * IMPORTANT: stdout is the MCP JSON-RPC message stream itself — never `console.log` here, only
 * `console.error` (stderr), or a stray line corrupts the protocol stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as Firebird from "node-firebird";
import { getSchemaColumnsQuery, getForeignKeysQuery } from "../shared/queries";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from "../schema-designer/schema-graph";
import { validateReadOnlyStatement, extractTableNames, buildIndexMetadataQuery, renderIndexMetadataPlan } from "../shared/sql-analysis";

interface ExposedConnection {
  id: string;
  label: string;
  host: string;
  port: number | null;
  database: string;
  user: string;
  password: string;
  role: string | null;
  embedded: boolean;
}

function loadExposedConnections(): ExposedConnection[] {
  const raw = process.env.FIREBIRD_MCP_CONNECTIONS;
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("firebird-mcp: could not parse FIREBIRD_MCP_CONNECTIONS", err);
    return [];
  }
}

function connect(conn: ExposedConnection): Promise<Firebird.Database> {
  return new Promise((resolve, reject) => {
    if (conn.embedded) {
      // No native driver in this subprocess (deliberately not bundled — see the design doc);
      // embedded connections require it, matching NodeClient.createConnection()'s own guard.
      reject(new Error("Embedded connections aren't supported by the MCP server yet — only network connections."));
      return;
    }
    Firebird.attach(
      { host: conn.host, port: conn.port ?? 3050, database: conn.database, user: conn.user, password: conn.password, role: conn.role ?? undefined },
      (err, db) => {
        if (err) { reject(err); return; }
        resolve(db);
      }
    );
  });
}

function query<T = any>(db: Firebird.Database, sql: string, args: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.query(sql, args, (err: any, rows: any) => {
      if (err) { reject(err); return; }
      resolve(rows);
    });
  });
}

function detach(db: Firebird.Database): Promise<void> {
  return new Promise(resolve => db.detach(() => resolve()));
}

const server = new McpServer({ name: "firebird-mcp", version: "1.0.0" });

server.registerTool(
  "list_connections",
  {
    description: "Lists the Firebird connections this VS Code workspace has explicitly exposed to MCP clients. Never includes credentials.",
    inputSchema: {},
  },
  async () => {
    const summary = loadExposedConnections().map(c => ({ id: c.id, label: c.label, host: c.host, database: c.database }));
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  }
);

server.registerTool(
  "get_schema",
  {
    description: "Returns the schema (tables, columns, primary keys, and foreign keys) of one exposed Firebird connection.",
    inputSchema: { connectionId: z.string().describe("A connection id returned by list_connections") },
  },
  async ({ connectionId }) => {
    const conn = loadExposedConnections().find(c => c.id === connectionId);
    if (!conn) {
      return {
        content: [{ type: "text" as const, text: `No exposed connection with id "${connectionId}". Call list_connections first.` }],
        isError: true,
      };
    }

    let db: Firebird.Database | undefined;
    try {
      db = await connect(conn);
      const columnRows = await query<SchemaColumnRow>(db, getSchemaColumnsQuery());
      const fkRows = await query<ForeignKeyRow>(db, getForeignKeysQuery());
      const graph = buildSchemaGraph(columnRows, fkRows);
      return { content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Could not fetch schema: ${err?.message ?? err}` }], isError: true };
    } finally {
      if (db) { await detach(db); }
    }
  }
);

server.registerTool(
  "run_query",
  {
    description: "Executes a single read-only SELECT (or WITH ... AS (...) SELECT) statement against an exposed Firebird connection and returns the resulting rows as JSON. Any other statement (INSERT/UPDATE/DELETE/DDL/EXECUTE BLOCK) or more than one statement is rejected — this tool is read-only, matching the security model in docs/roadmap/mcp-server.md.",
    inputSchema: {
      connectionId: z.string().describe("A connection id returned by list_connections"),
      sql: z.string().describe("A single SELECT statement"),
    },
  },
  async ({ connectionId, sql }) => {
    const conn = loadExposedConnections().find(c => c.id === connectionId);
    if (!conn) {
      return {
        content: [{ type: "text" as const, text: `No exposed connection with id "${connectionId}". Call list_connections first.` }],
        isError: true,
      };
    }

    const rejection = validateReadOnlyStatement(sql);
    if (rejection) {
      return { content: [{ type: "text" as const, text: rejection }], isError: true };
    }

    let db: Firebird.Database | undefined;
    try {
      db = await connect(conn);
      const rows = await query(db, sql);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Query failed: ${err?.message ?? err}` }], isError: true };
    } finally {
      if (db) { await detach(db); }
    }
  }
);

server.registerTool(
  "get_query_plan",
  {
    description: "Returns Firebird's index-metadata-based execution plan heuristic for a single SELECT statement (this subprocess doesn't bundle the native driver, so it can't request Firebird's real PLAN output — see docs/roadmap/mcp-server.md). Read-only, same restriction as run_query.",
    inputSchema: {
      connectionId: z.string().describe("A connection id returned by list_connections"),
      sql: z.string().describe("A single SELECT statement"),
    },
  },
  async ({ connectionId, sql }) => {
    const conn = loadExposedConnections().find(c => c.id === connectionId);
    if (!conn) {
      return {
        content: [{ type: "text" as const, text: `No exposed connection with id "${connectionId}". Call list_connections first.` }],
        isError: true,
      };
    }

    const rejection = validateReadOnlyStatement(sql);
    if (rejection) {
      return { content: [{ type: "text" as const, text: rejection }], isError: true };
    }

    const tables = extractTableNames(sql);
    if (tables.length === 0) {
      return { content: [{ type: "text" as const, text: renderIndexMetadataPlan(sql, tables, []) }] };
    }

    let db: Firebird.Database | undefined;
    try {
      db = await connect(conn);
      const rows = await query(db, buildIndexMetadataQuery(tables), tables);
      return { content: [{ type: "text" as const, text: renderIndexMetadataPlan(sql, tables, rows) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Could not fetch query plan: ${err?.message ?? err}` }], isError: true };
    } finally {
      if (db) { await detach(db); }
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("firebird-mcp: running on stdio");
}

main().catch(err => {
  console.error("firebird-mcp: fatal error", err);
  process.exit(1);
});
