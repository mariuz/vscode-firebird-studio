# Connection Dialog & Management Enhancements

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Connection Dialog work — testing a connection before saving it and distinguishing "editing an existing connection" from "creating a new one" (1.42.0), copying a saved connection profile's connection string directly from Object Explorer (1.38.0), and a dedicated background task panel showing active/completed long-running operations with real-time progress (1.42.0, originally for container/Fabric provisioning).

## Current state in Firebird Studio

**Phase 1 is done.** The relevant existing pieces:

- `src/shared/connection-wizard.ts` — a `MultiStepInput`-driven wizard (`collectInputs()` → `connectionType`/`dockerContainer`/`host`/`database`/`port`/`user`/`password`/`role`/`wireCrypt`/`sshTunnel` steps) that collects every field and hands back a `ConnectionOptions`; there's no separate "edit an existing connection" flow distinct from re-running the same wizard.
- `NodeDatabase` (`src/nodes/node-database.ts`) already has a rich set of per-connection commands (`setPassword`, `setConnectionGroup`, `renameDatabase`, `dropDatabase`, `backupDatabase`/`restoreDatabase`) — no `copyConnectionString`-style command among them.
- `src/container-provisioning/index.ts` reports progress via a single `window.withProgress({location: ProgressLocation.Notification, ...})` call — a transient toast that disappears once the container is up (or the wizard is dismissed), with no way to check back on it, and no shared home for a second concurrent long operation (e.g. a backup running at the same time) to report into.
- **Phase 1 — Test Connection step — done.** A new terminal step in the wizard, reached after every field is collected: for embedded connections (after `role()`) and for non-SSH network/Docker connections (after choosing "No" on the SSH tunnel step). Offers "$(plug) Test Connection" or "$(check) Save Without Testing" (the default on Escape/dismiss, so nothing changes for anyone who ignores the new step); a real `attemptConnection()` connect-then-detach runs inside a `window.withProgress` notification, reporting success via `showInformationMessage` or failure via `showErrorMessage` with "Retry"/"Save Anyway" — never a hard block on saving. **Deliberately skipped for SSH-tunneled connections**: `SshTunnelClient`'s connect path resolves the SSH credential via `CredentialStore.getSshPassword(connectionOptions.id)`, keyed by a *saved* connection's id — which doesn't exist yet at this point in the wizard, so there's no reliable way to test through the tunnel before the connection (and its credential) are actually saved. The SSH-configured branch of the wizard is unchanged, finishing the same way it always did.
- Not done yet: distinguishing edit vs. create, the Copy Connection String command, and the background task panel.

### Testing

The wizard itself remains untested (VS Code dialog orchestration — same boundary this repo already draws for `node-database.ts`'s wizard-style methods, per `flat-file-import-wizard.md`'s precedent); this phase doesn't change that. `attemptConnection()`, the one genuinely new piece of non-orchestration logic (a real connect-then-detach that must never throw), is exported and covered by a new `src/test/suite/connection-wizard-integration.test.ts`: a real successful connection to the seeded test server, a wrong password, and an unreachable host — all three confirmed to resolve to a plain string (or `undefined`) rather than rejecting, against a real Firebird server.

## Proposed feature

1. ~~**Test Connection step.**~~ — **done**, see above (implemented as the wizard's own new terminal step rather than a separate follow-up dialog, so it's reached naturally at the point every field is already known).
2. **Distinguish edit vs. create.** The wizard currently has one shape regardless of whether it's creating a brand-new connection or (via some future "Edit Connection" entry point) modifying a saved one. Worth an explicit `mode: 'create' | 'edit'` parameter threaded through `collectInputs()`, pre-filling every step's default from the existing `ConnectionOptions` when editing, so changing one field (e.g. just the port) doesn't require re-entering everything else.
3. **Copy Connection String command.** A new `firebird.database.copyConnectionString` command (right-click menu, same registration pattern as `setPassword`) that builds a `node-firebird`-style connection string (or a plain `host/port:database` DSN) from the node's `ConnectionOptions` and writes it to the clipboard via `vscode.env.clipboard.writeText()` — deliberately excludes the password (matching this repo's existing "password never leaves SecretStorage casually" posture; mssql's own version has the same carve-out) with a note in the copied text that the password must be supplied separately.
4. **Background task panel.** A `TreeDataProvider`-backed view (or a `WebviewView` in the same activity-bar container as the Firebird explorer) listing active and recently-completed long-running operations — container provisioning, backup/restore, database project publish — each reporting into it instead of (or alongside) today's one-off `withProgress` notifications, so a user who dismisses or misses the toast can still check whether a backup actually finished. Lowest priority of the four here: the existing per-operation notifications already work, this is purely a discoverability improvement once more than one long-running feature exists side by side.

## Suggested phases

1. ~~Test Connection step in `connection-wizard.ts`.~~ — **done**.
2. `firebird.database.copyConnectionString` command.
3. Edit-vs-create mode for the wizard (depends on there being an "Edit Connection" entry point at all — currently editing means delete-and-re-add, same gap `docs/roadmap/ssh-tunneling.md` already flagged for SSH tunnel credentials specifically before its "Set SSH Tunnel Password" command shipped).
4. Background task panel, once there's more than one concurrent long-running operation type to justify it.
