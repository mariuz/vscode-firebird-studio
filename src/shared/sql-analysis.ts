/**
 * Pure, dependency-free SQL analysis helpers shared between src/shared/driver.ts (the extension
 * host's own NodeClient-fallback execution plan) and src/mcp-server/server.ts — a separate spawned
 * subprocess that can't import driver.ts at all, since that pulls in `vscode`, which doesn't exist
 * in a plain Node process. Kept here so both places use the exact same logic rather than two
 * copies silently drifting apart.
 */

import { splitStatements } from "./sql-splitter";

/**
 * Extracts unqualified table/view names from a SQL SELECT statement's FROM and JOIN clauses.
 * This is a best-effort heuristic for the node-firebird explain-plan fallback.
 */
export function extractTableNames(sql: string): string[] {
  const names = new Set<string>();
  // Match: FROM <name>, JOIN <name>  — stop at whitespace, comma, or paren
  const re = /\b(?:FROM|JOIN)\s+([A-Z_$][A-Z0-9_$]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    names.add(m[1].toUpperCase());
  }
  return Array.from(names);
}

/** Builds the index-metadata query used by the NodeClient (non-native-driver) execution-plan fallback. */
export function buildIndexMetadataQuery(tables: string[]): string {
  const placeholders = tables.map(() => "?").join(", ");
  return `SELECT TRIM(i.RDB$RELATION_NAME) AS TABLE_NAME,
       TRIM(i.RDB$INDEX_NAME)    AS INDEX_NAME,
       TRIM(s.RDB$FIELD_NAME)    AS FIELD_NAME,
       i.RDB$UNIQUE_FLAG         AS IS_UNIQUE
  FROM RDB$INDICES i
  JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = i.RDB$INDEX_NAME
 WHERE TRIM(i.RDB$RELATION_NAME) IN (${placeholders})
 ORDER BY 1, 2, s.RDB$FIELD_POSITION`;
}

/** Renders the NodeClient fallback plan's human-readable text from buildIndexMetadataQuery()'s rows. */
export function renderIndexMetadataPlan(stmt: string, tables: string[], rows: any[]): string {
  if (tables.length === 0) {
    return `-- PLAN not available via node-firebird driver.\n-- Use the native driver (firebird.useNativeDriver) for execution plans.\n-- Query:\n${stmt}`;
  }
  if (!rows || rows.length === 0) {
    return `-- No index information found for table(s): ${tables.join(", ")}\n-- Query:\n${stmt}`;
  }

  let plan = `-- Firebird Index Metadata (node-firebird fallback plan)\n-- Use native driver for real PLAN output.\n--\n-- Query:\n`;
  stmt.split("\n").forEach(l => (plan += `--   ${l}\n`));
  plan += "\n";
  let lastTable = "";
  rows.forEach((r: any) => {
    const tbl = (r.TABLE_NAME ?? "").trim();
    if (tbl !== lastTable) {
      plan += `\nTABLE ${tbl}\n`;
      lastTable = tbl;
    }
    const uniq = r.IS_UNIQUE ? " (UNIQUE)" : "";
    plan += `  INDEX ${(r.INDEX_NAME ?? "").trim()}${uniq} — field: ${(r.FIELD_NAME ?? "").trim()}\n`;
  });
  return plan;
}

/** Strips a leading run of whitespace/line comments/block comments, to see what keyword a statement actually starts with. */
function stripLeadingCommentsAndWhitespace(sql: string): string {
  let text = sql;
  for (;;) {
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const newlineIndex = trimmed.indexOf("\n");
      text = newlineIndex === -1 ? "" : trimmed.slice(newlineIndex + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const endIndex = trimmed.indexOf("*/");
      text = endIndex === -1 ? "" : trimmed.slice(endIndex + 2);
      continue;
    }
    return trimmed;
  }
}

const READ_ONLY_LEADING_KEYWORD = /^(SELECT|WITH)\b/i;

/**
 * Validates that `sql` is exactly one read-only statement (a SELECT, or a WITH ... AS (...) SELECT
 * common table expression — Firebird's WITH clause can only wrap a SELECT, never DML) — used by
 * the MCP server's run_query tool to reject anything else (INSERT/UPDATE/DELETE/DDL/EXECUTE BLOCK/
 * multi-statement scripts) before it ever reaches a real connection. Returns an error message
 * describing why the input was rejected, or undefined if it's acceptable to run as-is.
 */
export function validateReadOnlyStatement(sql: string): string | undefined {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return "No SQL statement found.";
  }
  if (statements.length > 1) {
    return `Only a single SELECT statement is allowed; got ${statements.length} statements.`;
  }
  const stmt = stripLeadingCommentsAndWhitespace(statements[0]);
  if (!READ_ONLY_LEADING_KEYWORD.test(stmt)) {
    return "Only SELECT (or WITH ... AS (...) SELECT) statements are allowed — this tool is read-only.";
  }
  return undefined;
}

const WRITE_LEADING_KEYWORD = /^(INSERT|UPDATE|DELETE)\b/i;

/**
 * Validates that `sql` is exactly one INSERT, UPDATE, or DELETE statement — used by the MCP
 * server's opt-in run_write_query tool (docs/roadmap/mcp-server.md's write-query path) to reject
 * anything else (SELECT, DDL, EXECUTE BLOCK, MERGE, multi-statement scripts) before it ever reaches
 * a real connection. MERGE is deliberately not included in this first pass — INSERT/UPDATE/DELETE
 * covers ordinary CRUD writes; MERGE's combined insert-or-update-or-delete semantics can be added
 * later if there's real demand for it, matching this feature's "start narrow" scope. Returns an
 * error message describing why the input was rejected, or undefined if it's acceptable to run.
 */
export function validateWriteStatement(sql: string): string | undefined {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return "No SQL statement found.";
  }
  if (statements.length > 1) {
    return `Only a single INSERT, UPDATE, or DELETE statement is allowed; got ${statements.length} statements.`;
  }
  const stmt = stripLeadingCommentsAndWhitespace(statements[0]);
  if (!WRITE_LEADING_KEYWORD.test(stmt)) {
    return "Only INSERT, UPDATE, or DELETE statements are allowed here — DDL (CREATE/ALTER/DROP) and EXECUTE BLOCK are rejected, and SELECT belongs in run_query instead.";
  }
  return undefined;
}
