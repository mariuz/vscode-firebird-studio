import { ExtensionContext, window, extensions, QuickPickItem } from "vscode";
import { logger } from "../logger/logger";

/**
 * Cross-Extension Connection Sharing API, phase 2 (docs/roadmap/cross-extension-connection-api.md)
 * — the permission gate `runQuery()` (phase 3) sits behind. `listConnections()`/
 * `getActiveConnection()` (phase 1) are deliberately NOT gated by any of this — they only ever
 * return what the tree view already shows visually, which this gate exists to protect access
 * *beyond* (running a real query as the user).
 *
 * Persisted in SecretStorage, not globalState — matching vscode-mssql's actual
 * `ConnectionSharingService` (checked directly, not guessed from its changelog entry): a
 * permission grant is closer in sensitivity to a credential (it's "who gets to run queries as
 * this user") than to a UI preference.
 */

const PERMISSIONS_KEY = "firebird.connectionSharing.extensionPermissions";

export type ReadPermission = "approved" | "denied";

export interface ExtensionGrant {
  read: ReadPermission;
  /**
   * Separate opt-in on top of `read === "approved"` (phase 4) — mirrors
   * `ConnectionOptions.mcpWriteEnabled` cascading off `mcpExposed` for the MCP server's own
   * write-query path (docs/roadmap/mcp-server.md): never implicitly true just because read
   * access was granted, and never grantable before read access is.
   */
  writeEnabled: boolean;
}

type ExtensionPermissionsMap = Record<string, ExtensionGrant>;

async function getStoredPermissions(context: ExtensionContext): Promise<ExtensionPermissionsMap> {
  const raw = await context.secrets.get(PERMISSIONS_KEY);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as ExtensionPermissionsMap;
  } catch {
    logger.error("connectionSharing: stored permissions were corrupt JSON — treating as empty.");
    return {};
  }
}

async function storePermissions(context: ExtensionContext, permissions: ExtensionPermissionsMap): Promise<void> {
  await context.secrets.store(PERMISSIONS_KEY, JSON.stringify(permissions));
}

/** The stored grant for extensionId, if any has ever been recorded. */
export async function getGrant(context: ExtensionContext, extensionId: string): Promise<ExtensionGrant | undefined> {
  const permissions = await getStoredPermissions(context);
  return permissions[extensionId];
}

async function updateGrant(context: ExtensionContext, extensionId: string, grant: ExtensionGrant): Promise<void> {
  const permissions = await getStoredPermissions(context);
  permissions[extensionId] = grant;
  await storePermissions(context, permissions);
}

async function removeGrant(context: ExtensionContext, extensionId: string): Promise<void> {
  const permissions = await getStoredPermissions(context);
  delete permissions[extensionId];
  await storePermissions(context, permissions);
}

/**
 * Whether extensionId may call `runQuery()`: checks a cached grant first, and if none exists yet,
 * prompts the user once via `showInformationMessage` with Approve/Deny. The choice is cached, so
 * this only ever prompts once per requesting extension, not once per call. An empty/missing
 * `extensionId` is refused outright — there's nothing to remember a grant *for*.
 */
export async function requestConnectionSharingPermission(context: ExtensionContext, extensionId: string): Promise<boolean> {
  if (!extensionId) {
    logger.error("connectionSharing: a caller with no extensionId was refused — there's nothing to grant or remember a permission for.");
    return false;
  }

  const existing = await getGrant(context, extensionId);
  if (existing?.read === "approved") {
    return true;
  }
  if (existing?.read === "denied") {
    return false;
  }

  const choice = await window.showInformationMessage(
    `"${extensionId}" wants to run read-only queries against your Firebird connections. Allow it?`,
    "Approve",
    "Deny"
  );
  if (choice === "Approve") {
    await updateGrant(context, extensionId, { read: "approved", writeEnabled: false });
    return true;
  }
  if (choice === "Deny") {
    await updateGrant(context, extensionId, { read: "denied", writeEnabled: false });
    return false;
  }
  // Dismissed (Escape/click-away): don't cache anything -- ask again next time, rather than
  // silently treating "didn't answer" the same as an explicit Deny.
  return false;
}

/** Whether extensionId currently has both read approval and the separate write opt-in (phase 4). */
export async function hasWriteAccess(context: ExtensionContext, extensionId: string): Promise<boolean> {
  if (!extensionId) {
    return false;
  }
  const grant = await getGrant(context, extensionId);
  return grant?.read === "approved" && grant.writeEnabled === true;
}

/**
 * "Manage Connection Sharing Write Access" (phase 4) — a manual, explicit toggle, never an
 * automatic first-write-attempt prompt like `requestConnectionSharingPermission()` above. Mirrors
 * `NodeDatabase.toggleMcpWriteAccess()`'s own reasoning for the MCP server's write-query path
 * exactly: enabling needs an explicit modal confirmation (the only point a real VS Code dialog is
 * available before a write happens, since there's no per-query confirmation once this is on);
 * disabling never needs one, matching every other permission-reducing toggle in this codebase.
 * Refuses outright for an extension not yet read-approved — there's nothing to write-enable for
 * an extension that can't even read yet.
 */
export async function toggleWriteAccess(context: ExtensionContext, extensionId: string): Promise<void> {
  const grant = await getGrant(context, extensionId);
  if (!grant || grant.read !== "approved") {
    window.showErrorMessage(`"${extensionId}" must be approved for read access before it can be granted write access.`);
    return;
  }

  const nowEnabled = !grant.writeEnabled;
  if (nowEnabled) {
    const confirm = await window.showWarningMessage(
      `Grant write access to "${extensionId}"?`,
      {
        modal: true,
        detail: `"${extensionId}" will be able to run a single INSERT/UPDATE/DELETE statement per firebird.connectionSharing.runWriteQuery call, against any connection it can already read via firebird.connectionSharing.runQuery. There is no per-query confirmation once this is on. Every write attempt, successful or not, is logged to the Firebird output channel. Only grant this to an extension you trust to write to your databases.`,
      },
      "Grant Write Access"
    );
    if (confirm !== "Grant Write Access") {
      return;
    }
  }

  await updateGrant(context, extensionId, { ...grant, writeEnabled: nowEnabled });
  window.showInformationMessage(nowEnabled
    ? `"${extensionId}" now has write access via firebird.connectionSharing.runWriteQuery.`
    : `"${extensionId}" no longer has write access.`);
}

/** "Review Connection Sharing Permissions" — lets the user see and revoke/change an existing grant. */
export async function editConnectionSharingPermissions(context: ExtensionContext): Promise<void> {
  const permissions = await getStoredPermissions(context);
  const entries = Object.entries(permissions);
  if (entries.length === 0) {
    window.showInformationMessage("No extension has requested access to your Firebird connections yet.");
    return;
  }

  const items: (QuickPickItem & { extensionId: string })[] = entries.map(([extensionId, grant]) => {
    const installed = extensions.getExtension(extensionId);
    const statusParts = [grant.read === "approved" ? "Read: Approved" : "Read: Denied"];
    if (grant.read === "approved") {
      statusParts.push(grant.writeEnabled ? "Write: Enabled" : "Write: Off");
    }
    return {
      extensionId,
      label: (installed?.packageJSON?.displayName as string | undefined) ?? extensionId,
      description: extensionId,
      detail: statusParts.join("  ·  "),
    };
  });

  const picked = await window.showQuickPick(items, { placeHolder: "Select an extension to review, revoke, or manage write access for" });
  if (!picked) {
    return;
  }

  const grant = permissions[picked.extensionId];
  const actions: (QuickPickItem & { action: "revoke" | "deny" | "toggleWrite" | "cancel" })[] = [
    { label: "$(trash) Revoke — ask again next time", action: "revoke" },
    { label: "$(circle-slash) Deny future access", action: "deny" },
  ];
  if (grant.read === "approved") {
    actions.splice(1, 0, {
      label: grant.writeEnabled ? "$(lock) Revoke write access" : "$(unlock) Grant write access",
      action: "toggleWrite",
    });
  }
  actions.push({ label: "Cancel", action: "cancel" });

  const action = await window.showQuickPick(actions, { placeHolder: `${picked.label} — currently: ${picked.detail}` });
  if (!action || action.action === "cancel") {
    return;
  }

  if (action.action === "revoke") {
    await removeGrant(context, picked.extensionId);
    window.showInformationMessage(`Revoked. "${picked.label}" will be asked again next time it requests access.`);
  } else if (action.action === "deny") {
    await updateGrant(context, picked.extensionId, { read: "denied", writeEnabled: false });
    window.showInformationMessage(`"${picked.label}" is now denied.`);
  } else {
    await toggleWriteAccess(context, picked.extensionId);
  }
}
