<h1 align="center">
  <br>
    <img src="https://github.com/mariuz/vscode-firebird-studio/blob/master/resources/img/icon.png?raw=true" alt="Firebird Studio icon" width="128">
  <br>
  Firebird Studio for VS Code
  <br>
</h1>
<h4 align="center">Explore, query, and manage your Firebird&reg; databases without leaving VS Code.</h4>

![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/mariuz.vscode-firebird-studio.svg) ![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/mariuz.vscode-firebird-studio.svg)

This extension allows you to connect directly to your [Firebird&reg; databases](https://firebirdsql.org/), list tables and fields, run queries, display/export results and more.

![banner](https://github.com/mariuz/vscode-firebird-studio/blob/master/images/banner.jpg?raw=true)

## Features

### Features in Firebird Studio

- **Table alias** in code completion
- [_Experimental_] Native driver support (required for WireCrypt support)
- Fixed query results and mock data view
- 45 Firebird SQL **code snippets** (type `fb` in any `.sql` file)
- [SQL Mock Data Generator](https://github.com/mariuz/vscode-firebird-studio/wiki/SQL-Mock-Data-Generator)
- Manage multiple database connections
- List hosts, databases, tables, views, stored procedures, triggers, generators, domains, roles, exceptions, and users inside **Explorer View**, with an optional System Tables folder for browsing Firebird's own `RDB$` metadata
- **Create/drop roles and users**, and change user passwords, without leaving the Explorer — no `gsec` required, and passwords never touch session query history or logs
- **View, create, and drop indexes** per table, alongside its columns
- Firebird-specific syntax highlighting for PSQL blocks (`EXECUTE BLOCK`, `SET TERM`, `SUSPEND`, `RDB$`/`MON$` identifiers, and more)
- [Firebird Reserved Words](https://firebirdsql.org/refdocs/langrefupd25-reskeywords-full-reswords.html) **Code Completion**
- Table and field names **Code Completion**
- Run Firebird **SQL** queries
- Run **predefined** custom queries
- View results in a **table**
- **Realtime** results filtering and sorting
- Export results to **JSON**, **CSV**, **XSLX** or **PDF** file
- **Session query history** — every query you run is logged automatically (with the database it ran against, row count/duration, and any error), and can be reopened or re-run from the **History** view
- **Editable result grids** — enable editing on any result set to update cells, add rows, or mark rows for deletion, then apply the changes directly to the database (primary-key aware, with a confirmation before anything is written)
- **Schema visualizer** — an interactive entity-relationship diagram of a database's tables, columns, and foreign key relationships, with pan/zoom, auto-layout, and a minimap
- **isql in the integrated terminal** — connect with `isql`/`isql-fb` for backslash-command-style administration, or run a `.sql` file through it directly, without leaving VS Code
- **Graphical query plan** — an interactive, pannable/zoomable diagram of a query's execution plan (native driver required)
- **Live Profiler** — a continuously-refreshing view of active connections, their current statement, and live I/O rates
- **Results grid**: freeze/show-hide columns, and copy a cell selection as an `INSERT` statement or a SQL `IN (...)` clause
- **Configurable results-grid shortcuts** (`firebird.shortcuts`) and per-session **transaction settings** (isolation level, lock timeout, read-only, wait mode)
- **Flat File Import Wizard** — import a CSV/TSV/JSON file into a new table, with local column-type inference
- **SQL Notebooks** — a native `.fbnb` notebook editor mixing markdown and SQL cells, with results rendered per cell
- **Data API Builder** — generate an OpenAPI 3.0 REST spec (one CRUD route set per table) from the connected schema

## Getting Started

For a detailed step-by-step walkthrough see **[docs/getting-started.md](docs/getting-started.md)**.

Quick start:

1. [Install the extension](https://marketplace.visualstudio.com/items?itemName=mariuz.vscode-firebird-studio)
2. Restart VS Code and click the **Firebird flame icon** in the Activity Bar.
3. Click **+** in the DB Explorer title bar to add a connection.
4. Right-click your database and choose **Set Active**, then open a `.sql` file and press `Ctrl+Alt+Q` to run a query.

## Using the Extension

### Add a New Connection

Click the **+** (Add New Connection) icon in the DB Explorer title bar. The Connection Wizard guides you through host, port, database path, username, password, and optional role. Your connection appears in the tree when the wizard completes.

Choosing **Docker** as the connection type auto-detects Firebird containers currently running on your machine — pick one from the list and its published port (and, when available, its database path) are filled in for you. Falls back to the previous `localhost:3050` default if Docker isn't installed or no matching container is running.

For advanced options (native driver, WireCrypt) see **[docs/connection-setup.md](docs/connection-setup.md)**.

### Explore Database Contents

Expand the database node to see category folders: **Tables**, **Views**, **Stored Procedures**, **Triggers**, **Generators**, **Domains**, **Roles**, **Exceptions**, and **Users**. Expand any table to see its columns, with type/length and primary/foreign/unique/not-null markers shown inline, plus an **Indexes** folder for standalone user-created indexes (primary/foreign/unique-key indexes are already shown via the column icons, so they're not duplicated here).

> **Tip:** Right-clicking a tree node shows available actions such as **Select All Records**, **Show Table Info**, or **New Query**.

Enable **firebird.showSystemObjects** to also show a **System Tables** folder, listing Firebird's own `RDB$` metadata tables (read-only — browsing and querying only, no drop).

### Managing Users and Roles

Right-click the **Roles** folder → **Create Role**, or the **Users** folder → **Create User** (prompts for a password). Right-click an existing user for **Change Password** or **Drop User**; roles support **Drop Role**. These use Firebird's native `CREATE`/`ALTER`/`DROP USER` SQL (Firebird 3+) rather than shelling out to `gsec`, and passwords are sent through a connection that bypasses query history/logging — they're never written to disk in plaintext by the extension.

### Managing Indexes

Right-click a table's **Indexes** folder → **Create Index**, choose the column(s) (comma-separated, for a composite index) and whether it should be unique. Right-click an existing index for **Drop Index**.

### Visual Schema Designer

Right-click a database node → **Visualize Schema** (or a table → **Create Table**/**Alter Table**) to open the Schema Designer: an editable entity-relationship diagram of every table, its columns, and its foreign key relationships (primary key columns are marked).

- **Pan**: drag an empty area of the canvas. **Zoom**: scroll wheel, or the **+**/**−** buttons.
- **Fit to View** zooms and centers so every table is visible; the **minimap** in the corner shows your position in a large schema, and is clickable to jump around.
- Click a table to open its column editor in the side panel — add/remove/edit columns, change the primary key. **+ Add Table** creates a new one; drag from a column's right edge to another table's column to draw a foreign key, and click an edge + <kbd>Delete</kbd> to remove one.
- **Ask Copilot** — describe a change in plain English (e.g. "add an ORDERS table linked to CUSTOMERS") and it edits the diagram for you, the same as if you'd made the change by hand.
- **Generate DDL in Editor** / **Execute DDL** produce the `CREATE`/`ALTER TABLE` statements needed to apply your changes — always reviewable before running.
- Dropping an existing table isn't done here — use **Drop Table** from the tree instead.
- The diagram doesn't update automatically after schema changes made elsewhere — use **Refresh** to reload it (this discards any unsaved edits on the canvas, after a confirmation).

Firebird doesn't have PostgreSQL-style schemas/namespaces, so unlike similar tools this always shows the whole database rather than one schema at a time.

### Set an Active Database

Before running queries, set an active database:

- Right-click the database node → **Set Active**, or
- Click the Firebird indicator in the status bar (bottom-left) and select a database.

> **Tip:** The **New Query** command sets the selected database active and opens a new SQL document.

### Running SQL Queries

Press `Ctrl+Alt+Q` or right-click the editor → **Run Firebird Query**.
If you select text first, only the selection runs; otherwise the whole document runs as a **batch**.

Each `;`-separated statement in the document gets its own tab in the results view, showing its row count (or error) at a glance. `CREATE`/`ALTER PROCEDURE`, `TRIGGER`, `FUNCTION`, and `EXECUTE BLOCK` bodies are treated as a single statement — including the isql `SET TERM ^ ;` convention used by this extension's own snippets — so the semicolons inside a procedure body don't get split into separate statements.

### Using isql in the Terminal

For backslash commands, `.sql` script testing, or anything the graphical query editor doesn't cover:

- Right-click a database → **Connect with ISQL** opens an integrated terminal running `isql`/`isql-fb`, already connected — no need to type `-user`/`-password` yourself.
- With a `.sql` file open, right-click in the editor → **Run File with ISQL** saves the file and runs it through `isql -i` against the active database.

Requires the Firebird client tools (`isql` or `isql-fb`) to be installed and on your `PATH`; if the extension can't find them, set the **firebird.isqlPath** setting to the executable's full path. Credentials are passed via the `ISC_USER`/`ISC_PASSWORD` environment variables rather than the visible command line.

### Editing Query Results Directly

Any result grid (single query or a batch panel) can be edited in place:

1. Click **Enable Editing**. The **Table** field pre-fills automatically when it can be detected from the query; the extension looks up that table's primary key so edits target exactly one row.
2. Edit a cell directly in the grid, click **+ Add Row** for a new row, or click the ✕ next to a row to mark it for deletion.
3. Click **Apply Changes**. You'll be asked to confirm before anything is written; each change reports success or failure individually, and failed rows stay highlighted so you can retry.

Without a primary key, edits fall back to matching every column in the row — still safe, but less precise if the table has duplicate rows.

### SQL Snippets

Type `fb` in any `.sql` file and pick a snippet from the IntelliSense list. There are 45 snippets covering DML, DDL, PSQL control flow, and common functions.

See the full list in **[docs/sql-snippets.md](docs/sql-snippets.md)**.

### SQL Mock Data Generator

Right-click a table → **Generate Mock Data**. Requires a [Mockaroo API key](https://www.mockaroo.com/users/sign_up). See [wiki](https://github.com/mariuz/vscode-firebird-studio/wiki/SQL-Mock-Data-Generator) for details.

### Graphical Query Plan

With a query in the editor, press `Ctrl+Alt+Shift+E` (`Cmd+Alt+Shift+E` on macOS) or run **Show Graphical Query Plan** — an interactive, pannable/zoomable diagram of the execution plan opens: click a node to see its scan method and index in a side panel, or toggle to the raw `PLAN` text to copy it. Requires the native driver (`firebird.useNativeDriver`); with the pure-JS driver it falls back to a text summary of relevant index metadata instead of a real plan.

### Live Profiler

Right-click a database → **Monitor Database** opens a continuously-refreshing view of every connection to that database: user, remote address, current statement, and live I/O rates (page reads/writes/fetches per second). **Pause**/**Resume** stops and restarts polling; the interval is controlled by `firebird.profiler.pollIntervalMs` (default 3s).

### Results Grid: Freeze, Show/Hide, and Copy as SQL

Every result grid has a **Columns** button (show/hide any column) and a **❄ Freeze Column** toggle (pins the first column while you scroll a wide result horizontally). Click a cell, then shift-click another to select a rectangular range, and use **Copy as INSERT** or **Copy as IN (...)** to copy ready-to-paste SQL built from the selection — handy for turning a few rows you spotted into a repro `INSERT` or a `WHERE id IN (...)` filter elsewhere. All of these (plus **Enable Editing**, **+ Add Row**, and **Apply Changes**) also have configurable keyboard shortcuts — see `firebird.shortcuts` below.

### Flat File Import Wizard

Right-click a database → **Import Flat File...**, then pick a CSV, TSV, or JSON file. The wizard sniffs a Firebird column type per column (`INTEGER`/`BIGINT`/`NUMERIC`/`BOOLEAN`/`DATE`/`TIMESTAMP`/`VARCHAR`) from the file's own data, opens the generated `CREATE TABLE` statement in an editor for you to review or edit, and — once you confirm — creates the table and batch-inserts every row with a progress notification. Only creating a brand-new table is supported today; mapping onto an existing table's columns is a planned follow-up.

### SQL Notebooks

Run **New Firebird SQL Notebook** to create a `.fbnb` notebook: mix markdown cells (documentation/notes) with SQL cells. Running a SQL cell (the ▷ button, or `Ctrl+Enter`/`Shift+Enter` like any VS Code notebook) executes every statement in that cell against a connection you pick the first time you run a cell in that notebook — rows come back as a table, DDL/DML as a success message, and errors are shown inline on the cell, all without leaving the notebook. The connection choice is remembered for the rest of that VS Code session, but isn't yet saved into the `.fbnb` file itself, so reopening a notebook (or restarting VS Code) will ask again.

### Data API Builder

Right-click a database → **Generate Data API Spec...** to generate an OpenAPI 3.0 document from the connected schema: a component schema per table (with JSON Schema types inferred from your columns) and CRUD routes (`GET`/`POST /table`, plus `GET`/`PUT`/`DELETE /table/{id}` for tables with a primary key). It opens as plain JSON for you to review — this doesn't run a REST server itself; hand the generated spec to your own backend (or a tool that consumes OpenAPI specs) to actually serve it.

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `firebird.codeCompletion.keywords` | boolean | `true` | Enable code completion for Firebird reserved words |
| `firebird.codeCompletion.database` | boolean | `true` | Enable code completion for table and field names |
| `firebird.logLevel` | string | `INFO` | Logging level in the output channel (`DEBUG`, `INFO`, `WARN`, `ERROR`) |
| `firebird.maxTablesCount` | number | `10` | Maximum tables shown in the tree (0 = all) |
| `firebird.recordsPerPage` | string | `10` | Records per page in results view (`10`, `25`, `50`, `100`, `All records`) |
| `firebird.mockarooApiKey` | string | *(blank)* | API key for the Mock Data Generator |
| `firebird.useNativeDriver` | boolean | `false` | Use the experimental native Firebird client driver |
| `firebird.isqlPath` | string | *(blank)* | Path to the `isql`/`isql-fb` executable; leave blank to search `PATH` automatically |
| `firebird.showSystemObjects` | boolean | `false` | Show a **System Tables** folder listing Firebird's built-in `RDB$` system/metadata tables under each database |
| `firebird.dockerPath` | string | *(blank)* | Path to the `docker` executable, used to auto-detect running Firebird containers in **Add New Connection**; leave blank to search `PATH` automatically |
| `firebird.enableConnectionPooling` | boolean | `false` | Keep idle connections alive and reuse them instead of reconnecting per query |
| `firebird.connectionPool.maxSize` | number | `5` | Max idle connections retained per saved connection when pooling is enabled |
| `firebird.connectionPool.idleTimeoutMs` | number | `60000` | How long an idle pooled connection is kept before being closed |
| `firebird.profiler.pollIntervalMs` | number | `3000` | How often the Live Profiler re-polls connection activity while its panel is visible |
| `firebird.shortcuts` | object | `{}` | Keyboard shortcuts for actions inside the **Query Results** webview (edit mode, freeze column, copy as INSERT/IN); see the setting's description for event names and combo syntax |
| `firebird.transaction.isolationLevel` | string | *(blank)* | Isolation level for every transaction this extension opens (`READ_COMMITTED_RECORD_VERSION`, `READ_COMMITTED_NO_RECORD_VERSION`, `SNAPSHOT`, `SNAPSHOT_TABLE_STABILITY`); blank uses the driver's own default |
| `firebird.transaction.lockTimeoutSec` | number | `0` | Lock wait timeout in seconds before a blocked query gives up (`0` = wait indefinitely); only honored by the pure-JS driver |
| `firebird.transaction.readOnly` | boolean | `false` | Open every query's transaction as READ ONLY |
| `firebird.transaction.waitMode` | string | *(blank)* | `WAIT` or `NO_WAIT` for a lock conflict; blank uses the driver's default (`WAIT`) |

## Documentation

| Document | Description |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Step-by-step tutorial for first-time users |
| [docs/connection-setup.md](docs/connection-setup.md) | All connection options including native driver and WireCrypt |
| [docs/sql-snippets.md](docs/sql-snippets.md) | Full reference of all 45 SQL snippets |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, code style, and PR process |
| [ROADMAP.md](ROADMAP.md) | Planned features and improvements |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Disclaimer

This extension is still in early development and may not be suitable for use in active production environments.

## Bug Reports & Feature Requests

Submit a bug report or feature suggestion via the [GitHub Issue Tracker](https://github.com/mariuz/vscode-firebird-studio/issues).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up your development environment and submit changes.
