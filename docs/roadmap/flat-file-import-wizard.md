# Flat File Import Wizard

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Flat File Import ("Import flat files (CSV, TXT) as new database tables using a guided wizard").

## Current state in Firebird Studio

There is no CSV/flat-file **import** anywhere in the repo today (confirmed: no CSV/XLSX parsing dependency, no import code in `src/mock-data/` or elsewhere). The closest analogs:

- `src/mock-data/mock-data.ts` — generates rows via the Mockaroo API, builds an `INSERT` via `Firebird.escape()`, opens it with `Driver.createSQLTextDocument()`. Good precedent for the "build INSERT statements, open as SQL" half of this feature, but it doesn't parse *user-supplied* data.
- The `/designSchema` Copilot command (`src/copilot/copilot-chat-participant.ts`) infers a `CREATE TABLE` from pasted sample data via the LLM — useful for schema *inference*, but it's chat-based, one-shot, and doesn't load the resulting data.
- Export already exists in the other direction: `src/result-view/` exports results to CSV/JSON/XLSX/PDF, so there's a reference for CSV formatting conventions/dependencies already in `package.json` worth reusing for parsing.

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

1. Parser + type-sniffer module with unit tests (CSV first, JSON second).
2. Wizard UI wired to "create new table" only, using `Driver.createSQLTextDocument()` for the DDL step (matches existing `mock-data.ts` precedent) then a batched insert.
3. Add "map onto existing table" mode.
4. Add the optional Copilot-assisted type/naming suggestion button.
