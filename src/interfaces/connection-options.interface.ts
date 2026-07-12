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
}
