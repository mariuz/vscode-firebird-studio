import { ConnectionColor } from "../shared/connection-color";

/**
 * Firebird connection options
 *
 * https://www.npmjs.com/package/node-firebird
 */
export interface ConnectionOptions {
  id: string;
  host: string;
  port: any;
  database: string;
  user: string;
  /** Password is stored in SecretStorage and populated at runtime; not persisted in globalState. */
  password?: string;
  role: string | null;
  /** When true, connects to an embedded (local file) Firebird database — no host/port required. */
  embedded?: boolean;
  /** Wire encryption mode for Firebird 4.x/5.x (WireCrypt). */
  wireCrypt?: 'Required' | 'Enabled' | 'Disabled';
  /** Authentication plugin for Firebird 4.x/5.x (e.g. Srp256, Srp, Legacy_Auth). */
  authPlugin?: string;
  /** True for connections sourced from a workspace's .vscode/firebird.json rather than globalState — never persisted there, and re-derived from disk on every tree refresh. */
  workspace?: boolean;
  /** Whether this workspace connection was marked "default": true — see workspace-config.ts. */
  isDefault?: boolean;
  /** Optional folder/group name — when set, groups this connection under that name in the tree instead of by host. */
  group?: string;
  /** Optional color tag for quick visual identification in the tree icon and status bar. */
  color?: ConnectionColor;
  /** Explicit opt-in: exposes this connection's schema (never its password) to the firebird.mcp MCP server, if enabled. Defaults to false/unset — an MCP client sees nothing unless a connection opts in. */
  mcpExposed?: boolean;
  /** Reach host/port through an SSH tunnel (bastion/jump host) rather than connecting directly — see src/shared/ssh-tunnel.ts. The SSH password/passphrase itself is never stored here; it's kept in SecretStorage via CredentialStore, the same way the database password is. */
  sshTunnel?: SshTunnelOptions;
  /** SSH password (authMethod "password") or private key passphrase (authMethod "privateKey"), collected by the connection wizard. Like `password`, this is stored in SecretStorage (CredentialStore.storeSshPassword()) and stripped before persisting to globalState — never present outside the wizard-to-save round trip. */
  sshTunnelPassword?: string;
}

export interface SshTunnelOptions {
  host: string;
  port: number;
  user: string;
  authMethod: "password" | "privateKey" | "agent";
  /** Only for authMethod "privateKey" — path to an OpenSSH-format private key file. */
  privateKeyPath?: string;
}
