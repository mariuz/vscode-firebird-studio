# Flat File Import Wizard

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Flat File Import ("Import flat files (CSV, TXT) as new database tables using a guided wizard").

## Current state in Firebird Studio

**Phases 1 and 2 are done.** Right-click a database → **Import Flat File...** runs a guided QuickPick/InputBox wizard (no webview needed for this phase) that picks a CSV/TSV/JSON file, infers a schema, creates a new table, and batch-inserts every row:

- `src/shared/flat-file-parser.ts` — pure parsing/inference module, unit-tested like `sql-formatter.ts` (55 tests): a hand-rolled RFC 4180-ish CSV/TSV parser (quoted fields, embedded delimiters/newlines, doubled-quote escaping, delimiter auto-sniffing between `,`/`\t`/`;`), a JSON array-of-objects parser, `inferColumnType()`/`inferSchema()` (INTEGER/BIGINT/NUMERIC(p,s)/BOOLEAN/DATE/TIMESTAMP/VARCHAR(n), sniffed from up to 200 sample rows, with nullability detection), `sanitizeIdentifier()` (Firebird 3.0's 31-char-safe identifier limit, since that's the floor across the FB3/4/5/6 CI matrix), and DDL/INSERT builders. No new npm dependency — `package.json` had no CSV parser before this, and one file's worth of RFC 4180 handling was small enough to hand-roll, per this repo's stated preference (matching the query-plan-view/schema-designer/profiler precedent of avoiding new dependencies).
- `src/flat-file-import/index.ts` (`runFlatFileImportWizard()`) — the wizard flow: pick a file → parse + infer schema → prompt for a table name → open the generated `CREATE TABLE` DDL in an editor (mirrors `mock-data.ts`'s "generate then open" convention, for review/audit) → confirm → run that same DDL automatically (so the wizard completes end-to-end instead of requiring a separate manual step) → chunked (200 rows/`Driver.runBatch()` call) inserts under `vscode.window.withProgress`, using `Firebird.escape()` for value quoting (numeric/boolean columns get an unquoted literal from an actual JS number/boolean; everything else — including a row whose value doesn't actually match its column's sniffed type — gets a quoted, escaped string literal, letting Firebird implicitly `CAST` it or surfacing a clear per-statement error from `runBatch()`'s existing error isolation).
- Wired to `firebird.database.importFlatFile` (same command/menu-registration pattern as the other database-node actions) → `NodeDatabase.importFlatFile()`.
- Not unit-tested itself (VS Code dialog orchestration — same boundary this repo already draws for `node-database.ts`'s other wizard-style methods like `restoreDatabase()`); all its actual logic lives in the already-tested `flat-file-parser.ts`.

The pre-existing analogs below were the starting point but aren't reused directly — `mock-data.ts`'s INSERT-building/`createSQLTextDocument()` pattern is echoed, but this feature has its own parser rather than depending on Mockaroo or the LLM:

- `src/mock-data/mock-data.ts` — generates rows via the Mockaroo API, builds an `INSERT` via `Firebird.escape()`, opens it with `Driver.createSQLTextDocument()`. Good precedent for the "build INSERT statements, open as SQL" half of this feature, but it doesn't parse *user-supplied* data.
- The `/designSchema` Copilot command (`src/copilot/copilot-chat-participant.ts`) infers a `CREATE TABLE` from pasted sample data via the LLM — useful for schema *inference*, but it's chat-based, one-shot, and doesn't load the resulting data.
- Export already exists in the other direction: `src/result-view/` exports results to CSV/JSON/XLSX/PDF, so there's a reference for CSV formatting conventions/dependencies already in `package.json` worth reusing for parsing.

### Explicitly deferred (not done)

- **Phase 3 — map onto an existing table**: the wizard only creates a brand-new table today; column-mapping onto an existing table's schema isn't implemented.
- **Phase 4 — Copilot-assisted type/naming suggestions**: the type sniffer is fully local/deterministic (by design — a mechanical CSV-to-DDL inference shouldn't need an LLM round-trip, and the wizard must work without Copilot installed); no "suggest types" button calling the existing `/designSchema` prompt exists yet.
- **Large-file streaming**: the current implementation reads the whole file into memory and parses it in one pass (chunking only happens at the insert stage, not at parse/read time). Fine for typical flat-file sizes; a multi-GB CSV would need a streaming parser, which is a larger change than this pass's scope.

## Proposed feature

A guided multi-step wizard (VS Code `QuickPick`/`InputBox` steps, or a small webview if the column-mapping step needs a table UI):

1. **Pick a file** — CSV, TSV, or JSON (array of objects). Sniff delimiter and whether the first row is a header.
2. **Preview + infer types** — parse the first ~100 rows client-side, infer a Firebird column type per column (INTEGER/BIGINT/NUMERIC/VARCHAR/DATE/TIMESTAMP/BOOLEAN), similar logic to what `/designSchema` currently delegates entirely to the LLM — for the wizard this should be a **local, deterministic** type-sniffer (no LLM round-trip needed for a mechanical CSV-to-DDL inference; save the LLM path for cases the user explicitly wants smarter naming/typing suggestions, and let the wizard optionally call the same Copilot prompt as a "suggest types" button rather than a hard dependency, since flat-file import must work without Copilot installed).
3. **Choose target** — create a new table (using the inferred DDL, editable before running) or map columns onto an existing table (reuse tree metadata already available to `NodeTable`).
4. **Load** — batch-insert the parsed rows via `Driver.runBatch()` (chunked, since Firebird has statement/parameter limits and large CSVs shouldn't be one giant multi-statement string) with a progress indicator (`vscode.window.withProgress`).

## Technical notes

- New pure module `src/shared/flat-file-parser.ts` (CSV/TSV/JSON parsing + type sniffing) — unit-testable like `sql-formatter.ts`, and it's the piece most worth getting right since it's shared with any future "paste sample data" improvements to `/designSchema`.
- No CSV parsing dependency currently exists in `package.json` — decide whether to hand-roll a minimal RFC 4180 CSV parser (repo has a stated preference for avoiding unnecessary abstractions/dependencies) or pull in a small, well-maintained library; either way keep it isolated behind the parser module so the choice is swappable.
- Large-file handling: stream/chunk rather than loading an entire multi-GB CSV into memory; cap the preview step's sample size regardless of file size.
- Reuse `Firebird.escape()`/parameterized inserts (whichever `NodeClient`/`NativeClient` already prefers for `runBatch`) rather than hand-building escaped SQL strings, to avoid injection/quoting bugs with arbitrary user data (dates, embedded quotes, unicode).

## Suggested phases

1. ~~Parser + type-sniffer module with unit tests (CSV first, JSON second).~~ — **done** (`flat-file-parser.ts`, CSV/TSV and JSON both).
2. ~~Wizard UI wired to "create new table" only, using `Driver.createSQLTextDocument()` for the DDL step (matches existing `mock-data.ts` precedent) then a batched insert.~~ — **done** (`flat-file-import/index.ts`).
3. Add "map onto existing table" mode.
4. Add the optional Copilot-assisted type/naming suggestion button.
