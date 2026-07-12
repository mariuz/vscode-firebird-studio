# Data API Builder for Firebird

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Data API builder integration ("Create REST, GraphQL, and MCP endpoints for SQL databases", plus a Copilot-assisted config generator).

## Current state in Firebird Studio

None — this is a net-new capability, not an extension of an existing module. Microsoft's version wraps their standalone [Data API builder](https://github.com/Azure/data-api-builder) tool (a .NET config-driven REST/GraphQL/MCP server) with a VS Code UI for authoring its config; there's no Firebird equivalent tool to wrap.

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

1. Validate scope/demand (this is speculative enough that it may not be worth building without concrete user requests).
2. REST route-spec generator (Option A) from schema metadata, no server.
3. Copilot-assisted natural-language config generation.
4. (Only if justified) bundled minimal server runtime (Option B).
