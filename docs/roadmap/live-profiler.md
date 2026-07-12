# Live Connection / Query Profiler

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Query Profiler ("real-time database activity monitoring with Extended Events").

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

## Technical notes

- Reuse the existing polling/interval pattern if one already exists elsewhere in the codebase (check `src/logger` or status bar refresh logic in `src/shared/global.ts` before writing a new one from scratch).
- This is a good candidate for a dedicated `Driver` connection (like the pattern already used for user-management actions that "bypass the extension's normal query-execution path" per the 0.1.19 changelog entry) so profiler polling doesn't interleave with — or get cancelled by — the user's own query execution.
- Needs a clear stop/start lifecycle tied to the panel's visibility (`onDidChangeViewState` / dispose) so it doesn't keep polling a closed connection in the background.

## Suggested phases

1. Static one-shot "Activity Snapshot" view (richer than today's `MON$ATTACHMENTS`-only query — add `MON$STATEMENTS` join) as a normal result grid, no polling yet.
2. Add interval-based polling + delta-stat computation.
3. Add filter/pin and the kill/rollback action.
