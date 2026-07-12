# SQL Notebooks

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s SQL Notebooks ("Jupyter-based SQL notebooks with rich results and multi-kernel support").

## Current state in Firebird Studio

**Phase 1 is done.** `.fbnb` notebooks (`contributes.notebooks`, `firebird.notebook.new` to create one) run Firebird SQL cells via VS Code's native Notebook API:

- `src/sql-notebook/serializer.ts` (`FirebirdNotebookSerializer`) — round-trips a small custom JSON shape (`{cells: [{kind, value, languageId}]}`), not Jupyter's `.ipynb` nbformat — this is a single-kernel, SQL-only notebook, so nbformat's cross-kernel metadata would be unused ceremony. A brand-new/empty file opens with one blank SQL cell.
- `src/sql-notebook/controller.ts` (`createSqlNotebookController()`) — a `NotebookController` (`supportedLanguages: ['sql']`) whose `executeHandler` runs each cell's text through `Driver.runBatch()` (the same call the regular editor/"Run Query" flow uses) and renders each `BatchResult` as its own `NotebookCellOutput`: an error renders via `NotebookCellOutputItem.error()`, a DDL/DML success message as plain text, and rows as a GitHub-flavored markdown table (`src/shared/notebook-render.ts#renderRowsAsMarkdown()`, unit-tested) — markdown is one of VS Code's natively-rendered output mime types, so Phase 1 needs no custom notebook renderer yet.
- **Connection binding is in-memory only for now** (`resolveNotebookConnection()` in `controller.ts`, keyed by `notebook.uri.toString()`): the first cell run without a bound connection shows the same connection quick-pick pattern used elsewhere (`schemaDiff`'s source/target picker), and reuses that choice for later cells in the same VS Code session — but it isn't persisted into the `.fbnb` file's metadata, so reopening a notebook re-prompts. See "Explicitly deferred" below.

The pre-existing state this replaces: query execution was previously file/selection based only (`Driver.runQuery()`/`runBatch()` against a `.sql` document), with results always going to the `src/result-view/` webview — there was no notebook surface and no `NotebookController` registration in `src/extension.ts`.

### Explicitly deferred (not done)

- **Phase 2 — custom rich-results renderer**: cell output today is a plain markdown table (sortable/filterable/exportable only by copy-pasting elsewhere) — no `contributes.notebookRenderer` reusing `src/result-view/htmlContent`'s grid (sort/filter/export/edit) as a notebook output renderer yet.
- **Phase 3 — persisted connection binding**: the connection a notebook uses isn't written back into the `.fbnb` file (e.g. via `NotebookEdit.updateNotebookMetadata()`), so it doesn't survive reopening the file or a VS Code restart; only "prompt once per open notebook, reuse across its cells" is implemented.
- **Multi-kernel support**: intentionally out of scope, per the original note below — this is a single Firebird-SQL kernel only.
- **Test coverage for the controller/serializer's vscode-API surface**: `src/shared/notebook-render.ts`'s pure markdown rendering has full unit test coverage, but `NotebookController`/`NotebookSerializer`/`NotebookCellExecution` aren't mocked in `src/test/mocks/vscode.ts` (flagged as a likely gap before this was built) — `serializer.ts`/`controller.ts` themselves have no automated coverage yet; that would need either new mocks for the notebook API surface or pushing coverage to the `suite`/vscode-host tier.

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

1. ~~Serializer + controller with plain-text/markdown cell output only (prove out the execution wiring).~~ — **done**.
2. Swap in the custom notebook renderer reusing `result-view` grid code for rich output.
3. Connection-binding UX (persist + prompt) — prompting is done; persisting to the notebook file is not.
