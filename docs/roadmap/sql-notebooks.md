# SQL Notebooks

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s SQL Notebooks ("Jupyter-based SQL notebooks with rich results and multi-kernel support").

## Current state in Firebird Studio

None — query execution today is file/selection based (`Driver.runQuery()`/`runBatch()` against a `.sql` document), with results always going to the `src/result-view/` webview. There's no notebook surface and no `NotebookController` registration in `src/extension.ts`.

## Proposed feature

VS Code has a first-class Notebook API (`vscode.NotebookController`, `NotebookSerializer`) — this doesn't need Jupyter itself, just VS Code's native notebook UI:

1. **Serializer** — a `.fbnb` (or reuse `.ipynb` for interop with existing Jupyter tooling) file format: cells are either markdown or Firebird SQL. Implement `NotebookSerializer.deserializeNotebook`/`serializeNotebook` to round-trip cell content + outputs.
2. **Controller** — register a `NotebookController` for the `sql`-cell language that, on cell execution, calls `Driver.runQuery()` (same call the regular query flow uses) and renders each `BatchResult` as a notebook cell output — reuse the existing result-rendering logic from `src/result-view/` rather than building a second grid renderer; the notebook cell output can embed the same HTML/webview-renderer content as a `NotebookCellOutputItem` of mime type `text/html` (or a custom `application/vnd.firebird.result+json` renderer registered via `contributes.notebookRenderer` for a richer grid than plain HTML allows).
3. **Connection binding** — a notebook needs to remember which saved connection it's bound to (metadata stored in the notebook document, similar to how `.sql` editors already track an active connection via `Global`/status bar) — first cell run without a bound connection should prompt the same connection quick-pick used elsewhere.
4. **Multi-kernel** mention in mssql's feature table likely refers to supporting both SQL and, e.g., PowerShell/Python kernels in one notebook (for scripting around results) — that's out of scope for an initial Firebird port; scope this feature to a single Firebird-SQL kernel and revisit multi-kernel only if there's demand.

## Technical notes

- This is one of the larger lifts on this list: it's a genuinely new UI surface (notebooks), not an extension of an existing webview, and needs its own `contributes.notebooks` + `contributes.notebookRenderer` entries in `package.json`.
- Output rendering is the crux of the "rich results" promise — a plain markdown table per cell is easy but loses sort/filter/export; a custom notebook renderer that reuses `src/result-view/htmlContent` is more work but keeps parity with the existing query-results experience users already know.
- Needs its own unit/e2e testing story: `NotebookController`/`NotebookSerializer` aren't in `src/test/mocks/vscode.ts` today and would need mocking (same gap noted for the Copilot chat participant) or coverage pushed entirely to the `suite`/vscode-host tier.

## Suggested phases

1. Serializer + controller with plain-text/markdown cell output only (prove out the execution wiring).
2. Swap in the custom notebook renderer reusing `result-view` grid code for rich output.
3. Connection-binding UX (persist + prompt).
