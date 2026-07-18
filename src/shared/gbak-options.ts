/**
 * Backup/Restore: Expose gbak Options (docs/roadmap/backup-restore-options.md), phase 1 — pure
 * flag-building for `gbak`'s own backup switches, verified directly against a real `gbak -z`
 * (Firebird 6.0) rather than trusted from memory; kept here (not inline in node-database.ts) so
 * it's unit-testable without needing a real child process or file dialogs.
 */

export interface BackupFlagChoices {
  /** `-G` — inhibit garbage collection during backup; faster, but doesn't reclaim space. */
  skipGarbageCollection?: boolean;
  /** `-ZIP` — the backup file itself is zip-compressed. */
  compress?: boolean;
  /** `-M` — backup schema only, no table data. */
  metadataOnly?: boolean;
  /** `-NT` — non-transportable format: smaller/faster, but only restorable on the same platform/architecture it was taken on. Firebird's own default is transportable. */
  nonTransportable?: boolean;
}

/** Returns the extra gbak flags for the given choices — [] when every choice is unset, matching gbak's own defaults exactly. */
export function buildBackupFlags(choices: BackupFlagChoices): string[] {
  const flags: string[] = [];
  if (choices.skipGarbageCollection) { flags.push("-G"); }
  if (choices.compress) { flags.push("-ZIP"); }
  if (choices.metadataOnly) { flags.push("-M"); }
  if (choices.nonTransportable) { flags.push("-NT"); }
  return flags;
}

/**
 * `gbak` has no established alternate name the way isql does (isql-fb vs. isql, to dodge
 * unixODBC's own isql) — one candidate name per platform.
 */
export function gbakCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["gbak.exe"] : ["gbak"];
}

/**
 * Resolves which gbak executable to launch — mirrors isql-terminal.ts's resolveIsqlExecutable()
 * and docker-discovery.ts's resolveDockerExecutable() exactly (this codebase already keeps these
 * three small and independent rather than sharing one abstraction between them): an explicit
 * `customPath` (the firebird.gbakPath setting) always wins if it actually resolves; otherwise
 * tries gbak on PATH. `checkExecutable` is injected so this is unit-testable without a real gbak
 * binary; extension.ts supplies a real spawn-based check.
 */
export async function resolveGbakExecutable(
  customPath: string | undefined,
  checkExecutable: (candidate: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform
): Promise<string | undefined> {
  if (customPath) {
    return (await checkExecutable(customPath)) ? customPath : undefined;
  }
  for (const candidate of gbakCandidates(platform)) {
    if (await checkExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
