# Live Connection / Query Profiler

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Query Profiler ("real-time database activity monitoring with Extended Events") and [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql)'s Server Dashboard (verified against its demo media, not just its docs: a full-tab dashboard of live line charts grouped into named sections, a time-range selector, and separate Queries/Waits/Sessions drill-down tabs — a richer target shape than a plain polling table).

## Current state in Firebird Studio

**Phases 1 and 2 are done.** `src/profiler/` (`ProfilerView`) replaces the one-shot `MON$ATTACHMENTS` snapshot `NodeDatabase#monitorDatabase()` used to run (`monitorConnectionsQuery` is gone from `queries.ts` — superseded, not kept alongside) with a continuously polling activity table:

- `profilerActivityQuery()` (`src/shared/queries.ts`) — one row per connection (attachment-level, excluding the profiler's own dedicated connection and internal engine attachments), with cumulative page/record I-O counters and, if there is one, the most recently started active statement and transaction. **Verified directly against a real Firebird 3.0 server** (a scratch database, via `isql-fb`) before being written, the same way `plan-parser.ts`'s grammar was — see the query's doc comment for exactly what was checked (in particular, `MON$STAT_GROUP = 1` to select the attachment-level stat row for a given `MON$STAT_ID`, and picking the highest active `MON$STATEMENT_ID`/`MON$TRANSACTION_ID` per attachment rather than every combination, to keep the grain at one row per connection).
- `ProfilerView` uses its **own dedicated connection** (created lazily on first poll, reused across polls, closed on dispose) rather than going through `Driver.runQuery()`'s per-call connect/detach, so repeated polling doesn't pay a fresh-connection cost every few seconds and never contends with the user's own query execution or the connection pool.
- **Polling lives entirely in the webview** (a plain `setInterval` posting `refresh`), not the extension — this webview, like every other one in this extension, is created with `retainContextWhenHidden: false`, so VS Code tears down its script the moment the panel is hidden and re-runs it from scratch when shown again. That already gives "stop polling when not visible, resume when shown" for free, with zero extra lifecycle code (`onDidChangeViewState` etc.) needed.
- **Delta/rate computation is also webview-side**: cumulative counters (page reads/writes/fetches, sequential/indexed record reads) are diffed against the previous poll's snapshot for that connection to show a rate (reads/sec, etc.), with a small defensive rule — a counter that goes *backwards* between polls (the attachment id was reused by a different, newer connection) shows "no data yet" rather than a nonsensical negative rate.
- New `firebird.profiler.pollIntervalMs` setting (default 3000ms) controls the polling interval.
- `firebird.database.monitorDatabase` (right-click a database → **Monitor Database**) — same command id, title, and menu placement as before — now opens this webview instead of running the old one-shot query into the regular results grid, the same repointing approach already used for the Schema Designer's three commands.

### Explicitly deferred (not done)

- **Phase 3 — Filter/pin and kill/rollback**: no per-user filtering and no "force detach" action (`DELETE FROM MON$ATTACHMENTS ...`) yet. (A `killAttachmentQuery()` helper was drafted and then deliberately removed before committing — no UI called it yet, and this repo's convention is not to carry unused code "for later.")
- **Phase 4 — Charted dashboard**: still a plain table, not the live line-chart view (grouped sections, time-range selector) vscode-pgsql's dashboard uses. The metrics this phase would chart (connections, cache hit ratio, block I/O) are exactly the ones already polled — charting is presentation on top of data this phase already fetches, not new data access.
- **Phase 5 — Sessions/blocking view**: no dedicated blocking-tree view; `MON$TRANSACTIONS`' state is available in the query but not yet surfaced distinctly from the main activity row.

### Testing

`src/test/queries.test.ts` covers `profilerActivityQuery()`'s SQL shape (the `CURRENT_CONNECTION` exclusion, the `MON$REMOTE_ADDRESS IS NOT NULL` filter, the `MON$STAT_GROUP = 1` scoping, the UTF8 statement-text cast, and the "most recent active" subqueries). The webview's inline JS (`src/profiler/htmlContent/js/app.js`) has no automated coverage, matching this repo's convention for webview inline JS — verified instead with a one-off Node harness (not committed) exercising two consecutive simulated polls with a controlled elapsed time, confirming: no rate on the first poll (nothing to diff against), a correct rate computed on the second poll, and stale-connection pruning when a connection disappears between polls.

## Technical notes

- Reused the existing dedicated-connection pattern already established for user-management actions that "bypass the extension's normal query-execution path" (per the 0.1.19 changelog entry), rather than inventing a new one.
- No charting library is vendored in this extension — if/when phase 4 is picked up, a hand-rolled SVG line chart (a handful of `<path>` elements against fixed axes) matches how `src/schema-designer/`'s canvas and `src/query-plan-view/`'s diagram both already avoid a charting dependency.
- If you need to re-verify or extend `profilerActivityQuery()`, a Firebird 3.0 server is reachable in this environment via `isql-fb` — the query's doc comment documents the scratch-database setup used to validate it.

## Suggested phases (remaining)

1. ~~Static "Activity Snapshot" query, richer than the old one-shot `MON$ATTACHMENTS` query.~~ — **done** (`profilerActivityQuery()`).
2. ~~Interval-based polling + delta-stat computation.~~ — **done**.
3. Add filter/pin and the kill/rollback action.
4. Add the charted dashboard view (line charts + time-range selector) over the same polled data, plus a Queries drill-down ranking statements by a chosen metric.
5. (Stretch, scoped down per the original note here) a Sessions/blocking view.
