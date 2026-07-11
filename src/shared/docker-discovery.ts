/**
 * Pure, dependency-injectable logic for discovering Firebird servers running in local Docker
 * containers, used by the "Add New Connection" wizard's Docker option. Kept free of any
 * `vscode`/`child_process` imports (the actual spawning lives in connection-wizard.ts) so it's
 * unit-testable the same way shared/isql-terminal.ts is.
 */

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  ports: string;
  status: string;
}

export interface DiscoveredFirebirdContainer {
  container: DockerContainerInfo;
  hostPort: number;
}

/** Args for `docker ps` producing one JSON object per line (NDJSON) — easy to parse per-line. */
export function dockerPsArgs(): string[] {
  return ["ps", "--format", "{{json .}}"];
}

/**
 * Parses `docker ps --format '{{json .}}'` output. Tolerates blank lines and lines that aren't
 * valid JSON (e.g. a stray Docker CLI warning printed to stdout) by skipping them rather than
 * throwing, since a single malformed line shouldn't hide every other real container.
 */
export function parseDockerPsOutput(output: string): DockerContainerInfo[] {
  const containers: DockerContainerInfo[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    try {
      const raw = JSON.parse(trimmed);
      if (typeof raw.ID === "string" && typeof raw.Image === "string") {
        containers.push({
          id: raw.ID,
          name: typeof raw.Names === "string" ? raw.Names : raw.ID,
          image: raw.Image,
          ports: typeof raw.Ports === "string" ? raw.Ports : "",
          status: typeof raw.Status === "string" ? raw.Status : "",
        });
      }
    } catch {
      // Not a JSON line — ignore.
    }
  }
  return containers;
}

/**
 * Extracts the host-side published port for a given container port from docker ps's "Ports"
 * text, e.g. "0.0.0.0:3050->3050/tcp, :::3050->3050/tcp" -> 3050, or a random host port like
 * "0.0.0.0:32768->3050/tcp" -> 32768. Returns undefined if that container port isn't published
 * to the host at all (container-internal only, e.g. bare "3050/tcp" with no "->").
 */
export function extractHostPort(portsText: string, containerPort: number = 3050): number | undefined {
  const pattern = new RegExp(`:(\\d+)->${containerPort}/tcp`);
  const match = portsText.match(pattern);
  return match ? Number(match[1]) : undefined;
}

/**
 * Filters docker ps output down to containers that publish Firebird's well-known port (3050) to
 * the host. Deliberately not filtered by image name — users may run custom-tagged or private
 * Firebird images — the published port is a stronger, image-agnostic signal.
 */
export function discoverFirebirdContainers(containers: DockerContainerInfo[]): DiscoveredFirebirdContainer[] {
  const results: DiscoveredFirebirdContainer[] = [];
  for (const container of containers) {
    const hostPort = extractHostPort(container.ports);
    if (hostPort !== undefined) {
      results.push({ container, hostPort });
    }
  }
  return results;
}

/** Args for `docker inspect <id>` producing one `KEY=VALUE` env-var line per line. */
export function dockerInspectEnvArgs(containerId: string): string[] {
  return ["inspect", containerId, "--format", "{{range .Config.Env}}{{println .}}{{end}}"];
}

/** Parses the newline-separated `KEY=VALUE` output of dockerInspectEnvArgs() into a map. */
export function parseDockerInspectEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  return env;
}

/**
 * The official firebirdsql/firebird image's FIREBIRD_DATABASE env var accepts either a bare
 * filename (placed under its default data directory) or an absolute path. Turns either form
 * into the absolute path a client actually connects to, for pre-filling the wizard's database
 * prompt — same /var/lib/firebird/data/ convention this repo's own CI containers use.
 */
export function suggestDatabasePath(firebirdDatabaseEnv: string | undefined): string | undefined {
  if (!firebirdDatabaseEnv) { return undefined; }
  return firebirdDatabaseEnv.startsWith("/") ? firebirdDatabaseEnv : `/var/lib/firebird/data/${firebirdDatabaseEnv}`;
}

export function dockerCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["docker.exe"] : ["docker"];
}

/**
 * Resolves the docker executable the same way resolveIsqlExecutable() does: an explicit setting
 * wins outright (and fails outright if it doesn't check out — no silent fallback to PATH once
 * the user has been explicit), otherwise tries each PATH candidate in order.
 */
export async function resolveDockerExecutable(
  customPath: string | undefined,
  checkExecutable: (candidate: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform
): Promise<string | undefined> {
  if (customPath) {
    return (await checkExecutable(customPath)) ? customPath : undefined;
  }
  for (const candidate of dockerCandidates(platform)) {
    if (await checkExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
