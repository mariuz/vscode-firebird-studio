# SSH Tunneling for Connections

**Inspired by**: [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql)'s SSH tunneling support for reaching a database that only listens on a private/internal network.

## Current state in Firebird Studio

None. `ConnectionOptions` (`src/interfaces/connection-options.interface.ts`) has `host`/`port` fields consumed directly by both `ClientI` implementations (`NodeClient` via `node-firebird`, `NativeClient` via `node-firebird-driver-native`) with no indirection in between — there's no concept of "connect through an intermediate hop" anywhere in the connection path today. Firebird is frequently deployed on a machine that isn't directly reachable from a developer's laptop (an office LAN, a bastion-fronted VPC, a home NAS), so this is a real, not speculative, gap — unlike some other pgsql features that only make sense because Postgres is offered as a managed cloud service.

## Proposed feature

1. **New optional fields on `ConnectionOptions`**: `sshTunnel?: { host: string; port: number; user: string; authMethod: 'password' | 'privateKey' | 'agent'; privateKeyPath?: string }`. The SSH credential itself (password or key passphrase) follows the exact pattern `CredentialStore` already established for the database password — a second `SecretStorage` key, e.g. `firebird.sshPassword.<connectionId>`, never written to `globalState`.
2. **Before `Driver.connect()` opens the real Firebird connection**, if `sshTunnel` is set, open a local forwarded port (`127.0.0.1:<ephemeralPort>` → `sshTunnel.host:sshTunnel.port` → the real `host:port`) and rewrite the options passed to `NodeClient`/`NativeClient` to point at that local port instead. Tear the tunnel down when the connection is closed/disposed, mirroring how `Global`'s active-connection lifecycle already disposes other per-connection resources.
3. **Connection dialog**: an "Connect through SSH tunnel" toggle revealing host/port/user/auth-method fields, alongside the existing host/port/database/user fields — same dialog, not a separate flow, consistent with how `wireCrypt`/`authPlugin` are already just more fields on the same form.
4. **Status/diagnostics**: surface tunnel-establishment failures (auth rejected, host unreachable, port already forwarded) through the existing `Logger` (`src/logger/logger.ts`) the same way connection failures already are, so they show up in the output channel rather than a silent hang.

## Technical notes

- **Dependency trade-off — this is the one place hand-rolling isn't reasonable.** SSH's transport/auth/channel protocol is a poor fit for this codebase's usual "hand-roll it, it's small" approach (used successfully for the CSV parser, chart SVG builder, connection-string parser) — it needs a real, security-sensitive protocol implementation. Two realistic options:
  - **`ssh2`** (pure-JS, no native build step) as a new dependency — the more portable choice, and consistent with already accepting `@modelcontextprotocol/sdk` as a dependency for the MCP server rather than hand-rolling JSON-RPC framing. Recommended default.
  - **Shell out to the system `ssh` binary** (`ssh -N -L <local>:<remote_host>:<remote_port> user@bastion`), spawned similarly to `isql-terminal.ts`'s existing pattern of spawning a local process with credentials via env var/`-o` flags rather than argv. Avoids a new npm dependency entirely, but depends on an external binary being installed and configured (agent forwarding, known_hosts) — more moving parts to diagnose when it fails, and Windows support is weaker (no OpenSSH client guaranteed on older Windows versions).
  - Recommend starting with `ssh2` given this extension already accepts a real dependency where hand-rolling would be irresponsible (MCP SDK precedent above), and because it avoids the platform/OpenSSH-availability variance of shelling out.
- Private key auth needs a file picker (`vscode.window.showOpenDialog`) for the key path, plus an optional passphrase stored the same way as the SSH password.
- The tunnel's local ephemeral port should be picked freshly per connection attempt (bind to port 0, read back the OS-assigned port) rather than a fixed port, to avoid collisions when multiple tunneled connections are open at once.

## Suggested phases

1. `ssh2`-based tunnel helper (`src/shared/ssh-tunnel.ts`): given tunnel config, opens the local forwarded port and returns a handle with a `close()`; password auth only.
2. Wire into `Driver.connect()`: when `sshTunnel` is set, open the tunnel first and connect through the local port instead of `host`/`port` directly; tear down on disconnect.
3. Connection dialog UI (toggle + fields) and `CredentialStore`-backed SSH password storage.
4. Private key / agent auth methods.
