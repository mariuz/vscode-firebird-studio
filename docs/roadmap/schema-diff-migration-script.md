# Schema Diff: Generate a Runnable Migration Script

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Schema Compare (GA 1.35.0) — "visually compare and script out schema differences" between two databases, producing an executable fix-up script from the comparison, not just a read-only report.

## Current state in Firebird Studio

**Not started**, and worth distinguishing from a capability that already exists nearby under a different entry point: `src/schema-diff/schema-diff.ts`'s `diffSchemas()` compares two live connections' `SchemaSnapshot`s and returns a structured `SchemaDiffResult` (tables/views/procedures/triggers only in source, only in target, or modified) — but `renderDiffReport()` only turns that into a human-readable **text report**. There is no path from a `SchemaDiffResult` to a runnable script that would actually apply the difference.

That script-generation machinery *does* already exist, just for a different comparison shape: `src/database-projects/publish-model.ts`'s `diffProjects()`/`buildPublishScript()` (`docs/roadmap/database-projects.md`) compares a Database Project's in-memory model against a live target and generates real DDL — including the safety-net add-copy-drop-rename sequence for column type changes Firebird's own `ALTER COLUMN` would reject outright (`isColumnTypeChangeSafeInPlace()`). Two live connections being diffed via `schema-diff.ts` today has no equivalent path to that same script generation — it's stuck at "here's what's different," never "here's how to fix it."

## Proposed feature

- Add a "Generate Migration Script" action to the schema-diff report view, converting the existing `SchemaDiffResult` into the same `PublishDiff` shape `buildPublishScript()` already consumes (both are fundamentally "tables/columns only in A, only in B, or changed" — the conversion is a data-reshaping exercise, not new diffing logic), then running the *existing, already-tested* `buildPublishScript()` against it. This reuses `database-projects`' column-type-safety logic (add-copy-drop-rename) and its existing test coverage rather than re-deriving DDL-generation rules a second time for what's structurally the same problem.
- Direction matters here in a way it doesn't for the project-vs-database case: schema-diff compares two arbitrary live connections, so the UI needs an explicit "which one is the target to modify" choice (today's report is direction-neutral: "only in source" / "only in target") before a script can be generated.
- The generated script should open as a new SQL document for review (matching `buildPublishScript()`'s existing "open, don't auto-execute" behavior in the Database Projects publish flow) — never executed automatically, consistent with every other DDL-generating feature in this extension.

## Suggested phases

1. Convert `SchemaDiffResult` → `PublishDiff` shape (a pure mapping function, unit-testable in isolation like the rest of `schema-diff.ts`/`publish-model.ts`).
2. "Generate Migration Script" action in the schema-diff report view, with an explicit target-direction picker.
3. Reuse `buildPublishScript()` unchanged; open the result as a new SQL document.
