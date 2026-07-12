# MCP Server for Firebird

**Inspired by**: [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql)'s MCP server registration ("exposes PostgreSQL tools, including connection management, schema exploration, query execution, and query plan visualization, to supported AI-enabled hosts").

## Current state in Firebird Studio

None, and this is a genuinely different capability from anything already planned — worth distinguishing clearly from two things it's adjacent to but not the same as:

- **`src/copilot/copilot-chat-participant.ts`** (the `@firebird` chat participant, `/query`/`/optimize`/`/explain`/`/designSchema`) is scoped to *this extension's own* integration with VS Code's built-in Copilot Chat UI. It's not reachable by any other AI tool.
- **[`docs/roadmap/data-api-builder.md`](data-api-builder.md)** is about exposing a connected database's *data* (tables/views as CRUD endpoints) to *application developers* building software against it.
- **This feature** is about exposing this extension's own *database tooling* — connect, explore schema, run a query, get a plan — as callable tools to *any* MCP-compatible AI client or agent (Claude Desktop, Cursor, a custom agent script, VS Code's own Copilot in Agent mode), independent of whether that client is even running inside VS Code. Confirmed via vscode-pgsql's demo media: its Agent mode literally shows a tool-call line ("Visualizing schema for connection '...'") with a checkmark on completion — the AI agent is invoking the extension's own capabilities as MCP tools, not just chatting about SQL.

## Proposed feature

An MCP server, registered by this extension, exposing tools such as:

- `list_connections` — the saved connections currently known to the extension (name/host/database, never credentials).
- `get_schema(connectionId)` — serializes the connected database's schema, reusing `buildSchemaGraph()`/`schema-context.ts`'s existing serialization rather than inventing a second schema format.
- `run_query(connectionId, sql)` — executes via `Driver.runQuery()`/`runBatch()`, the same path every other feature in this extension already goes through (so it inherits query history logging, password resolution, etc. for free).
- `get_query_plan(connectionId, sql)` — wraps `Driver.getQueryPlan()`.

## Security model — the part to get right before anything else

This is the most consequential item on this whole roadmap from a trust standpoint: unlike the chat participant (which only ever runs inside this user's own VS Code, gated by whatever confirmation UI a command already shows), an MCP server is designed to be called by *external* processes — a different application entirely, potentially running with less human-in-the-loop oversight than a chat panel provides. Before writing any tool-registration code, resolve:

1. **Which connections are exposed at all** — likely only ones the user has explicitly opted in per-connection (a new flag on `ConnectionOptions`, or a separate allowlist in settings), not every saved connection by default. Opening every credential-attached connection to any MCP client that can reach this VS Code instance is not an acceptable default.
2. **Read vs. write** — `run_query` executing arbitrary SQL from an external agent is the highest-risk tool here. A `firebird.mcp.allowWriteQueries` (default `false`) style setting, with destructive statements (`DROP`/`DELETE`/`UPDATE` without a `WHERE`, etc.) rejected or requiring an explicit user-facing confirmation prompt even when enabled, mirrors this extension's existing pattern of never silently running DDL (every DDL-producing feature here opens generated SQL for review first — an MCP tool that executes immediately, with no human review step, is a real departure from that pattern and should be treated as such).
3. **Credentials never cross the MCP boundary** — the server-side tool implementation resolves passwords via `CredentialStore` internally (same as every other feature); the MCP client only ever sees a connection *name*, never a connection string or password.

## Technical notes

- **VS Code's MCP registration API is newer than everything else this codebase integrates with** (`vscode.chat`'s chat-participant API, which the Copilot participant already guards with a runtime `typeof vscode.chat !== 'undefined'` check, is the closest precedent) — confirm the exact current contribution point/API shape against the VS Code version this extension targets before designing further; treat the API surface described here as directional, not final, until validated against `@types/vscode` at implementation time.
- Whatever the registration mechanism turns out to be, the tool *implementations* should be thin wrappers around existing pure/`Driver`-level functions (`buildSchemaGraph`, `Driver.runQuery`/`runBatch`, `Driver.getQueryPlan`) — this is glue code exposing capabilities that already exist, not a new query/schema engine.
- Needs its own settings namespace (`firebird.mcp.*`) for the enable flag, the write-access flag, and the per-connection opt-in, following `src/config/`'s existing `getOptions()` pattern.

## Suggested phases

1. Validate the current VS Code MCP registration API and what a minimal "hello world" tool registration looks like, independent of Firebird specifics.
2. `list_connections` + `get_schema` (read-only, no query execution risk) — the safe, immediately useful slice.
3. `run_query` in read-only mode only (reject/refuse anything but `SELECT`), with the per-connection opt-in setting.
4. `get_query_plan`.
5. (Only with clear demand, and only after the security model above is settled) an opt-in write-query path.
