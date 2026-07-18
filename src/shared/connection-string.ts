/**
 * Parses a pasted Firebird connection string to prefill the "Add New Connection" wizard, instead
 * of stepping through every field by hand. Pure — no vscode dependency — unit-testable the same
 * way docker-discovery.ts is; the wizard integration lives in connection-wizard.ts.
 *
 * Supported form: `firebird://[user[:password]@]host[:port]/database[?role=...&wireCrypt=...]`.
 * There's no single canonical Firebird connection-string format the way JDBC/ODBC tools have one
 * — this URL shape was chosen because it's unambiguous to parse with the standard `URL` class and
 * matches the convention users already expect from postgres://, mysql://, etc. Firebird's own bare
 * `host/port:database` DSN syntax is deliberately NOT supported here: it's genuinely ambiguous
 * against a Windows absolute path like `C:\data\test.fdb`, and silently mis-parsing a pasted
 * connection string is worse than requiring the one supported format.
 */

import { ConnectionOptions } from "../interfaces";

const VALID_WIRE_CRYPT = new Set(["Required", "Enabled", "Disabled"]);

/**
 * A URL pathname always has one leading "/" (the path-start delimiter). This scheme's convention
 * for an absolute database path is a doubled slash (mirroring sqlite:////absolute/path.db) —
 * stripping exactly one leading character turns "//var/lib/x.fdb" into "/var/lib/x.fdb" (absolute,
 * correct) and "/employee" into "employee" (a bare alias, also correct) uniformly. If the caller
 * only typed a single slash before an otherwise-absolute-looking path (still containing further
 * "/"s after stripping), restore the leading slash rather than silently handing Firebird a
 * relative path the user didn't intend.
 */
function normalizeDatabasePath(pathname: string): string {
  const stripped = pathname.slice(1);
  if (pathname.startsWith("//")) {
    return stripped;
  }
  return stripped.includes("/") ? `/${stripped}` : stripped;
}

/** Returns the parsed fields, or undefined if `input` isn't a recognizable Firebird connection string. */
export function parseConnectionString(input: string): Partial<ConnectionOptions> | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "firebird:" || !url.hostname) {
    return undefined;
  }

  const database = normalizeDatabasePath(url.pathname);
  if (!database) {
    return undefined;
  }

  const result: Partial<ConnectionOptions> = {
    host: url.hostname,
    database,
    embedded: false,
  };
  if (url.port) {
    result.port = Number(url.port);
  }
  if (url.username) {
    result.user = decodeURIComponent(url.username);
  }
  if (url.password) {
    result.password = decodeURIComponent(url.password);
  }
  const role = url.searchParams.get("role");
  if (role) {
    result.role = role;
  }
  const wireCrypt = url.searchParams.get("wireCrypt");
  if (wireCrypt && VALID_WIRE_CRYPT.has(wireCrypt)) {
    result.wireCrypt = wireCrypt as ConnectionOptions["wireCrypt"];
  }
  return result;
}

/**
 * "Copy Connection String" (docs/roadmap/connection-management-enhancements.md, phase 2). Not the
 * inverse of parseConnectionString() above — that firebird:// scheme requires a hostname and has
 * no representation for an embedded (local-file, no host) connection at all, which this needs to
 * handle too. Uses Firebird's own native DSN shape instead (`host/port:database`, or a bare
 * `database` path for embedded — the same shape `isql -c`/JDBC/ODBC connection strings use, minus
 * their own scheme prefixes), which every Firebird user already recognizes and which naturally
 * covers both cases without inventing a new format. Deliberately never includes the password
 * (matching this repo's "password never leaves SecretStorage casually" posture) — callers that
 * want a full one-line credential dump should not use this.
 */
export function buildConnectionString(options: ConnectionOptions): string {
  const dsn = options.embedded
    ? options.database
    : `${options.host}${options.port ? `/${options.port}` : ""}:${options.database}`;
  const userLine = options.user ? `\n-- User: ${options.user}` : "";
  return `${dsn}${userLine}\n-- Password not included; set it separately.`;
}
