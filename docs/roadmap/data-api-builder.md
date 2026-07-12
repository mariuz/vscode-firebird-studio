# Data API Builder for Firebird

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Data API builder integration ("Create REST, GraphQL, and MCP endpoints for SQL databases", plus a Copilot-assisted config generator).

## Current state in Firebird Studio

**Phase 2 (Option A) is done**, despite this item's "speculative — validate demand first" flag (explicitly overridden — see Phase 1 below). Right-click a database → **Generate Data API Spec...** produces an OpenAPI 3.0 document (one CRUD route set per table) and opens it as plain JSON for review:

- `src/data-api-builder/openapi-spec.ts` (`buildOpenApiSpec()`) — a pure function (no vscode/Driver dependency, unit-tested like `schema-graph.ts`) that turns a `SchemaGraph` (the same model the Schema Designer/schema-diff already assemble from `getSchemaColumnsQuery()`) into an OpenAPI document: a component schema per table (JSON Schema types mapped from Firebird's own `RDB$FIELD_TYPE` names), a list+create (`GET`/`POST /table`) path per table, and a get/update/delete-by-primary-key path (`GET`/`PUT`/`DELETE /table/{pk...}`) per table that has one — composite keys get one path segment per PK column. Tables with no primary key only get the list+create routes.
- `src/data-api-builder/index.ts` (`runDataApiSpecGenerator()`) — fetches the schema via the same `getSchemaColumnsQuery()` + `getForeignKeysQuery()` combined `Driver.runBatch()` call the Schema Designer uses, builds the spec, and opens it via `workspace.openTextDocument()` — plain, inspectable JSON, never executed or sent anywhere by the extension itself, per the design doc's explicit direction.
- **JSON, not YAML**: OpenAPI supports both equally; JSON avoids adding a YAML-serialization dependency (none is vendored in this extension today), consistent with this repo's stated preference.
- Wired to `firebird.database.generateDataApiSpec` (same command/menu-registration pattern as the other database-node actions) → `NodeDatabase.generateDataApiSpec()`.

The pre-existing state this replaces: none — this was a net-new capability, not an extension of an existing module. Microsoft's vscode-mssql version wraps their standalone [Data API builder](https://github.com/Azure/data-api-builder) tool (a .NET config-driven REST/GraphQL/MCP server) with a VS Code UI for authoring its config; there's no Firebird equivalent tool to wrap, which is exactly why Option A (spec generation only, no bundled server) was chosen.

### Explicitly deferred (not done)

- **Phase 3 — Copilot-assisted natural-language config generation**: no slash command/button takes a description like "expose customers and orders as read-only" and adjusts the generated spec; every table gets the same full CRUD route set today.
- **Phase 4 — Option B (bundled server runtime)**: no scaffolded Node/Express/GraphQL project — this remains "generate a spec for your own backend," not "run a Firebird API server," per the design doc's recommendation not to start Option B casually.
- Foreign keys are fetched (reused from the Schema Designer's query) but not yet reflected in the generated spec (e.g. as OpenAPI relationship/links or nested-resource routes) — the FK rows are currently discarded after building the graph.

## Proposed feature

Given there's no existing "Data API builder for Firebird" server to integrate with, this feature has two viable shapes — worth deciding explicitly before building either:

**Option A — config generator only.** The extension inspects the connected schema (same metadata the tree provider and schema-diff already read) and generates a config file for an existing generic API-generation tool the user runs themselves (e.g. PostgREST-style tools don't support Firebird directly, but a hand-rolled minimal REST layer could). This keeps the extension's scope to "generate config," matching mssql's actual division of labor (VS Code extension authors config; a separate service executes it).

**Option B — bundled lightweight server.** The extension scaffolds and can launch a small Node/Express (or Fastify) REST API project that uses the same `node-firebird`/native driver already vendored in this extension, with one CRUD route set per table/view generated from schema metadata, plus a minimal GraphQL layer (e.g. via `graphql` + a resolver generated per table). This is a much bigger undertaking — effectively shipping and maintaining a second, standalone piece of software — and should not be started casually.

Given the effort gap, **recommend starting with Option A**, scoped down further to: generate an OpenAPI/REST route spec (paths, request/response shapes per table's columns and PK) as a reviewable artifact the user can hand to their own backend, without the extension running a server itself. Revisit Option B only if there's clear user demand for a bundled runtime.

## Copilot integration

Whichever option is chosen, a natural Copilot hook (mirroring "GitHub Copilot in Data API builder") is a slash command or button that takes a natural-language description ("expose customers and orders as read-only, orders filterable by customer_id") and the current schema context (`schema-context.ts`'s existing serialization) and produces the generated config/spec — same `request.model.sendRequest()` pattern as the rest of `src/copilot/`.

## Technical notes

- This is the least-grounded item on this list relative to the existing codebase — no current module to extend, and the underlying tool-to-wrap doesn't exist for Firebird the way it does for SQL Server. Treat the estimate here as rougher than the others, and validate demand before investing.
- If pursued, keep the generated artifact (config/spec file) as plain, inspectable text opened via `Driver.createSQLTextDocument()`-style `workspace.openTextDocument()`, not something silently executed — consistent with this extension's existing pattern of always showing generated SQL/DDL for review before running it.

## Suggested phases

1. ~~Validate scope/demand (this is speculative enough that it may not be worth building without concrete user requests).~~ — explicitly overridden: asked directly whether to build this or skip to the next roadmap item, given the speculative flag; the answer was to build it anyway.
2. ~~REST route-spec generator (Option A) from schema metadata, no server.~~ — **done**.
3. Copilot-assisted natural-language config generation.
4. (Only if justified) bundled minimal server runtime (Option B).
