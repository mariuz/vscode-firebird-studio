/**
 * Builds the command line / environment for launching Firebird's isql (or isql-fb) connected to
 * a saved connection, and resolves which executable to use — the Firebird analog of how the
 * PostgreSQL extension for VS Code launches `psql` in an integrated terminal. Kept free of any
 * vscode/child_process dependency so it's unit-testable; extension.ts wires the actual terminal/
 * task creation and process spawning around these pure functions.
 */

import { ConnectionOptions } from "../interfaces";

/** The database argument isql expects: `host/port:database`, or just the path when embedded. */
export function buildIsqlTarget(connectionOptions: ConnectionOptions): string {
  if (connectionOptions.embedded) {
    return connectionOptions.database;
  }
  const port = connectionOptions.port ?? 3050;
  return `${connectionOptions.host}/${port}:${connectionOptions.database}`;
}

/**
 * Builds isql's command-line arguments. Deliberately excludes -user/-password — see
 * buildIsqlEnv() — so credentials never appear in the visible terminal command line or a
 * process listing, the same reasoning the PostgreSQL extension gives for using PGPASSWORD
 * instead of an interactive/CLI password.
 */
export function buildIsqlArgs(connectionOptions: ConnectionOptions, extraArgs: string[] = []): string[] {
  const args: string[] = [...extraArgs];
  if (connectionOptions.role) {
    args.push("-role", connectionOptions.role);
  }
  args.push(buildIsqlTarget(connectionOptions));
  return args;
}

/** Environment variables Firebird's client library reads credentials from automatically. */
export function buildIsqlEnv(connectionOptions: ConnectionOptions): { ISC_USER: string; ISC_PASSWORD: string } {
  return {
    ISC_USER: connectionOptions.user,
    ISC_PASSWORD: connectionOptions.password ?? "",
  };
}

/** Candidate executable names to search for on PATH, per platform (most Linux packages ship isql-fb to avoid clashing with unixODBC's own isql). */
export function isqlCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["isql.exe", "isql-fb.exe"] : ["isql-fb", "isql"];
}

/**
 * Resolves which isql executable to launch. An explicit `customPath` (the firebird.isqlPath
 * setting) always wins if it actually resolves; otherwise tries each of this platform's
 * candidate names on PATH, in order, returning the first that resolves.
 *
 * `checkExecutable` is injected (rather than spawning directly in here) so the resolution order
 * is unit-testable without a real isql binary; extension.ts supplies a real spawn-based check.
 */
export async function resolveIsqlExecutable(
  customPath: string | undefined,
  checkExecutable: (candidate: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform
): Promise<string | undefined> {
  if (customPath) {
    return (await checkExecutable(customPath)) ? customPath : undefined;
  }
  for (const candidate of isqlCandidates(platform)) {
    if (await checkExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
