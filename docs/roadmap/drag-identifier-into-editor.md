# Drag Object Explorer Entity into Editor

**Inspired by**: [vscode-pgsql](https://github.com/microsoft/vscode-pgsql) (1.9.0) — "Dragging an Object Explorer entity into an editor now inserts a correctly double-quoted identifier."

## Current state in Firebird Studio

**Not started.** `FirebirdTreeDataProvider` (`src/firebirdTreeDataProvider.ts`) implements plain `vscode.TreeDataProvider<FirebirdTree>` — no `TreeDragAndDropController`, confirmed absent from the whole codebase (no `handleDrag`/`handleDrop`/`dragMimeTypes` anywhere). Dragging a table/view/column from the tree into a SQL editor today does nothing; the only way to get an identifier into a query is typing it (with completion-provider help — `src/language-server/completionProvider.ts` already suggests table/field names) or copying it from wherever it's displayed.

## Proposed feature

- Implement `vscode.TreeDragAndDropController<FirebirdTree>` on `FirebirdTreeDataProvider`, registered via `TreeView.dragAndDropController` (needs switching from `window.registerTreeDataProvider()` to `window.createTreeView()` for the explorer view specifically, since `dragAndDropController` is only configurable through the latter) — `handleDrag()` sets a MIME payload (`text/plain` is enough; VS Code's editor drop handler already accepts a plain-text drop) to the node's real object name.
- **Correct quoting is the actual point, not just insertion** — Firebird identifiers only need double-quoting when they're not all-uppercase-and-simple (mixed/lower case, containing characters outside `[A-Z0-9_$]`, or colliding with a reserved word) per Firebird's own case-folding rules; an always-quote-everything approach would be technically safe but noisier than necessary for the common all-uppercase-unquoted-identifier case this codebase already assumes elsewhere (e.g. `sanitizeIdentifier()` in `src/shared/flat-file-parser.ts` already encodes similar Firebird identifier rules for a different feature — reuse or mirror that logic rather than re-deriving quoting rules a third time).
- Scope to `NodeTable`/`NodeView`/`NodeProcedure`/`NodeField` (and similar) nodes specifically — dragging a category folder (`NodeCategoryFolder`) or a host/database node has no sensible single-identifier text to insert.

## Suggested phases

1. `TreeDragAndDropController` wired up for `NodeTable`/`NodeView`/`NodeField`/`NodeProcedure`/`NodeGenerator`/`NodeDomain` nodes, inserting the bare (unquoted) object name — the simplest version, correct for the common case.
2. Quoting logic (reusing/mirroring `sanitizeIdentifier()`'s existing case/character rules) for the identifiers that actually need it.
