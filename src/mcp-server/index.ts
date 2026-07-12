import * as vscode from "vscode";
import { join } from "path";
import { ConnectionOptions } from "../interfaces";
import { Constants, getOptions } from "../config";
import { CredentialStore } from "../shared/credential-store";
import { logger } from "../logger/logger";

const PROVIDER_ID = "firebird-mcp";

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
        server.env = { FIREBIRD_MCP_CONNECTIONS: JSON.stringify(exposed) };
      }
      return server;
    },
  };

  const providerDisposable = lmAny.registerMcpServerDefinitionProvider(PROVIDER_ID, provider);
  return vscode.Disposable.from(providerDisposable, configListener, didChangeEmitter);
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
  })));
}
