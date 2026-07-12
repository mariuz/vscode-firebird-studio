/**
 * Pure, dependency-injectable logic for provisioning a new local Firebird server in Docker —
 * builds on shared/docker-discovery.ts's existing "detect running containers" support with
 * "create one." Kept free of any vscode/child_process imports so it's unit-testable the same
 * way docker-discovery.ts is; the actual `docker run` spawn lives in this folder's index.ts.
 *
 * Targets the official firebirdsql/firebird image (https://github.com/FirebirdSQL/firebird-docker)
 * — its documented environment variable contract (FIREBIRD_ROOT_PASSWORD, FIREBIRD_DATABASE,
 * FIREBIRD_USE_LEGACY_AUTH, the /var/lib/firebird/data volume path, and port 3050) was confirmed
 * against that repo's own README before being hard-coded here.
 */

export interface ProvisionContainerOptions {
  containerName: string;
  /** A bare tag ("5.0", "4.0", "3.0") is combined with the "firebirdsql/firebird:" prefix; a value containing "/" is used as a full custom image reference as-is. */
  image: string;
  hostPort: number;
  sysdbaPassword: string;
  /** Becomes FIREBIRD_DATABASE — either a bare filename (placed under /var/lib/firebird/data) or an absolute path. */
  databaseName: string;
  /** Enables FIREBIRD_USE_LEGACY_AUTH, for connecting with older clients/drivers that don't support SRP. */
  useLegacyAuth?: boolean;
  /** When set, persists /var/lib/firebird/data in a named Docker volume so data survives container removal. */
  volumeName?: string;
}

/** Well-known tags worth offering directly in the wizard; "Custom..." lets the user type any other reference. */
export const FIREBIRD_IMAGE_TAGS = ["5.0", "4.0", "3.0"];

export function resolveImageReference(imageOrTag: string): string {
  return imageOrTag.includes("/") ? imageOrTag : `firebirdsql/firebird:${imageOrTag}`;
}

/** Builds the `docker run -d ...` argument list for provisionContainer(). Exported for unit testing. */
export function dockerRunArgs(options: ProvisionContainerOptions): string[] {
  const args = ["run", "-d", "--name", options.containerName, "-p", `${options.hostPort}:3050`];
  args.push("-e", `FIREBIRD_ROOT_PASSWORD=${options.sysdbaPassword}`);
  args.push("-e", `FIREBIRD_DATABASE=${options.databaseName}`);
  if (options.useLegacyAuth) {
    args.push("-e", "FIREBIRD_USE_LEGACY_AUTH=true");
  }
  if (options.volumeName) {
    args.push("-v", `${options.volumeName}:/var/lib/firebird/data`);
  }
  args.push(resolveImageReference(options.image));
  return args;
}

/** `docker run -d` prints the new container's full 64-char id (plus a trailing newline) on success. */
export function parseContainerId(stdout: string): string {
  return stdout.trim().split("\n").pop() ?? "";
}

/** Turns FIREBIRD_DATABASE's value into the absolute path a client connects to — same convention as docker-discovery.ts's suggestDatabasePath(), reused directly for consistency (a fresh container's database path is exactly this, no inspection needed since we chose the value ourselves). */
export function resolveDatabasePath(databaseName: string): string {
  return databaseName.startsWith("/") ? databaseName : `/var/lib/firebird/data/${databaseName}`;
}

/** A reasonably unique default container name, editable before running. */
export function suggestContainerName(): string {
  return `firebird-${Math.random().toString(36).slice(2, 8)}`;
}
