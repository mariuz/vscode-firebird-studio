# Graphical Query Plan Visualizer

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Query Plan Visualizer (interactive node navigation over the SQL Server execution plan) and its Estimated/Actual Plan toggle commands, and [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql)'s Query Plan Visualizer (four synchronized views — node graph, icicle chart, sortable table, and raw source — plus importing a saved plan file with no live connection, and a "Analyze with Copilot" action).

## Current state in Firebird Studio

**Phases 1, 2, (partially) 4, and (partially) 5 are done.** `Driver.getQueryPlan()` (`src/shared/driver.ts`) still returns plain text — that's unchanged, and `firebird.explainPlan` still dumps it into a plaintext editor exactly as before — but there's now a second, graphical way to view the same plan:

- `src/shared/plan-parser.ts` — `parsePlan(planText): PlanNode[]` parses Firebird's legacy `PLAN (...)` syntax into a tree (or forest — a statement with subqueries produces multiple top-level blocks). **The grammar was reverse-engineered against a real Firebird 3.0 server** (a scratch database created and queried directly via `isql-fb` in this environment, not just recalled from documentation), which corrected two wrong assumptions this doc originally made:
  1. `JOIN` doesn't nest each participant as its own sub-plan (`JOIN (PLAN(...), PLAN(...))`) — it's a **flat**, comma-separated list of scans, regardless of how many tables are joined: `JOIN (A NATURAL, B INDEX (IB), C INDEX (IC))`.
  2. `SORT` isn't only ever wrapped around a `JOIN` — it can wrap a flat list of scans directly (seen from a `UNION` query) *or* a nested `JOIN (...)` (seen from an `ORDER BY` on a joined query that couldn't use an index to satisfy it). Wrapper nodes (`JOIN`/`HASH`/`MERGE`/`SORT`) genuinely recurse into either scans or other wrappers.
  
  `HASH` was directly observed too (a hash join); `MERGE` wasn't triggered by the available test data but shares the identical `KEYWORD (item, item, ...)` shape as the other three in every case that was observed, so it's parsed the same way. See the file's header comment for the full reasoning and the exact captured strings this was built against.
- `src/query-plan-view/` — a new webview (`QueryPlanView`, following the same scaffolding as `schema-designer`/`result-view`) that renders the parsed tree as a node diagram: a classic layered-tree layout (scans are leaves, wrapper nodes branch), pan/zoom/fit, click a node for a detail panel (access method, index name(s)), and a "Raw Text" toggle showing the underlying `PLAN (...)` string. New command `firebird.showEstimatedPlan` (keybinding `Ctrl+Alt+Shift+E` / `Cmd+Alt+Shift+E`, mirroring `firebird.explainPlan`'s `Ctrl+Alt+E`) opens it for the active editor's query, same resolution behavior (`Driver.getQueryPlan()` resolves from the active editor/active connection when not given explicit args). When the pure-JS driver's non-machine-readable fallback text is detected (checked by prefix before even attempting to parse), shows a clear "enable the native driver" message instead of a parse error.

### Phase 5 — table view and "import a saved plan"

- **Sortable table view**: a "Table View" toolbar toggle switches the same parsed tree from the node diagram to a flat, one-row-per-node `<table>` (`flattenBlocks()` in `app.js` walks the tree depth-first) with columns Node/Table/Access Method/Index(es)/Depth; clicking a column header sorts by it (numeric compare for `#`/Depth, case-insensitive string compare otherwise), clicking again reverses direction. No new layout code or extension-host round-trip — it's a second renderer over the exact same `blocks` data the diagram already has.
- **Cross-view selection**: clicking a node in either the diagram or the table selects it and shows the same detail panel; selection now tracks the stable underlying `PlanNode` (`selectedNode`) rather than an ephemeral layout-tree object, which also fixes a latent bug in the original diagram-only selection — `render()` rebuilds fresh layout objects on every call, so comparing against the previous call's layout-tree node (`selectedLayoutNode === layout`) could never actually match, meaning the `fb-selected` highlight silently never applied. Found while wiring the table view to share selection state with the diagram, not through separate investigation.
- **Import a saved plan**: a new "Import Plan" toolbar button (`QueryPlanView.importFromFile()`) opens a file picker, reads the file via the same `fs/promises` `readFile()` pattern `flat-file-import/index.ts` already uses, and feeds it through the exact same `parseAndSend()` path a live fetch uses (fallback-text detection, `parsePlan()`, error reporting) — so an imported plan (e.g. one pasted from `firebird.explainPlan`'s plaintext output, or `isql`'s `SET PLANONLY ON`) behaves identically to a freshly-fetched one, with no live connection needed.
- Still not done from phase 5: a "source" view (vscode-pgsql's fourth synchronized view, distinct from this table view) wasn't in the original phase description in enough detail to scope separately from the table view — no action taken here.
- **Verified**: a one-off Node harness (not committed, same convention as the tree-layout math below) drove `flattenBlocks()`/`sortRows()` against the real `SORT (JOIN (D NATURAL, E INDEX (FK_EMP_DEPT)))` fixture from `plan-parser.test.ts` — confirmed depth-first row order/depths, correct index-detail extraction, and both ascending/descending sort (string and numeric columns).

### Explicitly deferred (not done)

- **Phase 3 — Actual vs. Estimated**: no `MON$STATEMENTS`/`MON$RECORD_STATS` overlay yet; the diagram only ever shows the estimated plan. Worth flagging for whoever picks this up next: Firebird's monitoring tables report I/O and record-access counters at the *statement* level, not per plan-node — there's no obvious `MON$` source for "this specific JOIN step did N index reads," so this phase may need a different data source entirely (e.g. Firebird's trace API) rather than being a straightforward overlay query, unlike phase 5 above which turned out to need no new data access at all.
- **Phase 4, remainder — result-view tab integration**: `firebird.showEstimatedPlan` opens a standalone webview panel today, not a tab alongside Results/Messages in `src/result-view/`.
- **Phase 6 — Copilot "Analyze" action.**
- **Phase 7 — icicle chart view.**

### Testing

`src/test/plan-parser.test.ts` — 15 tests, every fixture string captured verbatim from the real server (not invented), covering every scan method, all four wrapper keywords, nesting, mixed-case identifiers, multi-block plans, and malformed input. The webview's layout/rendering JS (`src/query-plan-view/htmlContent/js/app.js`) has no automated coverage, matching this repo's convention for webview inline JS — verified instead with one-off Node harnesses (not committed): one checking the tree-layout math (leaf counting, centering a parent over its children, side-by-side placement of independent blocks), and a second (added for phase 5) checking `flattenBlocks()`/`sortRows()`, both against real plan shapes from `plan-parser.test.ts`'s fixtures.

## Technical notes

- The native-driver requirement matters here: without it, there's no real machine-readable plan to parse (the pure-JS fallback is explicitly a heuristic string, not real Firebird plan syntax) — `QueryPlanView` detects this by checking the fallback text's known prefixes before attempting to parse, rather than surfacing a confusing parse error.
- Keep the plan parser and the rendering layer separate (parser is pure/testable; the webview is presentation-only) — matches this repo's stated convention of isolating SQL-parsing logic into pure functions. This paid off directly: the two grammar corrections above were found and fixed in the parser alone, with zero changes needed to the (not-yet-written-at-the-time) rendering code.
- If you need to re-derive real plan fixtures for further work on the parser (e.g. to finally trigger a genuine `MERGE` plan), a Firebird 3.0 server is reachable in this environment via `isql-fb`; `plan-parser.ts`'s file header documents the exact scratch-database setup used.
- An "icicle chart" (vscode-pgsql's fourth view: a horizontal stacked-bar breakdown of cost/time by plan node, nesting shown as bar width rather than tree depth) is a nice way to spot the single most expensive node at a glance in a large plan, but it's a distinct rendering mode from the node-link diagram, not a trivial CSS variant of it — treat it as optional polish after the table/source views (which are much cheaper, reusing the same parsed-tree data with no new layout code) rather than a priority.

## Suggested phases (remaining)

1. ~~Write `plan-parser.ts` + unit tests against real Firebird plan strings.~~ — **done**.
2. ~~Static diagram webview for the *estimated* plan only.~~ — **done**.
3. Add the actual-plan monitoring overlay using `MON$STATEMENTS`/`MON$RECORD_STATS`.
4. Move from a standalone panel to a result-view tab alongside Results/Messages.
5. ~~Add the sortable table view as an alternate renderer of the same parsed tree; add "import a saved plan" (paste/open a file, no connection needed).~~ — **done**.
6. Add the Copilot "Analyze" action.
7. (Optional polish) icicle chart view.
