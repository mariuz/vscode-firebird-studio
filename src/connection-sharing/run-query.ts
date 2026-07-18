import { ExtensionContext } from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Constants } from "../config/constants";
import { Driver } from "../shared/driver";
import { validateReadOnlyStatement, validateWriteStatement } from "../shared/sql-analysis";
import { loadWorkspaceConnections } from "../shared/workspace-config";
import { requestConnectionSharingPermission, hasWriteAccess } from "./permissions";
import { logger } from "../logger/logger";

/**
 * Cross-Extension Connection Sharing API, phases 3–4 (docs/roadmap/cross-extension-connection-api.md).
 * Runs entirely in-process (this is a real VS Code command another extension calls via
 * `commands.executeCommand()`, unlike the MCP server's own run_query/run_write_query tools, which
 * execute in a spawned subprocess with no vscode API access at all) — so, unlike that subprocess,
 * this can and does go through `Driver.runQuery()` directly. `Driver.runQuery()` already resolves
 * a connection's password internally via `CredentialStore` when one isn't already set on the
 * options passed in, so the password never needs to be (and never is) read out into this module or
 * handed to the calling extension — only query results ever cross the boundary.
 */

export interface SharedQueryResult {
  rows?: any[];
  error?: string;
}

async function resolveConnectionById(context: ExtensionContext, connectionId: string): Promise<ConnectionOptions | undefined> {
  const saved = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
  if (saved[connectionId]) {
    return { ...saved[connectionId], id: connectionId };
  }
  const workspaceConnections = await loadWorkspaceConnections();
  return workspaceConnections.find(c => c.id === connectionId);
}

/**
 * Runs a single read-only SELECT on behalf of requestingExtensionId, gated by
 * `requestConnectionSharingPermission()` — the first call from a not-yet-seen extension id
 * prompts the user once; subsequent calls reuse the cached answer.
 */
export async function runQuery(
  context: ExtensionContext,
  requestingExtensionId: string,
  connectionId: string,
  sql: string
): Promise<SharedQueryResult> {
  const allowed = await requestConnectionSharingPermission(context, requestingExtensionId);
  if (!allowed) {
    return { error: `"${requestingExtensionId}" does not have permission to use Firebird connections. Run "Firebird: Review Connection Sharing Permissions" to grant it.` };
  }

  const readOnlyError = validateReadOnlyStatement(sql);
  if (readOnlyError) {
    return { error: `connectionSharing.runQuery only supports a single read-only SELECT: ${readOnlyError}` };
  }

  const connection = await resolveConnectionById(context, connectionId);
  if (!connection) {
    return { error: `No connection with id "${connectionId}" was found.` };
  }

  try {
    // Driver.setClient() (extension.ts#activate()) doesn't await native-driver construction --
    // Driver.client can briefly be undefined right after activation, exactly the scenario another
    // extension calling this command immediately after activation would hit.
    await Driver.clientReady;
    const rows = await Driver.runQuery(sql, connection);
    return { rows };
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}

/**
 * Runs a single INSERT/UPDATE/DELETE on behalf of requestingExtensionId (phase 4) — gated by
 * *both* the base read approval above and the separate `hasWriteAccess()` opt-in
 * (`toggleWriteAccess()` in permissions.ts), which only a user action can grant, never this
 * function itself. Every write attempt, successful or not, is logged — there's no per-query
 * confirmation once write access is on, so the log is the only record of what actually ran.
 */
export async function runWriteQuery(
  context: ExtensionContext,
  requestingExtensionId: string,
  connectionId: string,
  sql: string
): Promise<SharedQueryResult> {
  const allowedRead = await requestConnectionSharingPermission(context, requestingExtensionId);
  if (!allowedRead) {
    return { error: `"${requestingExtensionId}" does not have permission to use Firebird connections. Run "Firebird: Review Connection Sharing Permissions" to grant it.` };
  }
  const allowedWrite = await hasWriteAccess(context, requestingExtensionId);
  if (!allowedWrite) {
    return { error: `"${requestingExtensionId}" does not have write access. Run "Firebird: Manage Connection Sharing Write Access" to grant it.` };
  }

  const writeError = validateWriteStatement(sql);
  if (writeError) {
    return { error: `connectionSharing.runWriteQuery only supports a single INSERT/UPDATE/DELETE: ${writeError}` };
  }

  const connection = await resolveConnectionById(context, connectionId);
  if (!connection) {
    return { error: `No connection with id "${connectionId}" was found.` };
  }

  logger.info(`connectionSharing.runWriteQuery: "${requestingExtensionId}" writing to connection "${connectionId}": ${sql}`);
  try {
    await Driver.clientReady;
    const rows = await Driver.runQuery(sql, connection);
    logger.info(`connectionSharing.runWriteQuery: succeeded.`);
    return { rows };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    logger.error(`connectionSharing.runWriteQuery: failed: ${message}`);
    return { error: message };
  }
}
