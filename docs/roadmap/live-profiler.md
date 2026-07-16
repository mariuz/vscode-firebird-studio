# Live Connection / Query Profiler

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Query Profiler ("real-time database activity monitoring with Extended Events") and [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql)'s Server Dashboard (verified against its demo media, not just its docs: a full-tab dashboard of live line charts grouped into named sections, a time-range selector, and separate Queries/Waits/Sessions drill-down tabs — a richer target shape than a plain polling table).

## Current state in Firebird Studio

**Phases 1 through 4 are done.** `src/profiler/` (`ProfilerView`) replaces the one-shot `MON$ATTACHMENTS` snapshot `NodeDatabase#monitorDatabase()` used to run (`monitorConnectionsQuery` is gone from `queries.ts` — superseded, not kept alongside) with a continuously polling activity table:

- `profilerActivityQuery()` (`src/shared/queries.ts`) — one row per connection (attachment-level, excluding the profiler's own dedicated connection and internal engine attachments), with cumulative page/record I-O counters and, if there is one, the most recently started active statement and transaction. **Verified directly against a real Firebird 3.0 server** (a scratch database, via `isql-fb`) before being written, the same way `plan-parser.ts`'s grammar was — see the query's doc comment for exactly what was checked (in particular, `MON$STAT_GROUP = 1` to select the attachment-level stat row for a given `MON$STAT_ID`, and picking the highest active `MON$STATEMENT_ID`/`MON$TRANSACTION_ID` per attachment rather than every combination, to keep the grain at one row per connection).
- `ProfilerView` uses its **own dedicated connection** (created lazily on first poll, reused across polls, closed on dispose) rather than going through `Driver.runQuery()`'s per-call connect/detach, so repeated polling doesn't pay a fresh-connection cost every few seconds and never contends with the user's own query execution or the connection pool.
- **Polling lives entirely in the webview** (a plain `setInterval` posting `refresh`), not the extension — this webview, like every other one in this extension, is created with `retainContextWhenHidden: false`, so VS Code tears down its script the moment the panel is hidden and re-runs it from scratch when shown again. That already gives "stop polling when not visible, resume when shown" for free, with zero extra lifecycle code (`onDidChangeViewState` etc.) needed.
- **Delta/rate computation is also webview-side**: cumulative counters (page reads/writes/fetches, sequential/indexed record reads) are diffed against the previous poll's snapshot for that connection to show a rate (reads/sec, etc.), with a small defensive rule — a counter that goes *backwards* between polls (the attachment id was reused by a different, newer connection) shows "no data yet" rather than a nonsensical negative rate.
- New `firebird.profiler.pollIntervalMs` setting (default 3000ms) controls the polling interval.
- `firebird.database.monitorDatabase` (right-click a database → **Monitor Database**) — same command id, title, and menu placement as before — now opens this webview instead of running the old one-shot query into the regular results grid, the same repointing approach already used for the Schema Designer's three commands.

### Phase 3 — Filter/pin and kill/rollback

- **Filter**: a toolbar text box (`#filter` in `index.html`) matches against user/remote address/state/statement text, entirely webview-side (`matchesFilter()` in `app.js`) — no extra polling or round-trip needed to re-filter as the user types.
- **Pin**: a per-row star button toggles membership in a webview-local `pinned` Set (by `ATTACHMENT_ID`); pinned rows sort first within whatever the current filter shows. Pins are intentionally not persisted across a panel reopen/reload — `retainContextWhenHidden: false` already discards all webview-side state when hidden (see above), and a live monitoring session's pins are a working-session concern, not something worth a `globalState` entry.
- **Kill / Rollback**: a "Kill" button on every row and a "Rollback" button on rows with an active transaction (`row.TRANSACTION_ID != null`) post `killAttachment`/`rollbackTransaction` messages to the extension host. `ProfilerView.runAdminAction()` (`src/profiler/index.ts`) is the shared confirm-then-execute path: a modal `vscode.window.showWarningMessage()` (naming the user/address being affected) gates the action — the webview itself never confirms, matching this repo's convention that a webview posts an intent and the extension host owns any destructive confirmation. On confirm, it runs `killAttachmentQuery(attachmentId)` / `rollbackTransactionQuery(transactionId)` (new in `src/shared/queries.ts` — `DELETE FROM MON$ATTACHMENTS`/`MON$TRANSACTIONS`, Firebird's documented mechanism for forced detach/rollback, each guarding its numeric id with `Number.isInteger()` before interpolating) over the profiler's existing dedicated connection, then triggers an immediate re-poll. (The `killAttachmentQuery()` helper mentioned as "drafted and removed" in an earlier revision of this doc is now implemented for real, with a caller.)
- **Verified against a live server**: a standalone script opened a "victim" connection, force-detached it via the same `DELETE FROM MON$ATTACHMENTS` statement `killAttachmentQuery()` builds, and confirmed the victim's next query was rejected ("Connection shutdown, Killed by database administrator.") and it no longer appeared in `MON$ATTACHMENTS`; separately, started a transaction, rolled it back via the same `DELETE FROM MON$TRANSACTIONS` statement, and confirmed it no longer appeared in `MON$TRANSACTIONS`.

### Phase 4 — Charted dashboard and Queries drill-down

- **View mode switcher**: a `Table` / `Dashboard` / `Queries` button group in the toolbar (`.view-mode-btn`, `viewMode` in `app.js`) toggles which of three sibling panels under `#main` is visible; switching views never re-polls, it just re-renders from state (`lastRendered`/`history`) already held in memory.
- **Dashboard**: three chart cards — Connections, Cache Hit % (approximate: `(fetches − physical page reads) / fetches`, aggregated across all connections since the last poll), and Page I/O (reads/writes per sec, two series on one chart) — each a hand-rolled inline SVG polyline (`buildSparklineSvg()`), no charting library. A time-range selector (1 min / 5 min / 15 min / All) filters a webview-local `history` array — one aggregate sample recorded per poll (`recordHistorySample()`), capped at `MAX_HISTORY` (600 samples) so a long-running panel doesn't grow it unboundedly. Like pins (phase 3), history is session-local and not persisted — `retainContextWhenHidden: false` discards it on hide, matching this webview's existing state-lifetime convention.
- **Queries drill-down**: ranks the *current* poll's active, rated connections by a chosen metric (Reads/Writes/Fetches/Seq/Idx per sec, via a `<select>`) — no new polling, just a different sort/view over the same `lastRendered` the activity table already computes.
- **Verification**: no automated coverage for the same reason as the rest of the webview's inline JS (see Testing below); manually exercised by running the extension against a live server, switching between all three view modes while a workload was active, and confirming the dashboard's charts and the queries ranking updated each poll and the time-range buttons re-filtered the existing history without a re-poll.

### Phase 5 — Sessions/blocking view (not done)

No dedicated blocking-tree view; `MON$TRANSACTIONS`' state is available in the query but not yet surfaced distinctly from the main activity row.

### Testing

`src/test/queries.test.ts` covers `profilerActivityQuery()`'s SQL shape (the `CURRENT_CONNECTION` exclusion, the `MON$REMOTE_ADDRESS IS NOT NULL` filter, the `MON$STAT_GROUP = 1` scoping, the UTF8 statement-text cast, and the "most recent active" subqueries) and now also `killAttachmentQuery()`/`rollbackTransactionQuery()`'s exact SQL shape and their rejection of a non-integer id. The webview's inline JS (`src/profiler/htmlContent/js/app.js`) has no automated coverage, matching this repo's convention for webview inline JS — verified instead with one-off Node harnesses (not committed): one exercising two consecutive simulated polls with a controlled elapsed time (no rate on the first poll, a correct rate on the second, stale-connection pruning when a connection disappears between polls), and a second driving the real built kill/rollback SQL against a live server (see above).

## Technical notes

- Reused the existing dedicated-connection pattern already established for user-management actions that "bypass the extension's normal query-execution path" (per the 0.1.19 changelog entry), rather than inventing a new one.
- No charting library is vendored in this extension — phase 4's dashboard charts are hand-rolled inline SVG polylines (`buildSparklineSvg()` in `app.js`), matching how `src/schema-designer/`'s canvas and `src/query-plan-view/`'s diagram both already avoid a charting dependency.
- If you need to re-verify or extend `profilerActivityQuery()`, a Firebird 3.0 server is reachable in this environment via `isql-fb` — the query's doc comment documents the scratch-database setup used to validate it.

## Suggested phases (remaining)

1. ~~Static "Activity Snapshot" query, richer than the old one-shot `MON$ATTACHMENTS` query.~~ — **done** (`profilerActivityQuery()`).
2. ~~Interval-based polling + delta-stat computation.~~ — **done**.
3. ~~Add filter/pin and the kill/rollback action.~~ — **done**.
4. ~~Add the charted dashboard view (line charts + time-range selector) over the same polled data, plus a Queries drill-down ranking statements by a chosen metric.~~ — **done**.
5. (Stretch, scoped down per the original note here) a Sessions/blocking view.
