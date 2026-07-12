# Roadmap

This document outlines the planned features and improvements for the **Firebird Studio for VS Code** extension, inspired by [Microsoft's IDE for PostgreSQL in VS Code](https://techcommunity.microsoft.com/blog/adforpostgresql/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4414648).

## Enhanced Object Explorer

- [x] Expand tree view to include views, stored procedures, triggers, generators/sequences, domains, exceptions, and roles
- [x] Add schema visualization — right-click a database to see a visual diagram of tables, relationships, and objects
- [x] Show column types, constraints (primary key, foreign key, not null, unique) inline in the tree view
- [x] Display system tables and metadata tables with a toggle option

## Intelligent IntelliSense Improvements

- [x] Context-aware code completion that understands the current database schema in real time
- [x] Auto-complete for stored procedure and trigger names and parameters
- [x] Syntax highlighting improvements for Firebird-specific SQL dialect (PSQL blocks, `EXECUTE BLOCK`, etc.)
- [x] Snippet support for common Firebird DDL/DML patterns (e.g., `CREATE TABLE`, `CREATE PROCEDURE`, `CREATE TRIGGER`)

## AI-Powered Enhancements

- [x] GitHub Copilot integration for Firebird SQL — contextual AI suggestions tailored to the connected database
- [x] Natural-language query generation — describe what you want in plain English, get Firebird SQL
- [x] AI-assisted query optimization and explain plan analysis
- [x] AI-assisted schema design from sample data

## Query Execution and Results

- [x] Support for executing multiple queries in a single document (batch execution)
- [x] Session query history — automatically log and recall previously executed queries
- [x] Explain and analyze query performance with `SET PLANONLY ON` / `SET PLAN ON` integration
- [x] Editable result grids — update, insert, and delete rows directly from query results
- [x] Use isql/isql-fb in an integrated terminal, connected to the active database, and run `.sql` files through it directly
- [x] Enhanced export options — export results to CSV, JSON, Excel (XLSX), and PDF

## Connection Management

- [x] Support for Firebird embedded databases
- [x] Connection profiles with saved credentials (securely stored via VS Code Secret Storage API)
- [x] Connection pooling for improved performance on repeated queries
- [x] Support for Firebird 4.x and 5.x wire protocol and authentication (SRP, ChaCha encryption)
- [x] Docker container support — connect to Firebird instances running in Docker

## Database Management

- [x] Create, alter, and drop database objects directly from the UI (tables, views, stored procedures, triggers, generators, domains)
- [x] Visual table designer for creating and modifying tables
- [x] Index management — view, create, and drop indexes
- [x] User and role management — create and manage database users and roles
- [x] Database backup and restore integration (gbak/nbackup)
- [x] Database statistics and monitoring (connection/I-O monitoring via `MON$` tables)

## Collaboration and Productivity

- [x] SQL formatting and beautification
- [x] Diff support for comparing database schemas
- [x] SQL linting and error detection before execution
- [x] Bookmarks for frequently used queries
- [x] Workspace-level database configuration (`.vscode/firebird.json`)

## Documentation and Community

- [x] Improved extension documentation and wiki
- [x] Sample databases and tutorials for getting started
- [x] Contributing guide for community contributors

## Inspired by vscode-mssql

The following features are adapted from Microsoft's [vscode-mssql](https://github.com/microsoft/vscode-mssql) extension for SQL Server, reviewed for what's applicable to Firebird. Heavier, multi-phase features link out to a dedicated design doc under [`docs/roadmap/`](docs/roadmap/); lighter ones are listed directly.

### Visual design & schema tools

- [x] Visual multi-table Schema Designer — drag-and-drop ER modeling, auto-layout, and consolidated DDL generation, replacing/merging today's read-only schema visualizer and single-table designer ([design doc](docs/roadmap/visual-schema-designer.md))
- [x] Copilot-assisted schema editing inside the Schema Designer — natural-language edits applied to an open diagram, not just one-shot DDL generation (see design doc above)
- [x] Extend the Table Designer to alter existing tables, not just create new ones (see design doc above)

### Query execution & analysis

- [ ] Graphical Query Plan Visualizer — interactive execution-plan diagram instead of today's plain-text `EXPLAIN PLAN` output ([design doc](docs/roadmap/query-plan-visualizer.md))
- [ ] Live connection/query Profiler — polling `MON$*` dashboard with delta stats, replacing today's one-shot connection snapshot ([design doc](docs/roadmap/live-profiler.md))
- [ ] Results grid: column freeze/show/hide, copy selection as an `INSERT` statement, copy selection as a SQL `IN (...)` clause
- [ ] Configurable keyboard shortcuts for query/result actions (a `firebird.shortcuts` setting, mirroring `mssql.shortcuts`)
- [ ] Per-session transaction isolation level, lock timeout, and other `SET`-option controls exposed as settings

### Data import/export & integration

- [ ] Flat File Import Wizard — guided CSV/TSV/JSON import into a new or existing table, with local type inference ([design doc](docs/roadmap/flat-file-import-wizard.md))
- [ ] SQL Notebooks — native VS Code notebook editor for Firebird SQL with rich per-cell results ([design doc](docs/roadmap/sql-notebooks.md))
- [ ] Data API Builder — generate REST/GraphQL endpoint configs from the connected schema, optionally Copilot-assisted (speculative — validate demand first) ([design doc](docs/roadmap/data-api-builder.md))

### Database lifecycle

- [ ] Firebird Database Projects — schema-as-code project structure with extract/build/publish and generated migration scripts, built on the existing schema-diff engine ([design doc](docs/roadmap/database-projects.md))
- [ ] Create, rename, and drop whole databases from the connection tree (not just objects within one)
- [ ] Object Search — fuzzy search for any object (table/view/procedure/trigger/etc.) by name across a connection
- [ ] Local Firebird container **creation** — provision a new Dockerized Firebird server from the extension, extending today's detect-existing-containers support
- [ ] Connection dialog: color-coded connection groups, and paste a full connection string to prefill fields

## Inspired by vscode-pgsql

The following features are adapted from Microsoft's [PostgreSQL extension for VS Code](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql) (`ms-ossdata.vscode-pgsql`; see also its [overview docs](https://learn.microsoft.com/en-us/azure/postgresql/development/vs-code-extension/postgresql-extension-overview)), reviewed — including its demo GIFs, not just its written docs — for what's applicable to Firebird. Several of its features overlap with items already tracked above under "Inspired by vscode-mssql" (schema visualization, results export, connection groups, object search, container creation) and aren't repeated here; this section covers what's genuinely new.

### AI & agent integration

- [ ] MCP Server — expose this extension's own connection/schema/query-execution tooling to *any* MCP-compatible AI client (Claude Desktop, Cursor, VS Code Copilot Agent mode), not just the `@firebird` chat participant, which only works inside this extension's own Copilot Chat integration ([design doc](docs/roadmap/mcp-server.md))
- [ ] AI Query Actions in the editor — right-click selected SQL for Explain/Optimize (reusing the existing `/explain`/`/optimize` chat logic) without first opening the chat panel

### Query execution & results

- [ ] Chart visualization for query results — render numeric result columns as line/bar/pie/scatter charts directly in the results panel, alongside the existing grid view

### Object explorer

- [ ] Generic "Script as Create" / "Script as Drop" — reverse-engineer any selected object's DDL from one tree action regardless of type, rather than only tables/procedures/views/triggers each having their own bespoke edit command

## Testing and CI

- [x] E2E test matrix covering Firebird 3, 4, 5, and 6 (snapshot) across Node.js 24-26, mirroring [node-firebird's own CI](https://github.com/mariuz/node-firebird/blob/master/.github/workflows/node.js.yml) so driver-compatibility regressions surface before they reach users on older or newer servers

---

> **Note**: This roadmap is subject to change based on community feedback and contributions. Feature requests and suggestions are welcome via [GitHub Issues](https://github.com/mariuz/vscode-firebird-studio/issues).
>
> Inspired by the features announced in [Microsoft's IDE for PostgreSQL in VS Code](https://techcommunity.microsoft.com/blog/adforpostgresql/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4414648), by [Microsoft's vscode-mssql extension](https://github.com/microsoft/vscode-mssql) for SQL Server, and by [Microsoft's vscode-pgsql extension](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql) for PostgreSQL.
