# Visual Schema Designer

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Schema Designer (visual modeling, drag-and-drop, auto-layout, T-SQL script generation) and its Copilot integration ("GitHub Copilot in Schema Designer").

## Current state in Firebird Studio

Two separate, more limited pieces already exist:

- `src/schema-visualizer/` (`index.ts`, `schema-graph.ts`, ~150 lines) — renders a **read-only** diagram of tables/relationships for an existing database. No editing, no layout persistence.
- `src/table-designer/` (`src/table-designer/index.ts`) — a single-table webview. **Phase 1 below is done**: `TableDesigner.openForAlter(dbDetails, tableName, columns, pkConstraintName)` pre-populates the form from an existing table (via a `ready`/`init` handshake — the webview posts `ready` once its script has loaded, and the extension flushes a queued `init` message rather than racing a `postMessage()` sent immediately after `show()`) and the webview diffs the edited rows against each column's original snapshot (tracked via a `data-original` attribute per row, keyed by the column's *original* name so a renamed column is detected as `ALTER COLUMN old TO new` rather than a destructive drop+recreate) to generate `ALTER TABLE ADD/DROP/ALTER COLUMN` and primary-key constraint changes. `NodeTable#alterTable(tableDesigner)` (in `src/nodes/node-table.ts`) is the entry point, wired to the `firebird.table.alterTable` command. Still single-table only — no multi-table canvas, no FK editing.

There is still no way to visually add/remove/relate **multiple** tables in one session and generate a consolidated DDL script — that's what phases 2-4 below are for.

## Proposed feature

A single webview, replacing/absorbing both of the above, that:

1. Loads the current schema (tables, columns, PK/FK/unique constraints) via the existing tree/queries plumbing (`src/shared/queries.ts`, same metadata queries the tree provider already uses) and lays it out as a node-link diagram (reuse `schema-graph.ts`'s layout code as a starting point — it already computes positions from FK relationships).
2. Supports editing in place: add/remove tables, add/remove/edit columns and types, draw a relationship line between two columns to create a FK, right-click a table for "Alter" vs. "Drop".
3. Continuously diffs the in-memory design against the schema it was loaded from and generates the DDL needed to reconcile them (`CREATE TABLE`, `ALTER TABLE ... ADD/DROP/ALTER COLUMN`, `ADD CONSTRAINT`) — this reuses the diffing approach already built for `src/schema-diff/schema-diff.ts`, just comparing an in-memory draft instead of two live connections.
4. Offers the same two exits `TableDesigner` already has: **Open in Editor** (`Driver.createSQLTextDocument()`) and **Execute** (`Driver.runQuery()`), plus a running preview pane of the generated DDL so the user always sees exactly what will run.
5. Auto-layout: port or replace `schema-graph.ts`'s placement logic with a simple force-directed or layered layout (no need for a heavy layout library — a dependency-order layered layout based on FK direction is enough for typical schemas).

## Copilot integration

Add a "Ask Copilot to modify this schema" affordance in the designer's toolbar that pipes the current in-memory design (serialized the same way `schema-context.ts` serializes schema for the chat participant) plus a free-text instruction into a `vscode.LanguageModelChatMessage` request — same `request.model.sendRequest()` pattern already used in `src/copilot/copilot-chat-participant.ts`. The model returns a diff-style DDL patch which the designer applies to its in-memory model and re-renders, rather than dumping raw SQL into a chat pane. This is the natural extension of the `/designSchema` slash command added earlier: that command designs one table from sample data in chat; this lets the same underlying model iterate on a whole multi-table diagram interactively.

## Technical notes

- The `ready`/`init` handshake and the "diff by original column name, not by current name" design (phase 1) generalize directly to the multi-table case — the same per-row original-snapshot approach just needs to key by `(tableName, columnName)` instead of `columnName` alone once multiple tables are on one canvas.
- Multi-table FK editing requires validating that referenced columns exist and have matching types before generating `ADD CONSTRAINT ... FOREIGN KEY`; surface violations inline rather than only failing at `executeDDL` time.
- Firebird can't rename a table via `ALTER TABLE`, and pre-4.0 servers don't support `ALTER COLUMN ... SET/DROP NOT NULL` — phase 1 already surfaces the latter as an inline SQL comment on the generated statement rather than silently emitting something that won't run; carry the same honesty forward into the multi-table generator.

## Suggested phases

1. ~~Extend `TableDesigner` to accept an existing table's metadata and support `ALTER TABLE` generation for a single table~~ — **done**.
2. Merge in the multi-table canvas from `schema-visualizer`, adding editing affordances (add table/column, draw FK).
3. Add the draft-vs-live diff engine reusing `schema-diff.ts`.
4. Add the Copilot "modify this schema" panel.
