# Firebird Database Projects (schema-as-code)

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s SQL Database Projects extension (offline `.sqlproj` authoring, build, and publish) and DACPAC/BACPAC deploy/extract.

## Current state in Firebird Studio

- `src/schema-diff/schema-diff.ts` (262 lines) already does the hard part of this feature's foundation: `fetchSchemaSnapshot()` reads a full schema from a live connection, `diffSchemas()` compares two snapshots, `renderDiffReport()` produces a **text report** — but today this only runs connection-vs-connection, ad hoc, and produces a human-readable diff, not an executable migration script.
- There's no on-disk "project" representation of a schema at all — no folder of versioned `CREATE TABLE`/`CREATE PROCEDURE` files, no build step, no publish/migrate command.
- Backup/restore already exists (`gbak`/`nbackup` integration per ROADMAP.md), which covers the DACPAC/BACPAC "package a whole database" use case reasonably well for Firebird already (a `.fbk` backup *is* schema+data in one portable file) — so this feature should focus on the **schema-as-code / versioned-migration** angle mssql's Database Projects extension targets, not re-implement packaging that `gbak` already does.

## Proposed feature

1. **Project structure**: a folder (e.g. `firebird-project/`) containing one `.sql` file per object (tables, views, procedures, triggers, generators, domains), plus a manifest (`firebird.project.json`) listing target Firebird version and object ordering/dependencies.
2. **Extract**: given a live connection, walk the same metadata queries the tree provider uses and write out one file per object — effectively "reverse-diff" a live schema into a project. This can share code with `fetchSchemaSnapshot()`.
3. **Build**: concatenate/order the project's files into a single deployable script, validating dependency order (tables before FKs that reference them, etc.) — the ordering logic is the main new piece; `schema-diff.ts` doesn't need this today since it only compares two already-existing schemas.
4. **Publish/migrate**: diff the built project against a target connection's live schema (reusing `diffSchemas()` almost as-is, just with one side being "project snapshot" instead of "connection B snapshot") and generate an executable migration script (`ALTER TABLE ...`, `CREATE OR ALTER PROCEDURE ...`) instead of today's human-readable-only report. This is the single biggest net-new piece of logic: `renderDiffReport()` currently formats differences for reading, not for re-execution.
5. Surface as commands: `firebird.project.extract`, `firebird.project.build`, `firebird.project.publish`, discoverable from a connection's context menu (same `contributes.menus."view/item/context"` pattern used for `firebird.schemaDiff`, see `package.json`).

## Technical notes

- Reuses more existing code than any other item on this list — `schema-diff.ts`'s snapshot/diff engine is directly extensible rather than needing a parallel implementation.
- The riskiest new logic is generating *safe, executable* ALTER statements from a diff (e.g. handling a column type change that requires a temp-column-and-copy dance in some cases, or FK drop/recreate ordering) — this deserves its own careful design pass once started, likely with a "preview, then confirm" step before ever running against a real database, matching the "always show generated SQL for review" convention already established for DDL-generating features (mock data, table designer).
- Workspace-level config already has a placeholder ROADMAP item ("Workspace-level database configuration (`.vscode/firebird.json`)") — that setting is a natural home for "which project folder + which connection is this workspace's project bound to."

## Suggested phases

1. Extract command (live connection → project folder of `.sql` files), no build/publish yet.
2. Build command (ordered concatenation + dependency validation).
3. Publish/migrate command generating executable ALTER scripts from `schema-diff.ts`'s comparison, always opened for review before execution.
