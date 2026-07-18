# Connection Dialog & Management Enhancements

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Connection Dialog work — testing a connection before saving it and distinguishing "editing an existing connection" from "creating a new one" (1.42.0), copying a saved connection profile's connection string directly from Object Explorer (1.38.0), and a dedicated background task panel showing active/completed long-running operations with real-time progress (1.42.0, originally for container/Fabric provisioning).

## Current state in Firebird Studio

**Not started.** The relevant existing pieces:

- `src/shared/connection-wizard.ts` — a `MultiStepInput`-driven wizard (`collectInputs()` → `connectionType`/`dockerContainer`/`host`/`database`/`port`/`user`/`password`/`role`/`wireCrypt`/`sshTunnel` steps) that collects every field and hands back a `ConnectionOptions`; it doesn't attempt a connection at any point during collection, and there's no separate "edit an existing connection" flow distinct from re-running the same wizard.
- `NodeDatabase` (`src/nodes/node-database.ts`) already has a rich set of per-connection commands (`setPassword`, `setConnectionGroup`, `renameDatabase`, `dropDatabase`, `backupDatabase`/`restoreDatabase`) — no `copyConnectionString`-style command among them.
- `src/container-provisioning/index.ts` reports progress via a single `window.withProgress({location: ProgressLocation.Notification, ...})` call — a transient toast that disappears once the container is up (or the wizard is dismissed), with no way to check back on it, and no shared home for a second concurrent long operation (e.g. a backup running at the same time) to report into.

## Proposed feature

1. **Test Connection step.** After the wizard collects every field but before it's saved, offer a "Test Connection" action (a `showQuickPick`-based step, matching the wizard's existing `MultiStepInput` pattern) that runs a real `Driver.client.createConnection()` + immediate `detach()` against the collected options and reports success/failure inline — surfacing a wrong password or unreachable host *before* the connection is saved and added to the tree, rather than only on first use afterward.
2. **Distinguish edit vs. create.** The wizard currently has one shape regardless of whether it's creating a brand-new connection or (via some future "Edit Connection" entry point) modifying a saved one. Worth an explicit `mode: 'create' | 'edit'` parameter threaded through `collectInputs()`, pre-filling every step's default from the existing `ConnectionOptions` when editing, so changing one field (e.g. just the port) doesn't require re-entering everything else.
3. **Copy Connection String command.** A new `firebird.database.copyConnectionString` command (right-click menu, same registration pattern as `setPassword`) that builds a `node-firebird`-style connection string (or a plain `host/port:database` DSN) from the node's `ConnectionOptions` and writes it to the clipboard via `vscode.env.clipboard.writeText()` — deliberately excludes the password (matching this repo's existing "password never leaves SecretStorage casually" posture; mssql's own version has the same carve-out) with a note in the copied text that the password must be supplied separately.
4. **Background task panel.** A `TreeDataProvider`-backed view (or a `WebviewView` in the same activity-bar container as the Firebird explorer) listing active and recently-completed long-running operations — container provisioning, backup/restore, database project publish — each reporting into it instead of (or alongside) today's one-off `withProgress` notifications, so a user who dismisses or misses the toast can still check whether a backup actually finished. Lowest priority of the four here: the existing per-operation notifications already work, this is purely a discoverability improvement once more than one long-running feature exists side by side.

## Suggested phases

1. Test Connection step in `connection-wizard.ts`.
2. `firebird.database.copyConnectionString` command.
3. Edit-vs-create mode for the wizard (depends on there being an "Edit Connection" entry point at all — currently editing means delete-and-re-add, same gap `docs/roadmap/ssh-tunneling.md` already flagged for SSH tunnel credentials specifically before its "Set SSH Tunnel Password" command shipped).
4. Background task panel, once there's more than one concurrent long-running operation type to justify it.
