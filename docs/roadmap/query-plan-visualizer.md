# Graphical Query Plan Visualizer

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Query Plan Visualizer (interactive node navigation over the SQL Server execution plan) and its Estimated/Actual Plan toggle commands.

## Current state in Firebird Studio

`Driver.getQueryPlan()` (`src/shared/driver.ts:305`) already returns a plan, but only as **plain text**:

- With the native driver (`NativeClient.getQueryPlan()`, `src/shared/driver.ts:495`): the real Firebird `EXPLAIN PLAN` string from `Attachment.prepare()` + `Statement.getPlan()`.
- With the pure-JS driver (default, `node-firebird`): a heuristic fallback built from `extractTableNames()` and index metadata (`src/shared/driver.ts:320-351`), clearly labeled as a fallback, not a real plan.

This text is presumably surfaced today only as a dump (e.g. into a panel or editor) — there's no diagram, no per-node cost breakdown, no click-to-inspect.

## Proposed feature

1. **Parse** Firebird's plan syntax (`PLAN (TABLE NATURAL|INDEX (...) JOIN ...)`, nested `PLAN JOIN (...)`, `SORT`, `MERGE`) into a small tree structure — a new pure function module (e.g. `src/shared/plan-parser.ts`), unit-testable the same way `sql-formatter.ts`/`sql-linter.ts` are (per `tsconfig.test.json`'s pattern of listing pure modules for the unit tier).
2. **Render** the parsed tree as a node-link diagram in a webview (new `src/query-plan-view/`, following the same webview scaffolding as `src/result-view/` or `src/schema-visualizer/`): each node is a table scan or join step, edges show data flow, clicking a node shows details (index used, natural vs. indexed access, estimated cost if the native driver's plan carries cost info).
3. **Estimated vs. Actual**: Firebird's `EXPLAIN PLAN` from `Statement.getPlan()` is available without executing (estimated); to get "actual" per-node stats, correlate with `MON$STATEMENTS`/`MON$RECORD_STATS` for the just-run statement (Firebird doesn't expose true per-operator runtime stats like SQL Server's Extended Events, so "actual" here would realistically mean: total actual row counts and I/O from monitoring tables overlaid on the same static plan tree, not a full actual-plan replay). This should be scoped honestly as an approximation, not a 1:1 port of the mssql feature.
4. Wire up two new commands mirroring mssql's, e.g. `firebird.showEstimatedPlan` (calls `getQueryPlan()` without running the query) and `firebird.toggleActualPlan` (runs the query, then overlays monitoring stats), both surfaced as result-view tab options alongside the existing Results/Messages tabs (`src/result-view/`).

## Technical notes

- The native-driver requirement matters here: without it, there's no real machine-readable plan to parse (the pure-JS fallback is explicitly a heuristic string, not real Firebird plan syntax) — the visualizer should detect this and show a clear "install/enable the native driver for graphical plans" prompt rather than trying to parse the fallback text.
- Keep the plan parser and the rendering layer separate (parser is pure/testable; the webview is presentation-only) — matches this repo's stated convention of isolating SQL-parsing logic into pure functions.

## Suggested phases

1. Write `plan-parser.ts` + unit tests against real Firebird plan strings (collect samples from `NATURAL`, single index, and multi-table join plans).
2. Static diagram webview for the *estimated* plan only (no monitoring overlay yet).
3. Add the actual-plan monitoring overlay using `MON$STATEMENTS`/`MON$RECORD_STATS`.
4. Add commands + result-view tab integration.
