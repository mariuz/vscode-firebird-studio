# Query Results Grid Enhancements

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s ongoing Query Results Grid work — Text View mode for result sets (1.35.0), selection aggregations (count/sum/average shown when selecting rows or columns, 1.37.0), configurable grid font via `mssql.resultsFontSize`/`mssql.resultsFontFamily` (1.28.0), and a newer results-grid rework adding per-column show/hide alongside freeze (1.44.0, preview).

## Current state in Firebird Studio

**Phase 1 is done.** The grid this extends (`src/result-view/htmlContent/js/app.js`, backing `ResultView`) was already fairly mature going in — worth being precise about what was already there so this doc only proposed genuinely new ground:

- Already done (before this doc): sort/filter per column (DataTables-backed), CSV/JSON/XLSX/PDF export, pagination, one tab per statement in a multi-statement batch (`$tabBar`/`.fb-tab` — Firebird Studio's existing answer to "multiple result sets," a different but equivalent shape to mssql's single-query-multiple-result-set model), inline row editing with a script preview (add/edit/delete, `$apply`), and a **Freeze Column** toggle (`$freezeToggle` in `app.js`).
- **Phase 1 — Text View mode — done.** A "📄 Text View" toolbar button next to the existing grid toolbar (`$textViewToggle`, alongside `$freezeToggle`/`$chartToggle`) toggles a panel below the table rendering the *original* headers/rows (not DataTables' current sort/filter/page state — the same deliberate scope cut the pre-existing chart panel already established) as tab-client-style aligned plain text, via a new pure `buildTextView(headers, rows)` function: a header line, a dashed separator line, then one line per row, every column padded to its widest value (header included), `NULL`/`undefined` cells rendered as the literal `NULL` (distinguishing them from an empty string, which renders as blank). A "Copy" button in the panel copies the rendered text to the clipboard via the existing `copyToClipboard()` helper. Rendered lazily (only on first toggle-open, matching the chart/plan panels' existing pattern), not on every render of the table.
- Not done yet: an aggregation readout (sum/avg/count/min/max) for a selected range of cells, per-column show/hide (freeze exists; hide doesn't), font-size/family customization for the grid itself, and the "View Table Diagram" toolbar button.

### Testing

`src/test/result-view-webview.test.ts` gained a `buildTextView()` suite (6 tests, via the file's existing `__test__` hook pattern): header/separator/row-line shape, column-width padding driven by the widest cell in the column (header included, even when the header itself is the widest), `NULL` vs. empty-string distinction, a zero-row result set, and a numeric (not just string) cell. The DOM wiring itself (button creation, panel show/hide, lazy first-render) isn't independently tested, consistent with this repo's established boundary for webview inline JS — `buildTextView()` is exactly the "pure, no DOM/jQuery" function this file's own section comments already carve out as testable, the same category `sqlLiteral()`/the chart SVG builders fall into.

## Proposed feature

1. ~~**Text View mode.**~~ — **done**, see above.
2. **Selection aggregations.** When one or more cells are selected (the grid likely already tracks a selection range for copy-to-clipboard; reuse that), show a small status-bar readout — count always, and sum/average/min/max for the selection when every selected cell in a column parses as numeric. Mirrors what mssql shows when you drag-select a range of numeric cells.
3. **Column show/hide.** Alongside the existing per-column Freeze toggle, a column-visibility menu (checkbox list, one entry per column) that hides columns from the DataTable without discarding them from the underlying result — matches the "hide, not filter out" semantics DataTables' own `column().visible()` API already gives for free, so this is mostly wiring a new toolbar menu rather than new data-layer work.
4. **Grid font customization.** New `firebird.resultsFontSize`/`firebird.resultsFontFamily` settings (matching mssql's naming), applied as inline CSS custom properties on the results webview's root element, read once at render time the same way other `firebird.*` settings are threaded into a webview's initial payload elsewhere in this codebase.
5. **"View Table Diagram" from the row-editing toolbar.** mssql's Edit Data toolbar (1.42.0) added a button opening the current table and its relationships directly in Schema Designer. Firebird Studio already has both halves separately — inline row editing here, and `src/schema-designer/` already builds a whole-database ER graph from the same `getSchemaColumnsQuery()`/`getForeignKeysQuery()` this feature would need — so this is purely a new toolbar button next to `$freezeToggle` that opens the existing Schema Designer webview (`firebird.schemaVisualizer.open`) pre-focused on the table currently being edited, not new schema-introspection logic.

## Suggested phases

1. ~~Text View mode (toolbar toggle, client-side only, no protocol changes).~~ — **done**.
2. Selection aggregations status-bar readout.
3. Column show/hide menu (reusing DataTables' `column().visible()`).
4. `firebird.resultsFontSize`/`firebird.resultsFontFamily` settings, threaded into the results webview's initial render payload.
5. "View Table Diagram" toolbar button, wiring into the existing `firebird.schemaVisualizer.open` command.
