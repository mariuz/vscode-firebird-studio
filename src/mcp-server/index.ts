import * as vscode from "vscode";
import { join, basename, dirname } from "path";
import { mkdirSync, statSync, createReadStream, watch, FSWatcher } from "fs";
import { ConnectionOptions } from "../interfaces";
import { Constants, getOptions } from "../config";
import { CredentialStore } from "../shared/credential-store";
import { logger } from "../logger/logger";

const PROVIDER_ID = "firebird-mcp";
const AUDIT_LOG_FILE_NAME = "mcp-write-audit.log";

/**
 * Fired whenever a connection's `mcpExposed` flag is toggled from the tree
 * (`NodeDatabase.toggleMcpExposure()`) so an already-registered provider can tell VS Code its
 * definitions changed without waiting for a `firebird.mcp.*` setting to also change. Module-level
 * (not local to `registerMcpServer()`) so `notifyMcpExposureChanged()` can be called from anywhere
 * without threading a reference through `node-database.ts` — safe to call even before
 * `registerMcpServer()` has run (e.g. on a VS Code build with no MCP API), since firing an event
 * with no listeners is a no-op.
 */
const mcpExposureChangedEmitter = new vscode.EventEmitter<void>();

/** Call after writing a connection's `mcpExposed` field so a running MCP client session picks up the change without needing a restart. */
export function notifyMcpExposureChanged(): void {
  mcpExposureChangedEmitter.fire();
}

/** Exposed so callers (and tests) can observe the same signal `registerMcpServer()` relays into `onDidChangeMcpServerDefinitions` — not just fire-and-forget. */
export const onMcpExposureChanged: vscode.Event<void> = mcpExposureChangedEmitter.event;

/**
 * Registers the firebird-mcp MCP server definition provider (Phase 2: list_connections +
 * get_schema, read-only). Requires a VS Code build with MCP server registration support
 * (`vscode.lm.registerMcpServerDefinitionProvider`) — this API is newer than everything else this
 * extension integrates with, so it's guarded the same way the Copilot chat participant guards
 * `vscode.chat`: feature-detect at runtime and simply skip registration on older VS Code rather
 * than crashing, no `engines.vscode` bump required.
 */
export function registerMcpServer(context: vscode.ExtensionContext): vscode.Disposable {
  const lmAny = (typeof vscode.lm !== "undefined" ? vscode.lm : undefined) as unknown as {
    registerMcpServerDefinitionProvider?: (id: string, provider: vscode.McpServerDefinitionProvider) => vscode.Disposable;
  } | undefined;
  if (typeof lmAny?.registerMcpServerDefinitionProvider !== "function") {
    logger.debug("firebird-mcp: this VS Code build has no MCP server registration API — skipping.");
    return new vscode.Disposable(() => { /* nothing to dispose */ });
  }

  const didChangeEmitter = new vscode.EventEmitter<void>();
  const configListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration("firebird.mcp")) {
      didChangeEmitter.fire();
    }
  });
  const exposureListener = mcpExposureChangedEmitter.event(() => didChangeEmitter.fire());
  const auditLogWatcher = startAuditLogWatcher(getAuditLogPath(context));

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: didChangeEmitter.event,
    provideMcpServerDefinitions: () => {
      if (!getOptions().mcpEnabled) {
        return [];
      }
      const scriptPath = join(context.extensionPath, "out", "mcp-server", "server.js");
      return [new vscode.McpStdioServerDefinition("Firebird MCP Server", process.execPath, [scriptPath], {})];
    },
    resolveMcpServerDefinition: async (server, _token) => {
      // Only here (not in provideMcpServerDefinitions()) because this is specifically where the
      // API docs say it's fine to do work needing user data/credentials.
      const exposed = await resolveExposedConnections(context);
      if (server instanceof vscode.McpStdioServerDefinition) {
        server.env = { FIREBIRD_MCP_CONNECTIONS: JSON.stringify(exposed), FIREBIRD_MCP_AUDIT_LOG_PATH: getAuditLogPath(context) };
      }
      return server;
    },
  };

  const providerDisposable = lmAny.registerMcpServerDefinitionProvider(PROVIDER_ID, provider);
  return vscode.Disposable.from(providerDisposable, configListener, exposureListener, didChangeEmitter, auditLogWatcher);
}

/** Resolves the password (via CredentialStore) for every saved connection with mcpExposed === true. Never includes connections that haven't explicitly opted in. */
async function resolveExposedConnections(context: vscode.ExtensionContext): Promise<object[]> {
  const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
  const exposed = Object.entries(connections).filter(([, conn]) => conn.mcpExposed);

  return Promise.all(exposed.map(async ([id, conn]) => ({
    id,
    label: conn.host ? `${conn.host}:${conn.database}` : conn.database,
    host: conn.host,
    port: conn.port ?? null,
    database: conn.database,
    user: conn.user,
    password: (await CredentialStore.getPassword(id)) ?? "",
    role: conn.role,
    embedded: !!conn.embedded,
    writeEnabled: !!conn.mcpWriteEnabled,
  })));
}

// ── Write-query audit log (docs/roadmap/mcp-server.md's write-query path) ───────
//
// The spawned server.ts subprocess is what actually runs a write (the extension host isn't on the
// request path once VS Code core has spawned it — see the module doc comment above), so it can't
// call logger.* directly. Instead it appends one JSON line per write attempt (success or failure)
// to a file whose path is handed to it via FIREBIRD_MCP_AUDIT_LOG_PATH; this side watches that same
// file and relays each new line into the extension's own output channel/notifications, so a write
// an external MCP client made is actually visible here, not just recoverable by remembering to open
// a log file by hand (which "Show MCP Write Audit Log", below, still supports as a durable fallback
// — fs.watch() is inherently best-effort across platforms/filesystems).

function getAuditLogPath(context: vscode.ExtensionContext): string {
  mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  return join(context.globalStorageUri.fsPath, AUDIT_LOG_FILE_NAME);
}

interface AuditLogEntry {
  timestamp: string;
  connectionId: string;
  sql: string;
  success: boolean;
  error?: string;
}

/** Watches the audit log's directory (not the file directly — it may not exist yet the first time a write-enabled MCP session actually runs a write) and relays every line appended after this watcher started, exactly once each. */
function startAuditLogWatcher(auditLogPath: string): vscode.Disposable {
  let offset = 0;
  try {
    offset = statSync(auditLogPath).size;
  } catch {
    // File doesn't exist yet -- starts from 0 once the subprocess creates it.
  }

  const relayNewEntries = () => {
    let size: number;
    try {
      size = statSync(auditLogPath).size;
    } catch {
      return;
    }
    if (size <= offset) {
      return;
    }
    const start = offset;
    offset = size;
    const stream = createReadStream(auditLogPath, { start, end: size - 1, encoding: "utf8" });
    let buffer = "";
    stream.on("data", chunk => { buffer += chunk; });
    stream.on("end", () => {
      buffer.split("\n").filter(line => line.trim()).forEach(line => {
        let entry: AuditLogEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          return; // a partially-written line read mid-append -- offset already only advanced past what was actually read, so nothing is lost, just deferred to the next watch event
        }
        const summary = `MCP write query on connection "${entry.connectionId}": ${entry.sql}`;
        if (entry.success) {
          logger.info(`${summary} — succeeded.`);
        } else {
          logger.error(`${summary} — FAILED: ${entry.error}`);
        }
      });
    });
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(auditLogPath), (_event, filename) => {
      if (filename === basename(auditLogPath)) {
        relayNewEntries();
      }
    });
  } catch (err) {
    logger.debug(`firebird-mcp: could not watch the write-audit log directory: ${(err as any)?.message ?? err}`);
  }

  return new vscode.Disposable(() => watcher?.close());
}

/** "Show MCP Write Audit Log" command — opens the raw log file directly, regardless of whether the fs.watch()-based live relay above happened to catch every entry. A no-op with an explanatory message if no write has ever been attempted yet (the file doesn't exist). */
export async function openMcpWriteAuditLog(context: vscode.ExtensionContext): Promise<void> {
  const path = getAuditLogPath(context);
  try {
    statSync(path);
  } catch {
    logger.showInfo("No MCP write attempts have been logged yet.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(path);
  await vscode.window.showTextDocument(doc, { preview: false });
}
