import { ExtensionContext } from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Constants } from "../config/constants";
import { Global } from "../shared/global";
import { getConnectionLabel } from "../shared/utils";
import { loadWorkspaceConnections } from "../shared/workspace-config";
import { logger } from "../logger/logger";

/**
 * Cross-Extension Connection Sharing API (docs/roadmap/cross-extension-connection-api.md), phase
 * 1 — read-only connection *discovery* only: `listConnections()`/`getActiveConnection()`. No
 * query execution and no permission gate yet (phases 3/2 respectively) — this phase is
 * deliberately scoped to information the tree view already shows visually to anyone looking at
 * this workspace, so there's nothing here for a permission prompt to gate in the first place.
 *
 * A command-based surface (`firebird.connectionSharing.*`, registered in extension.ts), not an
 * `activate()`-returned exports object — matching vscode-mssql's actual
 * `connectionSharingService.ts` design (checked directly, not guessed from its changelog entry):
 * a VS Code command has no reliable way to know who's calling it either way, so the *caller*
 * passes its own extension id as an explicit (unverified, but at least logged) argument, which
 * the eventual phase 2 permission gate will check against a stored grant.
 */

/** What another extension is allowed to see about a connection — never a password. */
export interface SharedConnectionInfo {
  id: string;
  label: string;
  host: string;
  database: string;
  embedded: boolean;
}

function toSharedConnectionInfo(conn: ConnectionOptions): SharedConnectionInfo {
  return {
    id: conn.id,
    label: getConnectionLabel(conn),
    host: conn.host,
    database: conn.database,
    embedded: !!conn.embedded,
  };
}

/**
 * Every saved connection this workspace can see — the same set `FirebirdTreeDataProvider`'s own
 * `getHostNodes()` merges (globalState-saved connections plus this workspace's own
 * `.vscode/firebird.json`, if any), just reshaped into `SharedConnectionInfo` instead of tree
 * nodes.
 */
export async function listConnections(context: ExtensionContext, requestingExtensionId?: string): Promise<SharedConnectionInfo[]> {
  logger.debug(`connectionSharing.listConnections called by ${requestingExtensionId ?? "(unknown extension)"}`);

  const saved = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
  const workspaceConnections = await loadWorkspaceConnections();

  const all = new Map<string, ConnectionOptions>();
  for (const [id, conn] of Object.entries(saved)) {
    all.set(id, { ...conn, id });
  }
  for (const conn of workspaceConnections) {
    all.set(conn.id, conn);
  }

  return [...all.values()].map(toSharedConnectionInfo);
}

/** The connection currently marked active in the status bar/tree — undefined if none is. */
export function getActiveConnection(requestingExtensionId?: string): SharedConnectionInfo | undefined {
  logger.debug(`connectionSharing.getActiveConnection called by ${requestingExtensionId ?? "(unknown extension)"}`);

  return Global.activeConnection ? toSharedConnectionInfo(Global.activeConnection) : undefined;
}
