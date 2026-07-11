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
- List hosts, databases, tables, views, stored procedures, triggers, generators, and domains inside **Explorer View**
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

For advanced options (native driver, WireCrypt) see **[docs/connection-setup.md](docs/connection-setup.md)**.

### Explore Database Contents

Expand the database node to see category folders: **Tables**, **Views**, **Stored Procedures**, **Triggers**, **Generators**, and **Domains**. Expand any table to see its columns with data types.

> **Tip:** Right-clicking a tree node shows available actions such as **Select All Records**, **Show Table Info**, or **New Query**.

### Visualizing the Schema

Right-click a database node → **Visualize Schema** to open an entity-relationship diagram of every table, its columns, and its foreign key relationships (primary key columns are marked).

- **Pan**: drag an empty area of the canvas. **Zoom**: scroll wheel, or the **+**/**−** buttons.
- **Fit to View** zooms and centers so every table is visible; the **minimap** in the corner shows your position in a large schema, and is clickable to jump around.
- Drag a table to reposition it; **Auto Layout** recalculates positions for the whole diagram.
- The diagram doesn't update automatically after schema changes — use **Refresh** to reload it.

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
