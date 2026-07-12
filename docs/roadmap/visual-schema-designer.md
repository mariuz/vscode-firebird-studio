# Visual Schema Designer

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Schema Designer (visual modeling, drag-and-drop, auto-layout, T-SQL script generation) and its Copilot integration ("GitHub Copilot in Schema Designer").

## Current state in Firebird Studio

Two separate, more limited pieces already exist:

- `src/schema-visualizer/` (`index.ts`, `schema-graph.ts`, ~150 lines) — renders a **read-only** diagram of tables/relationships for an existing database. No editing, no layout persistence.
- `src/table-designer/` (`src/table-designer/index.ts`, 41 lines) — a webview for building **one new table's** DDL. `TableDesigner.open()` takes no existing-table/schema argument, so it can't be pre-populated to *alter* a table. Its webview only posts two messages back to the extension: `openInEditor` and `executeDDL` (see `src/table-designer/htmlContent/index.html:173-183`), both handled in `TableDesigner.handleMessage()`.

There is no way today to visually add/remove/relate multiple tables in one session and generate a consolidated DDL script, and no way to open the designer against an *existing* table for alteration.

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

- Webview messaging needs a new message type for "load existing schema" (today's `table-designer/htmlContent/index.html` only listens for messages, never receives an init payload — see the `window.addEventListener('message', ...)` handler at line 183, currently unused for that purpose).
- Multi-table FK editing requires validating that referenced columns exist and have matching types before generating `ADD CONSTRAINT ... FOREIGN KEY`; surface violations inline rather than only failing at `executeDDL` time.
- Should replace the existing unchecked ROADMAP item "Visual table designer for creating and modifying tables" and the "Create, alter, and drop database objects directly from the UI" item — this feature covers both once it supports alter.

## Suggested phases

1. Extend `TableDesigner` to accept an existing table's metadata and support `ALTER TABLE` generation for a single table (closes the "modifying tables" gap without the multi-table diagram yet).
2. Merge in the multi-table canvas from `schema-visualizer`, adding editing affordances (add table/column, draw FK).
3. Add the draft-vs-live diff engine reusing `schema-diff.ts`.
4. Add the Copilot "modify this schema" panel.
