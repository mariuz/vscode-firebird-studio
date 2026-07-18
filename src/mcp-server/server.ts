#!/usr/bin/env node
/**
 * Standalone MCP server subprocess (docs/roadmap/mcp-server.md) — list_connections, get_schema,
 * run_query, get_query_plan (all read-only), and the opt-in run_write_query. VS Code's `vscode.lm.
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
 * FIREBIRD_MCP_AUDIT_LOG_PATH (also set there) is where run_write_query appends one JSON line per
 * write attempt — this subprocess has no VS Code UI to confirm or even display anything with, so
 * the extension host relays that file's new lines into its own output channel instead (see
 * src/mcp-server/index.ts's startAuditLogWatcher()).
 *
 * IMPORTANT: stdout is the MCP JSON-RPC message stream itself — never `console.log` here, only
 * `console.error` (stderr), or a stray line corrupts the protocol stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as Firebird from "node-firebird";
import { appendFileSync } from "fs";
import { getSchemaColumnsQuery, getForeignKeysQuery } from "../shared/queries";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from "../schema-designer/schema-graph";
import { validateReadOnlyStatement, validateWriteStatement, extractTableNames, buildIndexMetadataQuery, renderIndexMetadataPlan } from "../shared/sql-analysis";

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
  /** docs/roadmap/mcp-server.md's write-query path — a separate, narrower opt-in on top of being exposed at all. Gates run_write_query only; list_connections/get_schema/run_query/get_query_plan are unaffected. */
  writeEnabled: boolean;
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

/**
 * Appends one JSON line to the write-audit log for every run_write_query attempt, success or
 * failure — the only record of a write an *external* MCP client made, since this subprocess has no
 * VS Code UI to confirm or surface anything through directly (see the module doc comment above).
 * Never lets a logging failure (disk full, path unset, whatever) break the actual tool response —
 * this is a best-effort audit trail, not something a write's own success should depend on.
 */
function appendAuditLog(entry: { connectionId: string; sql: string; success: boolean; error?: string }): void {
  const path = process.env.FIREBIRD_MCP_AUDIT_LOG_PATH;
  if (!path) {
    return;
  }
  try {
    appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error("firebird-mcp: could not write to the write-audit log", err);
  }
}

const server = new McpServer({ name: "firebird-mcp", version: "1.0.0" });

server.registerTool(
  "list_connections",
  {
    description: "Lists the Firebird connections this VS Code workspace has explicitly exposed to MCP clients. Never includes credentials. writeEnabled tells you upfront whether run_write_query is allowed for a given connection, without needing to try it first.",
    inputSchema: {},
  },
  async () => {
    const summary = loadExposedConnections().map(c => ({ id: c.id, label: c.label, host: c.host, database: c.database, writeEnabled: c.writeEnabled }));
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

server.registerTool(
  "run_write_query",
  {
    description: "Executes a single INSERT, UPDATE, or DELETE statement against an exposed Firebird connection that has ALSO been explicitly write-enabled (see list_connections' writeEnabled field) — a separate, narrower opt-in on top of being exposed at all, granted from the connection's right-click menu in VS Code ('Toggle MCP Server Write Access'). Any other statement (SELECT/DDL/EXECUTE BLOCK) or more than one statement is rejected — use run_query for SELECT. There is no per-query confirmation dialog: every attempt, successful or not, is logged to this VS Code workspace's MCP write-audit log ('Show MCP Write Audit Log' command) whether or not this call succeeds. Only ever call this after the user has explicitly asked for a specific write, never speculatively.",
    inputSchema: {
      connectionId: z.string().describe("A connection id returned by list_connections, with writeEnabled: true"),
      sql: z.string().describe("A single INSERT, UPDATE, or DELETE statement"),
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
    if (!conn.writeEnabled) {
      const message = `Write access is not enabled for connection "${connectionId}". Enable it from the connection's right-click menu in the Firebird Studio tree in VS Code ("Toggle MCP Server Write Access") first.`;
      appendAuditLog({ connectionId, sql, success: false, error: message });
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }

    const rejection = validateWriteStatement(sql);
    if (rejection) {
      appendAuditLog({ connectionId, sql, success: false, error: rejection });
      return { content: [{ type: "text" as const, text: rejection }], isError: true };
    }

    let db: Firebird.Database | undefined;
    try {
      db = await connect(conn);
      const rows = await query(db, sql);
      appendAuditLog({ connectionId, sql, success: true });
      // rows is populated only if the statement had a RETURNING clause (node-firebird returns
      // undefined for a plain DML statement with no result set) -- surface it when present, same
      // as the rest of this extension already treats a RETURNING result.
      const text = rows !== undefined ? JSON.stringify(rows, null, 2) : "Statement executed successfully.";
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      appendAuditLog({ connectionId, sql, success: false, error: message });
      return { content: [{ type: "text" as const, text: `Write failed: ${message}` }], isError: true };
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
