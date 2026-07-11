# Change Log

All notable changes to the "vscode-firebird-studio" extension will be documented in this file.

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
