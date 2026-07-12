# Change Log

All notable changes to the "vscode-firebird-studio" extension will be documented in this file.

## 0.1.52 - 2026-07-13

### Added

- **Parameterized query execution** — a new **Run Parameterized Query** command (`Ctrl+Alt+Shift+Q`) for `.sql` files containing named placeholders like `:customerId`. Prompts for each distinct placeholder's type (String/Integer/Float/Date/Boolean/NULL) and value, rewrites them to Firebird's positional `?` binding, and runs the query with real bound parameters rather than inlined text.

### Fixed

- The native driver (`firebird.useNativeDriver`) silently ignored any query parameters passed to it — `NativeClient.queryPromise()` never forwarded its `args` through to `connection.executeQuery()`. Only exposed once something in this codebase actually tried to bind parameters through the native driver path; fixed alongside Parameterized Query Execution.

## 0.1.51 - 2026-07-13

### Added

- **`/migrate` Copilot chat command** — paste (or have open in the editor) DDL from MySQL, PostgreSQL, SQL Server, Oracle, or legacy InterBase and ask `@firebird /migrate` to convert it to Firebird SQL, mapping data types (AUTO_INCREMENT/SERIAL/IDENTITY, TEXT, BOOLEAN, ENUM, ...) to their closest Firebird equivalent.

## 0.1.50 - 2026-07-13

### Added

- **Dev Container template** (`.devcontainer/`) — Node.js + a real `firebirdsql/firebird:5` server (the same image/config the CI workflows use), pre-seeded via `scripts/seed-test-db.js` on first create. Open the repo in VS Code and choose **Reopen in Container** for a working Firebird server with no local install, for quick-start/demo/contribution scenarios.

## 0.1.49 - 2026-07-13

### Added

- **AI analysis of query results** — a **🤖 Analyze** button on each result grid (when the query that produced it is known, e.g. from **Run Firebird Query**) sends the result set to Copilot for a concise summary — notable patterns, outliers, counts worth mentioning — opened beside the editor. Reuses the same prompt-building pattern as `/explain`/`/optimize`.

## 0.1.48 - 2026-07-12

### Added

- **Object Explorer Filters** — right-click a category folder (Tables, Views, Stored Procedures, Triggers, Generators, Domains, Roles, Exceptions, Users, System Tables) and choose **Filter Objects...** to narrow it to names containing a substring (case-insensitive); the folder's label shows the active filter, and **Clear Filter** removes it. Distinct from the existing Object Search command, which is a one-shot fuzzy lookup across every object type at once rather than narrowing what the tree itself shows.

## 0.1.47 - 2026-07-12

### Added

- **"What's New" notification** — shown once after an update (not on first install), summarizing the new version's `CHANGELOG.md` entry with a **Show Full Changelog** button. Silent on a fresh install and on same-version re-activations (e.g. a window reload).

## 0.1.46 - 2026-07-12

### Added

- **Getting Started walkthrough** — an interactive, checklist-style onboarding flow (VS Code's native Walkthroughs UI, shown from the Welcome page or **Help: Get Started**) covering adding a connection, exploring the tree, setting the active database, running a first query, and next steps (IntelliSense, snippets, mock data, `@firebird` Copilot Chat). Complements the existing static `docs/getting-started.md`.

## 0.1.45 - 2026-07-12

### Added

- **Object privileges/grants viewer** — right-click a table, view, procedure, or role for a new **Show Object Privileges** command, listing its grants (grantee, privilege, grant-option, and column for column-level grants) read from `RDB$USER_PRIVILEGES`, in the results grid.

## 0.1.44 - 2026-07-12

### Added

- **Generic "Script as Create" / "Script as Drop"** — right-click any table, view, procedure, trigger, generator, domain, role, exception, user, or index for one pair of commands that reconstructs its DDL for review, instead of each object type needing its own bespoke edit command. Users get a clearly-marked placeholder (Firebird never exposes an existing password); everything else is a genuine reconstruction from live metadata.

### Fixed

- `NUMERIC`/`DECIMAL` columns now round-trip with their real precision/scale (e.g. `NUMERIC(9,2)`) in Database Projects' Extract and the new Script as Create, instead of showing up as their bare underlying `INTEGER`/`BIGINT`/`DOUBLE` storage type — confirmed the exact `RDB$FIELD_SUB_TYPE`/`PRECISION`/`SCALE` semantics directly against a live Firebird server.

## 0.1.43 - 2026-07-12

### Added

- **Chart visualization for query results** — a new **📊 Chart** button on every result grid reveals a Bar/Line/Pie/Scatter chart alongside the grid, picking any column as the X-axis and a numeric column as the Y-axis (auto-detected). Hand-rolled SVG, no new charting dependency.

## 0.1.42 - 2026-07-12

### Added

- **AI Query Actions in the editor** — right-click SQL (or select part of it) → **AI: Explain Query** / **AI: Optimize Query** to get Copilot's analysis without opening the Chat panel first, opened in a new document beside your editor. Reuses the exact same prompts as the `@firebird` chat participant's `/explain`/`/optimize` slash commands.

## 0.1.41 - 2026-07-12

### Added

- **MCP Server** (`firebird.mcp.enabled`, off by default) — exposes a `list_connections`/`get_schema` MCP server to any MCP-compatible AI client (Claude Desktop, Cursor, VS Code Copilot Agent mode), independent of this extension's own `@firebird` Copilot Chat participant. Right-click a database → **Toggle MCP Server Exposure** to opt a connection in — nothing is exposed by default even with the setting on, and credentials never reach the MCP client itself. Read-only schema inspection only in this pass; no query-execution tool yet.

## 0.1.40 - 2026-07-12

### Added

- **Color-coded connection groups** — right-click a database → **Set Connection Color...** tags it with a color shown in its tree icon and (when active) the status bar; **Set Connection Group...** organizes it under a named folder in the Explorer tree instead of by host.
- **Paste a connection string** — the "Add New Connection" wizard now offers to prefill every field from a pasted `firebird://user:password@host:port/database` string instead of stepping through each prompt by hand.

### Fixed

- Renaming a database, or tagging the *currently active* connection with a color/group, now actually updates the status bar immediately — previously this went through a code path that only reacts to the active connection's id changing, silently no-op'ing for same-connection field edits.

## 0.1.39 - 2026-07-12

### Added

- **Create Local Firebird Container** — provisions a brand-new Firebird server as a Docker container (pick a version, port, SYSDBA password, database name, and ephemeral-vs-persistent-volume storage), waits for it to accept connections, then adds it as a saved connection automatically. Extends the existing "Add New Connection" Docker option's container *detection* with container *creation*.

## 0.1.38 - 2026-07-12

### Added

- **Object Search** — right-click a database → **Search Objects...** to fuzzy-search every table, view, procedure, trigger, generator, and domain by name in one QuickPick, then jump straight to it: tables/views open their data, procedures/triggers/domains open for editing, and generators show their current value.

## 0.1.37 - 2026-07-12

### Added

- **Create, rename, and drop whole databases** — **Create New Database...** (Command Palette) creates a brand-new database file and adds it as a connection; right-click a database → **Rename Database...** (embedded connections only) renames its file on disk, or **Drop Database...** to permanently delete it (modal confirmation — there is no undo).

## 0.1.36 - 2026-07-12

### Added

- **Firebird Database Projects** — right-click a database → **Extract Database Project...** writes the connected schema out as one `.sql` file per table/view/procedure/trigger/generator, plus a manifest recording a safe deploy order; **Build Database Project...** (Command Palette) concatenates an extracted project into one reviewable deploy script.

## 0.1.35 - 2026-07-12

### Added

- **Data API Builder** — right-click a database → **Generate Data API Spec...** to produce an OpenAPI 3.0 document (list/create/get/update/delete routes per table, JSON Schema types inferred from your columns) opened as plain JSON for review — a reviewable artifact for your own REST/GraphQL backend, not a server this extension runs itself.

## 0.1.34 - 2026-07-12

### Added

- **SQL Notebooks** — a new `.fbnb` notebook type (**New Firebird SQL Notebook** command): mix markdown and SQL cells, run a cell to execute it against a picked connection and see rows rendered as a table, DDL/DML success messages, or errors, right below the cell.

## 0.1.33 - 2026-07-12

### Added

- **Flat File Import Wizard** — right-click a database → **Import Flat File...** to import a CSV, TSV, or JSON file into a new table: it sniffs a Firebird column type per column (INTEGER/BIGINT/NUMERIC/BOOLEAN/DATE/TIMESTAMP/VARCHAR), lets you review/edit the generated `CREATE TABLE` before it runs, then batch-inserts every row with a progress notification.

## 0.1.32 - 2026-07-12

### Added

- **Transaction settings** — four new settings (`firebird.transaction.isolationLevel`, `.lockTimeoutSec`, `.readOnly`, `.waitMode`) apply to every transaction Firebird Studio opens to run a query or batch, letting you set e.g. Snapshot isolation or a lock-wait timeout without editing SQL. `lockTimeoutSec` is honored by the pure-JS driver only — the native driver's transaction API has no numeric lock-timeout option, only wait/no-wait.

## 0.1.31 - 2026-07-12

### Added

- **Configurable results-grid shortcuts** — a new `firebird.shortcuts` setting (mirroring vscode-mssql's `mssql.shortcuts`) lets you rebind the keyboard shortcuts for toggling edit mode, adding a row, applying changes, freezing the first column, and copying a selection as `INSERT`/`IN (...)`, all scoped to whichever result grid has focus

## 0.1.30 - 2026-07-12

### Added

- **Results grid: column freeze, show/hide, and copy-as-SQL** — a "Columns" button lets you toggle individual result columns on/off, "❄ Freeze Column" pins the first column while you scroll horizontally, and click/shift-click a range of cells then "Copy as INSERT" or "Copy as IN (...)" to copy ready-to-paste SQL built from the selection

## 0.1.29 - 2026-07-12

### Added

- **Live Profiler** — **Monitor Database** now opens a continuously-refreshing connection activity view instead of a one-time snapshot: see every connection's user, remote address, current statement, and live I/O rates (reads/writes/fetches per second), auto-updating on an interval (`firebird.profiler.pollIntervalMs`, default 3s) with Pause/Resume and manual refresh

## 0.1.28 - 2026-07-12

### Added

- **Graphical Query Plan** — new "Show Graphical Query Plan" command (`Ctrl+Alt+Shift+E` / `Cmd+Alt+Shift+E`) renders the active query's execution plan as an interactive, pannable/zoomable node diagram instead of plain text: click a node to see its access method and index, toggle to the raw `PLAN` text if you just want to copy it. Requires the native driver, same as the existing text-based explain plan.

## 0.1.27 - 2026-07-12

### Added

- **Ask Copilot** in the Schema Designer — describe a schema change in plain English ("add an ORDERS table linked to CUSTOMERS") and it edits the open diagram directly: adds/modifies tables and columns, draws relationships, then lets you review and generate/execute the resulting DDL exactly like a manual edit would

## 0.1.26 - 2026-07-12

### Added

- **Visual Schema Designer** — replaces the separate read-only "Visualize Schema" diagram and single-table "Create/Alter Table" designer with one merged, editable multi-table designer: add new tables and columns, draw or delete foreign key relationships between columns by dragging, and alter existing tables' columns and primary key, all from the same whole-database canvas. Generates a consolidated `CREATE`/`ALTER TABLE` DDL script for review before running, correctly handling constraint drop/re-add ordering (e.g. when changing a primary key that a foreign key elsewhere still depends on). The **Visualize Schema**, **Create Table**, and **Alter Table** commands all now open this designer, focused appropriately — no new commands to learn.

### Fixed

- Executing generated DDL from the table/schema designer now runs each statement individually instead of sending the whole (possibly multi-statement) script as one query, which could silently fail to run everything past the first statement.

## 0.1.25 - 2026-07-12

### Added

- **Workspace-level database configuration** — commit a `.vscode/firebird.json` declaring a project's connection(s) and everyone who opens the folder gets it in DB Explorer automatically, no manual setup required. Supports marking one connection `"default": true` to auto-activate on open, JSON schema-backed autocomplete/validation, and never stores passwords in the file (see `docs/connection-setup.md`)
- **Set Connection Password** — new context-menu action on any database connection to set/update its stored password without removing and re-adding it; the only way to attach a password to a workspace connection, but works for manually-added ones too

## 0.1.24 - 2026-07-12

### Added

- **Alter Table** now opens the visual Table Designer pre-populated with the table's existing columns, instead of a plain-text scaffold — edit column types, sizes, defaults, NOT NULL, and the primary key, and it generates the `ALTER TABLE ADD/DROP/ALTER COLUMN` statements for you. Renaming a column in place is detected as a genuine rename rather than a drop-and-recreate that would lose data.

## 0.1.23 - 2026-07-12

### Added

- **Create** actions for object types that only supported edit/drop before: right-click the **Stored Procedures**, **Triggers**, **Views**, **Generators**, and **Domains** folders to scaffold a new one (opened as SQL for you to fill in and run, the same way the existing edit/alter actions work)
- **Alter Domain** — right-click an existing domain for an `ALTER DOMAIN` scaffold pre-filled with its current type

## 0.1.22 - 2026-07-12

### Added

- **Connection pooling** — new `firebird.enableConnectionPooling` setting (off by default) keeps idle connections open and reuses them for subsequent queries against the same saved connection instead of reconnecting every time, with `firebird.connectionPool.maxSize` and `firebird.connectionPool.idleTimeoutMs` controlling pool size and idle lifetime. Works with both the native and pure-JS drivers.

### Fixed

- The pure-JS driver now fails loudly with a clear message when asked to open an "embedded" connection, instead of silently connecting to a Firebird server on `127.0.0.1:3050` — `node-firebird` has no embedded-engine support, so embedded databases require `firebird.useNativeDriver`

## 0.1.21 - 2026-07-12

### Added

- `@firebird` Copilot Chat participant: new `/designSchema` slash command — paste or open sample data (CSV, JSON, or plain-text rows) and it suggests Firebird `CREATE TABLE` DDL with inferred column types and constraints

## 0.1.20 - 2026-07-12

### Added

- Every table now shows an **Indexes** folder alongside its columns, listing standalone user-created indexes (constraint-backed indexes for primary/foreign/unique keys are already shown via the column icons, so they're deliberately excluded here to avoid duplication)
- **Create Index** (regular or unique, any number of columns) and **Drop Index** actions

### Fixed

- `Generate Mock Data` no longer errors when a table's tree children include the new Indexes folder — it was previously assuming every child was a column

## 0.1.19 - 2026-07-12

### Added

- Object Explorer: databases now show a **Users** folder (Firebird 3+'s SQL-visible `SEC$USERS`), alongside **Roles**, which now supports **Create Role** in addition to the existing Drop
- **Create User**, **Change Password**, and **Drop User** actions, using Firebird's native `CREATE USER`/`ALTER USER`/`DROP USER` SQL — no `gsec` shell-out required
- Passwords for these actions are entered through a masked input box and applied via a direct connection that bypasses the extension's normal query-execution path, so the plaintext password is never written to session query history or the output channel log (unlike a typical typed-and-run `CREATE USER ... PASSWORD '...'` statement, which would be)

## 0.1.18 - 2026-07-12

### Added

- **Add New Connection**'s Docker option now auto-detects Firebird servers running in local Docker containers instead of just assuming `localhost:3050`: it lists every running container that publishes Firebird's port (3050), pre-fills the host/port from whichever one you pick, and — when the container's `FIREBIRD_DATABASE` env var is set (the official `firebirdsql/firebird` image's convention) — suggests the database path too, still editable before you continue
- New `firebird.dockerPath` setting for when the `docker` executable isn't on `PATH`
- Falls back to the previous static `localhost:3050` behavior when Docker isn't installed or no matching containers are running, so nothing changes for setups without Docker

## 0.1.17 - 2026-07-11

### Added

- Object Explorer: databases now show **Roles** and **Exceptions** folders alongside the existing Tables/Views/Procedures/Triggers/Generators/Domains, each with a **Drop** action
- Optional **System Tables** folder, listing Firebird's own `RDB$` metadata tables, gated behind the new `firebird.showSystemObjects` setting (off by default — most users never need to browse these directly)
- Firebird-specific syntax highlighting for `.sql` files: `EXECUTE BLOCK`, `SET TERM`, `CREATE OR ALTER`, `RECREATE`, `SUSPEND`, `POST_EVENT`, exception/context keywords, and `RDB$`/`MON$`/`SEC$` system identifiers now get their own highlight scopes on top of the base SQL grammar

### Internal

- The E2E CI workflow now runs its test suite against a matrix of Node.js 24/25/26 × Firebird 3/4/5/6-snapshot (12 jobs), mirroring [node-firebird's own CI](https://github.com/mariuz/node-firebird/blob/master/.github/workflows/node.js.yml), to catch driver-version compatibility regressions before they reach users. No extension behavior changed.

## 0.1.16 - 2026-07-11

### Added

- isql in the integrated terminal, similar to "psql in the terminal" in Microsoft's PostgreSQL extension: right-click a database → **Connect with ISQL** opens an integrated terminal already connected via `isql`/`isql-fb`; right-click in a `.sql` editor → **Run File with ISQL** saves the file and runs it non-interactively with `isql -i`. Credentials are passed via the `ISC_USER`/`ISC_PASSWORD` environment variables rather than the visible command line, matching how the PostgreSQL extension uses `PGPASSWORD`. New `firebird.isqlPath` setting for when the executable isn't on `PATH`.

## 0.1.15 - 2026-07-11

### Added

- Schema visualizer: right-click a database → **Visualize Schema** for an interactive entity-relationship diagram of its tables, columns, and foreign key relationships, with pan, zoom, fit-to-view, a minimap, and an auto-layout that recalculates table positions. Primary key columns are marked; hovering a table highlights its relationships. Firebird has no per-schema/namespace concept the way PostgreSQL does, so this always maps the whole database rather than one schema at a time.

## 0.1.14 - 2026-07-11

### Added

- Editable result grids: enable editing on any result set to update cells, add new rows, or mark rows for deletion, then apply the changes directly to the database in one step — replacing the previous "generate an UPDATE statement to copy/paste" helper, which only handled a single-row UPDATE and never supported INSERT or DELETE
- Row targeting is now primary-key aware (looked up automatically from the table), falling back to matching every column when a table has no primary key; NULL values are compared with `IS NULL` instead of the always-false `= NULL`
- Applying changes asks for confirmation first, then reports success/failure per row, with failed rows highlighted so you know exactly what didn't apply

## 0.1.13 - 2026-07-11

### Fixed

- Fixed "SQL error code = -204, Data type unknown, Implementation limit exceeded, COLUMN" when editing a stored procedure, trigger, or view's source. These fetch their `RDB$*_SOURCE` BLOB via `CAST(... AS VARCHAR(32000))` with no explicit character set; since connections default to UTF8 (up to 4 bytes/char), that cast needed up to 128000 bytes — well past Firebird's 32767-byte column limit — and always failed. Now casts to an explicit `CHARACTER SET UTF8` sized to fit (8191 chars), and warns in the opened scaffold if a very large body still hits that limit.

## 0.1.12 - 2026-07-11

### Fixed

- Fixed "Your user name and password are not defined" when expanding a table, view, or stored procedure in the Explorer view, or editing a view/procedure/trigger's source. `NodeDatabase` resolved the saved connection's password from SecretStorage before listing its own children, but handed the *unresolved* connection down to the `NodeTable`/`NodeView`/`NodeProcedure` objects it created; those then connected directly without resolving it themselves. Every direct-connect call site now resolves the password first via a shared `Driver.resolvePassword()` helper.

## 0.1.11 - 2026-07-11

### Added

- Session query history now automatically logs *every* query run through the extension — predefined tree actions (Select All Records, Show Table Info, Drop Table/View/Procedure/Trigger/Generator/Domain, Table Designer DDL, etc.), not just the main "Run Query" editor command
- Each history entry now records which connection it ran against; re-running a history entry (**History → Run**) replays it against that original connection instead of whatever happens to be active, falling back to the active connection with a notice if the original was removed
- History entries display their connection in the tree and tooltip

### Changed

- Deduplicated the "extract database filename from a connection path" logic that had been copy-pasted across `Global`, the connection picker, and the database tree node into a single shared helper

## 0.1.10 - 2026-07-11

### Added

- Batch execution: running a query now correctly handles multiple `;`-separated statements in a single document, including `CREATE`/`ALTER PROCEDURE`, `TRIGGER`, `FUNCTION`, and `EXECUTE BLOCK` bodies (with or without the isql `SET TERM ^ ;` convention used by this extension's own snippets) as a single atomic statement instead of splitting on their internal semicolons

### Fixed

- Upgraded TypeScript to 6.0.3 and fixed the resulting strict-mode findings across the codebase
- Corrected `wireCrypt` connection option translation for the non-native driver, which previously could hang the connection instead of erroring
- Fixed several GitHub Actions CI issues (unit tests running the wrong test tier, workflows resolving an unpinned global TypeScript instead of the project's version)

## 0.1.9 - 2026-04-07

### Changed

- Renamed extension to **Firebird Studio for VS Code** (`vscode-firebird-studio`)
- Updated publisher to `mariuz`, repository and bug tracker URLs to `github.com/mariuz/vscode-firebird-studio`
- Updated logo to a new Firebird-inspired flame/phoenix icon
- Updated README, docs, and all references to remove legacy fork branding

## 0.1.8 - 2026-03-26

### Added

- [CONTRIBUTING.md](CONTRIBUTING.md) — comprehensive contributing guide covering development setup, coding style, commit conventions, and PR process
- [docs/getting-started.md](docs/getting-started.md) — step-by-step tutorial for first-time users (install, connect, explore, query, export)
- [docs/connection-setup.md](docs/connection-setup.md) — detailed connection configuration reference including native driver and WireCrypt setup
- [docs/sql-snippets.md](docs/sql-snippets.md) — full reference for all 45 Firebird SQL snippets with examples and quick-reference table
- Improved [README.md](README.md) with structured settings table, documentation index, and links to new guides
- Marked **Documentation and Community** roadmap items as completed in [ROADMAP.md](ROADMAP.md)

## 0.1.7 - 2026-03-26

### Added

 - Added [ROADMAP.md](ROADMAP.md) with planned features inspired by [Microsoft's IDE for PostgreSQL in VS Code](https://techcommunity.microsoft.com/blog/adforpostgresql/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4414648)
 - Planned: Enhanced Object Explorer with views, stored procedures, triggers, generators, domains, and roles
 - Planned: Intelligent IntelliSense improvements with context-aware schema completion
 - Planned: AI-powered enhancements with GitHub Copilot integration for Firebird SQL
 - Planned: Session query history and batch query execution
 - Planned: Query performance analysis with explain plan integration
 - Planned: Editable result grids for data manipulation
 - Planned: Firebird 4.x/5.x wire protocol and authentication support
 - Planned: Database management features (create/alter/drop objects, backup/restore, monitoring)
 - Planned: SQL formatting, schema diff, and linting

## 0.1.4 - 2023-09-20

 - Fixed mockaroo integration
 - Added experimental native driver support
 - Fixed icon in sidebar
 

## 0.1.3 - 2023-02-15

 - Added type or field information to completion window
 - Only autocomplete fields after table

## 0.1.0 - 2023-02-14

 - Added support to table alias in completion

### Fixed
 - Fixed query results webview

## 0.0.4 - 2019-03-11

### Fixed
 - SELECT bug after previous DELETE

## 0.0.3 - 2018-11-27

### Added

- [Firebird Role](https://firebirdsql.org/file/documentation/reference_manuals/fblangref25-en/html/fblangref25-ddl-role.html) - User role input added to **Add New Connection** wizard.

## 0.0.2 - 2018-11-18

### Added

- [SQL Mock Data Generator](https://github.com/mariuz/vscode-firebird-studio/wiki/SQL-Mock-Data-Generator)

## 0.0.1 - 2018-11-14

- Initial release
