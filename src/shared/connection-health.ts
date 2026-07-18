/**
 * Connection Lost Indicator (docs/roadmap/connection-lost-indicator.md), phase 1 — detects a
 * dropped connection from the *shape* of a real query/attach failure rather than adding a new
 * polling cycle, and tracks which saved connections are currently believed unreachable.
 *
 * Kept free of any `vscode` import so it's plain-Node unit-testable — `Global`
 * (src/shared/global.ts) and NodeCategoryFolder/NodeDatabase own the VS Code-facing orchestration
 * (status bar, tree refresh, tree badges) built on top of this.
 */

/**
 * True when `error` looks like the connection itself dropped (socket reset, refused, timed out,
 * or Firebird's own "network request" wire-level errors) rather than an ordinary SQL/semantic
 * error (syntax error, constraint violation, etc.).
 *
 * node-firebird bubbles up raw Node.js socket errors (`self.db.emit('error', e)` in
 * lib/wire/connection.js, confirmed by reading the installed package's source) whose `.message`
 * always embeds the socket error code (e.g. "read ECONNRESET", "connect ECONNREFUSED
 * 127.0.0.1:3050") even in the cases where `.code` itself doesn't survive — NodeClient's own
 * queryPromise() rejects with a plain string ("Error queryPromise: " + err.message), losing the
 * `.code` property but keeping the code substring in the message — so message matching is the
 * reliable path here, with `.code` checked first as a fast, exact path when it *is* still present.
 */
export function isConnectionLostError(error: unknown): boolean {
  const code = extractCode(error);
  if (code && CONNECTION_LOST_CODES.has(code)) {
    return true;
  }
  const message = extractMessage(error).toLowerCase();
  return CONNECTION_LOST_PATTERNS.some(pattern => message.includes(pattern));
}

const CONNECTION_LOST_CODES = new Set([
  "ECONNRESET", "EPIPE", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ENETDOWN",
]);

const CONNECTION_LOST_PATTERNS = [
  "econnreset", "epipe", "econnrefused", "econnaborted", "etimedout",
  "ehostunreach", "enetunreach", "enotfound", "enetdown",
  "unable to complete network request", "network error",
  "connection reset", "connection lost", "connection terminated",
  "socket hang up", "socket has been ended",
  // node-firebird's own generic fallback (lib/wire/connection.js's socket 'close' handler) for a
  // dropped connection that wasn't accompanied by a distinct socket 'error' event -- confirmed
  // directly against the installed package's source (v2.14.0).
  "connection to firebird server was lost",
];

function extractMessage(error: unknown): string {
  if (!error) { return ""; }
  if (typeof error === "string") { return error; }
  if (error instanceof Error) { return error.message ?? ""; }
  if (typeof error === "object" && "message" in (error as Record<string, unknown>)) {
    return String((error as Record<string, unknown>).message ?? "");
  }
  return String(error);
}

function extractCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in (error as Record<string, unknown>)) {
    const code = (error as Record<string, unknown>).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * In-memory registry of saved-connection ids currently believed unreachable, backing both the
 * status bar's warning state (for whichever one is active) and the tree-node badge (phase 3) for
 * any of them — cleared the moment a query against that connection succeeds again. Not persisted;
 * resets on extension reload, same as every other in-memory connection-state tracker in this
 * codebase (e.g. PooledClient's own pooled-socket state).
 */
const unreachableConnectionIds = new Set<string>();

/** Returns true if this call actually changed the registry (caller uses this to avoid redundant UI refreshes). */
export function markConnectionUnreachable(id: string | undefined): boolean {
  if (!id || unreachableConnectionIds.has(id)) { return false; }
  unreachableConnectionIds.add(id);
  return true;
}

/** Returns true if this call actually changed the registry (caller uses this to avoid redundant UI refreshes). */
export function markConnectionReachable(id: string | undefined): boolean {
  if (!id || !unreachableConnectionIds.has(id)) { return false; }
  unreachableConnectionIds.delete(id);
  return true;
}

export function isConnectionUnreachable(id: string | undefined): boolean {
  return !!id && unreachableConnectionIds.has(id);
}
