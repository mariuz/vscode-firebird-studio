# Connection Lost Indicator

**Inspired by**: [vscode-pgsql](https://github.com/microsoft/vscode-pgsql) (1.15.0) — "UI elements in Object Explorer and Query Editor will indicate when an active connection is lost," rather than only surfacing a dropped connection the next time a query happens to fail against it.

## Current state in Firebird Studio

**Not started.** Today, a connection dropping mid-session (server restart, network blip, idle timeout) has no dedicated UI signal anywhere — `Global`'s status bar item (`src/shared/global.ts`) shows whatever the active connection *was* set to, unconditionally, with no live health check; the tree (`FirebirdTreeDataProvider`) doesn't re-verify a connection is still reachable between expansions; and the *only* way a user currently learns a connection dropped is the next query against it failing with a raw driver error message. `firebird.enableConnectionPooling` (`src/shared/connection-pool.ts`) already tracks per-connection pooled sockets and their lifecycle, but that's an internal reuse optimization, not a user-facing health signal.

## Proposed feature

- A lightweight periodic health check for the *active* connection only (not every saved connection — pinging every saved connection continuously would be wasteful and is closer to what the Live Profiler's own polling already does for a connection you've deliberately opened that view for) — e.g. a cheap `SELECT 1 FROM RDB$DATABASE` on an interval, or better: react to an actual query failure that looks like a dropped-connection error (`node-firebird`'s connection-reset/ECONNRESET-style errors) rather than adding a new polling cycle at all, since Firebird Studio already runs queries against the active connection constantly during normal use — the same distinction `PooledClient`'s own idle-timeout logic likely already has to make between "genuinely gone" and "just idle."
- Status bar item (`Global.updateStatusBarItems()`) gains a distinct visual state — a warning-colored background/icon (`$(warning)` or `$(debug-disconnect)`) — when the active connection is known to be down, versus its normal state.
- A tree-node-level indicator (a warning badge/`description` suffix on the affected `NodeDatabase`/`NodeHost` item) for a *saved* connection specifically known to be unreachable — likely only meaningfully knowable for whichever connection is currently active, or one the user just tried to expand and got a connection error from (record that outcome against the node rather than a fresh live check).
- A one-click "Reconnect" action from either surface, reusing the same connect path `NodeDatabase.setActive()` already uses.

## Suggested phases

1. Detect a dropped active connection from a real query failure (pattern-match `node-firebird`'s connection-reset error shape) rather than adding new polling — the cheapest, lowest-risk starting slice.
2. Status bar visual state change + "Reconnect" action once a drop is detected.
3. Tree-node indicator for a database node that failed to expand due to a connection error, cleared on a successful subsequent expand.
