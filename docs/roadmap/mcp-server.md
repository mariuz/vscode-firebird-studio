# MCP Server for Firebird

**Inspired by**: [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql)'s MCP server registration ("exposes PostgreSQL tools, including connection management, schema exploration, query execution, and query plan visualization, to supported AI-enabled hosts").

## Current state in Firebird Studio

**Phase 1 (API validation) and Phase 2 (`list_connections` + `get_schema`, read-only) are done.**

Before writing any registration code, the API surface described below (written when this was purely directional) was validated against the actual installed `@types/vscode` (1.125.0 — notably newer than this extension's `engines.vscode: ^1.93.0` floor) and against VS Code's own MCP developer guide:

- **The registration model is not "handle MCP calls in-process."** `vscode.lm.registerMcpServerDefinitionProvider(id, provider)` only tells VS Code *where* an MCP server lives — `provider.provideMcpServerDefinitions()` returns `McpStdioServerDefinition`s (a command + args + env to spawn), and VS Code's own built-in MCP client spawns that as a **separate child process** and speaks MCP-over-stdio to it directly. The extension host is not on the request path once the process is running.
- This means the MCP tool implementations can't reuse `Driver`/`NodeClient`/`CredentialStore` at all — all three depend on the `vscode` module (`workspace`, `window`, `ExtensionContext.secrets`), which doesn't exist in a plain spawned Node process.
- A matching static declaration is required in `package.json`'s new `contributes.mcpServerDefinitionProviders` (`[{ "id": "firebird-mcp", "label": "Firebird MCP Server" }]`) alongside the runtime `registerMcpServerDefinitionProvider("firebird-mcp", ...)` call — registering only at runtime, without the matching package.json entry, fails.
- Guarded the same way `src/copilot/copilot-chat-participant.ts` guards `vscode.chat`: `src/mcp-server/index.ts#registerMcpServer()` checks `typeof vscode.lm !== 'undefined'` and `typeof vscode.lm.registerMcpServerDefinitionProvider === 'function'` at runtime before registering anything, so the extension still activates cleanly on a VS Code build without MCP support — no `engines.vscode` bump needed.

### What's implemented

- **`src/mcp-server/server.ts`** — the actual spawned subprocess (bundled to `out/mcp-server/server.js` via its own esbuild invocation, `npm run esbuild-mcp-server`, distinct from the main `extension.js` bundle since this runs as its own process). Built with `@modelcontextprotocol/sdk` (a new dependency — hand-rolling MCP's JSON-RPC framing/capability negotiation from scratch would be a poor trade next to a well-maintained official SDK, unlike the CSV parser or markdown-table renderer elsewhere in this codebase, which were small enough to reasonably hand-roll) and `zod` for tool input schemas (already a transitive dependency of the SDK; declared directly since `server.ts` imports it itself). Registers exactly two tools:
  - `list_connections` — returns `{id, label, host, database}` for every connection the user explicitly exposed (never a password).
  - `get_schema(connectionId)` — connects via plain `node-firebird` (this subprocess doesn't bundle the native driver, so **embedded connections aren't supported here** — the same guard `NodeClient.createConnection()` already has), runs `getSchemaColumnsQuery()`/`getForeignKeysQuery()` (reused directly — genuinely dependency-free, as advertised), and returns `buildSchemaGraph()`'s result as JSON.
  - **Critical implementation detail**: stdout is the MCP JSON-RPC stream itself — every log line in `server.ts` goes to `console.error` (stderr), never `console.log`, or it corrupts the protocol stream.
- **`src/mcp-server/index.ts`** (extension-host side) — `registerMcpServer(context)`, wired into `extension.ts#activate()`. `provideMcpServerDefinitions()` returns `[]` outright unless `firebird.mcp.enabled` is on (no separate "unregister the provider" path needed — an empty definition list is the idiomatic way to say "nothing available right now"). `resolveMcpServerDefinition()` is where credentials are actually resolved — per the API's own contract, "the extension may take actions requiring user interaction/authentication" specifically at this step — reading exposed connections from `context.globalState`, resolving each one's password via `CredentialStore.getPassword()`, and setting the spawned process's `env.FIREBIRD_MCP_CONNECTIONS` to a JSON array of `{id, label, host, port, database, user, password, role, embedded}` for **only the connections that opted in**.
- **Per-connection opt-in, not a blanket allowlist setting**: a new `ConnectionOptions.mcpExposed?: boolean`, toggled via **Toggle MCP Server Exposure** on a database's right-click menu (`NodeDatabase.toggleMcpExposure()`), guarded against workspace-sourced connections the same way `setConnectionColor()`/`setConnectionGroup()` already are. `list_connections`/`get_schema` only ever see connections with this explicitly set — turning `firebird.mcp.enabled` on exposes nothing by itself.
- **Credentials via env var, not argv or disk** — the same pattern `src/shared/isql-terminal.ts` already uses for a spawned local process (`ISC_PASSWORD` as an env var, not a visible command-line argument), applied here for consistency with an already-accepted precedent in this codebase, not a new security posture invented for this feature.

The pre-existing state this builds on: none — this was a genuinely new capability, worth distinguishing clearly from two things it's adjacent to but not the same as:

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

This is the most consequential item on this whole roadmap from a trust standpoint: unlike the chat participant (which only ever runs inside this user's own VS Code, gated by whatever confirmation UI a command already shows), an MCP server is designed to be called by *external* processes — a different application entirely, potentially running with less human-in-the-loop oversight than a chat panel provides.

1. **Which connections are exposed at all** — ✅ resolved: `ConnectionOptions.mcpExposed`, an explicit per-connection opt-in via **Toggle MCP Server Exposure**. No saved connection is exposed by default, even with `firebird.mcp.enabled` on.
2. **Read vs. write** — not yet applicable: `run_query` (the tool this point is actually about) isn't implemented yet (see "Explicitly deferred" below). The two tools that *are* implemented (`list_connections`, `get_schema`) only ever run fixed, hard-coded read-only metadata queries — there's no arbitrary-SQL surface for this point to guard yet.
3. **Credentials never cross the MCP boundary** — ✅ resolved, though "cross the MCP boundary" needed a more precise definition once the real architecture was understood: the MCP *client* (Claude Desktop, Cursor, VS Code's own Copilot Agent mode, ...) never sees a password — `get_schema`'s response is schema JSON only. But the resolved password *does* reach the spawned `server.ts` subprocess (via `env.FIREBIRD_MCP_CONNECTIONS`), because that subprocess is what actually opens the Firebird connection — there is no extension-host-side `Driver`/`CredentialStore` call it can make instead, since it isn't part of the extension host (see "Current state" above). This is the same exposure model `isql-terminal.ts` already accepts for a spawned local process (env var, not argv/disk), scoped further here by only ever including connections that opted in.

## Technical notes

- ~~VS Code's MCP registration API is newer than everything else this codebase integrates with...~~ — validated: `vscode.lm.registerMcpServerDefinitionProvider`, confirmed against `@types/vscode` 1.125.0 and guarded the same way `vscode.chat` already is. See "Current state" above for what this actually required once confirmed (a separate spawned process, not in-process tool handlers).
- The tool *implementations* are thin wrappers around existing pure functions (`getSchemaColumnsQuery`, `getForeignKeysQuery`, `buildSchemaGraph`) — but **not** around `Driver.runQuery`/`runBatch`/`getQueryPlan` as originally proposed below, since those depend on `vscode` and can't run in the spawned subprocess at all. `get_schema` re-implements a minimal, direct `node-firebird` connect+query instead.
- Settings namespace: `firebird.mcp.enabled` (boolean, default `false`) exists; a write-access flag isn't needed yet since `run_query` isn't implemented.

## Suggested phases

1. ~~Validate the current VS Code MCP registration API and what a minimal "hello world" tool registration looks like, independent of Firebird specifics.~~ — **done**.
2. ~~`list_connections` + `get_schema` (read-only, no query execution risk) — the safe, immediately useful slice.~~ — **done**.
3. `run_query` in read-only mode only (reject/refuse anything but `SELECT`), with the per-connection opt-in setting.
4. `get_query_plan`.
5. (Only with clear demand, and only after the security model above is settled) an opt-in write-query path.

### Explicitly deferred (not done)

- **`run_query`/`get_query_plan`** (phases 3-4): no query-execution tool of any kind exists yet — only metadata inspection (`list_connections`, `get_schema`). This is the biggest remaining gap and, per the security model above, the one that needs the most care before it's added.
- **Embedded connections**: `get_schema` only supports network connections — the spawned subprocess doesn't bundle the native driver embedded connections require (kept the subprocess bundle lean; this could be revisited if there's demand).
- **Live refresh mid-session**: `onDidChangeMcpServerDefinitions` fires when `firebird.mcp.*` settings change, but not when a connection's `mcpExposed` flag is toggled from the tree — an already-running MCP client session may need a restart to pick up a newly-exposed connection.
- **Automated tests**: no unit tests were added for `server.ts`/`index.ts` themselves (VS Code MCP API + subprocess spawning + stdio transport orchestration — hard to meaningfully unit-test, consistent with this repo's existing boundary for similar orchestration-heavy modules like `container-provisioning/index.ts`). The pure functions it reuses (`buildSchemaGraph`, the schema queries) already have their own coverage from before this feature existed.
