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
}
