# Live Connection / Query Profiler

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Query Profiler ("real-time database activity monitoring with Extended Events") and [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql)'s Server Dashboard (verified against its demo media, not just its docs: a full-tab dashboard of live line charts grouped into named sections, a time-range selector, and separate Queries/Waits/Sessions drill-down tabs — a richer target shape than a plain polling table).

## Current state in Firebird Studio

`monitorConnectionsQuery` (`src/shared/queries.ts:478`) queries `MON$ATTACHMENTS` for a **single snapshot** of current connections — there's no auto-refresh, no history, and no per-statement activity feed. ROADMAP.md already lists "Database statistics and monitoring (connection/I-O monitoring via `MON$` tables)" as done, but that's this one-shot snapshot view, not a live profiler.

Firebird has no Extended-Events equivalent, but it does expose a rich set of monitoring tables beyond `MON$ATTACHMENTS`:

- `MON$STATEMENTS` — currently executing/recently executed statements per attachment, with `MON$STATE`.
- `MON$RECORD_STATS` / `MON$IO_STATS` / `MON$MEMORY_USAGE` — per-statement/transaction/attachment counters (reads, writes, fetches, marks, memory).
- `MON$TRANSACTIONS` — open transactions, isolation level, oldest snapshot.

## Proposed feature

A new webview/panel (`src/profiler/`) that polls these tables on an interval (there's no push/subscribe API in Firebird, so this has to be poll-based — unlike SQL Server's Extended Events which streams):

1. **Activity list** — one row per active attachment/statement, refreshed every N seconds (configurable, e.g. `firebird.profiler.pollIntervalMs`), showing user, remote address, current statement text (truncated), state (idle/active), transaction isolation.
2. **Delta stats** — since Firebird's `MON$*_STATS` counters are cumulative, the profiler needs to snapshot-and-diff between polls to show *rate* (reads/sec, fetches/sec) rather than raw cumulative counters — this is the main piece of new logic, not present anywhere in the codebase today.
3. **Filter/pin** — let the user filter to their own connection's activity vs. all attachments (requires appropriate privileges — `MON$` tables restricted to SYSDBA/owner in some Firebird versions; the feature must handle a permission-denied query gracefully and say so, not crash).
4. Optional: a "kill/rollback" action per row using `DELETE FROM MON$ATTACHMENTS WHERE MON$ATTACHMENT_ID = ?` (Firebird's documented mechanism for forcing a detach), gated behind a confirmation prompt given how destructive it is.
5. **Charted dashboard, not just a table** — vscode-pgsql's dashboard renders each metric (active connections, cache hit ratio, block I/O, commits/rollbacks) as its own live-updating line chart, grouped under named section headers (Connections, Transactions, Cache, ...), with a time-range selector (1 hour/6 hours/1 day/...) above the charts. A meaningful chunk of that is genuinely Azure-Monitor-specific (server-level CPU/storage/IOPS metrics vscode-pgsql sources from the cloud provider, not the database itself — no Firebird equivalent exists, there's no hosting platform to ask) — but the metrics sourced from the database's own system views (connections, cache hit ratio, block I/O in vscode-pgsql's case) map directly onto polled `MON$*` deltas here. Scope this phase to charting exactly what's already planned above (activity/delta stats), not to inventing server-host metrics Firebird has no source for.
6. **Top-queries drill-down** — a "Queries" section/tab ranking currently-known statements by a chosen metric (execution time, call count), sourced from `MON$STATEMENTS` (+ `MON$RECORD_STATS` for read/write counts per statement), mirroring vscode-pgsql's Queries tab. This is a different cut of the same `MON$STATEMENTS` data the activity list (item 1) already surfaces — a sortable summary view rather than a live per-row feed.
7. **Sessions/blocking view** — Firebird doesn't expose a "wait event" taxonomy as rich as PostgreSQL's (no direct analog to vscode-pgsql's Waits tab), but it does expose lock/blocking information indirectly (a transaction waiting on another shows up via `MON$TRANSACTIONS`' state and Firebird's `RDB$GET_CONTEXT`-based lock inspection, or simply a query that hangs while another transaction holds a conflicting lock). A "Sessions" view listing transactions with their state and, where determinable, what they're blocked behind, is a reasonable scoped-down analog — don't try to build a full wait-event-category system that doesn't map onto Firebird's actual instrumentation.

## Technical notes

- Reuse the existing polling/interval pattern if one already exists elsewhere in the codebase (check `src/logger` or status bar refresh logic in `src/shared/global.ts` before writing a new one from scratch).
- This is a good candidate for a dedicated `Driver` connection (like the pattern already used for user-management actions that "bypass the extension's normal query-execution path" per the 0.1.19 changelog entry) so profiler polling doesn't interleave with — or get cancelled by — the user's own query execution.
- Needs a clear stop/start lifecycle tied to the panel's visibility (`onDidChangeViewState` / dispose) so it doesn't keep polling a closed connection in the background.
- No charting library is vendored in this extension today — `src/schema-designer/`'s canvas and the schema visualizer it replaced both hand-roll plain SVG rather than pulling in a charting dependency. A time-series line chart is simple enough (a handful of `<path>` elements plotting `(time, value)` points against fixed axes) to hand-roll the same way, consistent with this repo's existing preference for no new dependencies where a small amount of custom SVG code will do.

## Suggested phases

1. Static one-shot "Activity Snapshot" view (richer than today's `MON$ATTACHMENTS`-only query — add `MON$STATEMENTS` join) as a normal result grid, no polling yet.
2. Add interval-based polling + delta-stat computation.
3. Add filter/pin and the kill/rollback action.
4. Add the charted dashboard view (line charts + time-range selector) over the same polled data, plus the Queries drill-down.
5. (Stretch, scoped down per the note above) a Sessions/blocking view.
