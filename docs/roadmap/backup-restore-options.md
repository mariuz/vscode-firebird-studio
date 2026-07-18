# Backup/Restore: Expose gbak Options

**Inspired by**: [vscode-pgsql](https://github.com/microsoft/vscode-pgsql)'s Database Backup (Preview, 1.27.0) — "Choose Backup... from a server or database in Object Explorer to create a `pg_dump` backup. Configure the output format, schema/data scope, object filters, compression, parallel jobs, and advanced options, then monitor or cancel the backup from VS Code."

## Current state in Firebird Studio

**Not started.** `NodeDatabase.backupDatabase()`/`.restoreDatabase()` (`src/nodes/node-database.ts`) already run a real `gbak` subprocess with real progress reporting — a `showSaveDialog`/`showOpenDialog` for the file, a status-bar spinner, and (since `docs/roadmap/connection-management-enhancements.md`'s phase 4) a Background Tasks entry — but the `gbak` invocation itself is bare: backup is always `gbak -b -user ... -password ... host/port:database backupPath`, restore is always `gbak -c -user ... -password ... backupPath host/port:restorePath`. None of `gbak`'s own backup/restore options are exposed — no compression, no metadata-only, no page size, no parallel/multi-file restore, no transportable-format toggle.

## Proposed feature

`gbak` itself already supports the switches that would matter here — this is exposing existing `gbak` capability through UI, not building new backup logic. The exact flag letters below are from memory, not verified live against a real `gbak -z`/`--help` the way this repo's other `gbak`-touching work has been (see e.g. `docs/roadmap/database-projects.md`'s "verified live" write-ups) — confirm them against the actual installed `gbak` version before wiring up the `args` array, since Firebird's own CLI tools have had flag-letter differences across major versions historically.

- **Backup options** (`gbak -b` flags): `-g` (garbage collection off, faster backup — off by default in `gbak` itself), `-t` (non-transportable format, smaller/faster but not portable across platforms — Firebird's own default is transportable), `-fa` (metadata only, no data), `-se` (Services API instead of a local connection, needed for a remote server without local `gbak` access to the file path). A `-par N` multi-file/parallel backup (Firebird 4+) for large databases.
- **Restore options** (`gbak -c` flags): `-p <size>` (page size for the restored database), `-o` (one-at-a-time restore, useful for diagnosing a restore failure), `-k` (no validity/data checks during restore, faster but riskier), `-rep` (replace an existing database outright rather than failing if the target already exists).
- A QuickPick-based "Backup options" step (matching this codebase's existing wizard patterns, e.g. `connection-wizard.ts`) before the file picker, defaulting to today's exact behavior (no flags — Firebird's own defaults) so nothing changes for anyone who doesn't open it.
- **Cancel support**: `gbak` is a real child process (`cp.execFile`) already — a `Cancel` button on the status bar item or the Background Tasks entry could call `child.kill()`, not currently offered at all.

## Suggested phases

1. A backup-options QuickPick (garbage collection, transportable format, metadata-only) threaded into `backupDatabase()`'s existing `args` array — additive flags only, default behavior unchanged.
2. Restore-options QuickPick (page size, one-at-a-time, replace-existing) for `restoreDatabase()`.
3. Cancel button wired to the already-running child process (`child.kill()`), surfaced from both the status bar item and the Background Tasks entry.
4. (Larger, separate effort) parallel/multi-file backup for large databases — `gbak -par N`, needs UI for choosing file count/paths, not just a flag.
