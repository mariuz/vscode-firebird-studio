import {
  window, ProgressLocation, QuickPickItem, lm, LanguageModelChatMessage, CancellationTokenSource, CancellationError,
} from "vscode";
import { readFile } from "fs/promises";
import { basename, extname } from "path";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { logger } from "../logger/logger";
import { getTablesQuery, tableInfoQuery } from "../shared/queries";
import { extractJson } from "../copilot/json-extraction";
import {
  detectFormat, detectDelimiterFromFile, parseJsonRows, readDelimitedPreview, streamDataRows,
  inferSchema, buildCreateTableDDL, buildInsertStatement, sanitizeIdentifier,
  autoMapColumns, buildInsertStatementForMapping, ColumnMapping, FirebirdColumnMeta, ColumnInference,
} from "../shared/flat-file-parser";

/** Rows per Driver.runBatch() call — keeps any one batch's SQL text and transaction count bounded for large files. */
const INSERT_CHUNK_SIZE = 200;

/**
 * Matches inferSchema()'s own default sample size — there's no value in a preview reading further
 * than what schema inference/the mapping preview actually look at. A CSV/TSV file with more data
 * rows than this switches the actual import (not the preview) to the streaming path below, rather
 * than ever holding the whole file's rows array in memory (docs/roadmap/flat-file-import-wizard.md's
 * "Large-file streaming" item) — JSON isn't covered by this pass (see runFlatFileImportWizard()'s
 * doc comment for why), so a huge JSON file still reads entirely into memory as before.
 */
const PREVIEW_ROW_CAP = 200;

const SKIP_COLUMN = "— Skip this column —";

/**
 * Where the wizard reads a file's *complete* row set from at import time — the bounded preview
 * sample above is never enough on its own once a file has more rows than PREVIEW_ROW_CAP.
 * "array" is the whole-file-already-in-memory case (JSON always; CSV/TSV when the file turned out
 * small enough that the preview read already reached end-of-file); "stream" re-opens the file from
 * disk and walks it row-by-row without ever materializing the full array.
 */
type ImportSource =
  | { kind: "array"; rows: string[][] }
  | { kind: "stream"; filePath: string; delimiter: string };

function knownRowCount(source: ImportSource): number | undefined {
  return source.kind === "array" ? source.rows.length : undefined;
}

function rowCountPhrase(count: number | undefined): string {
  return count !== undefined ? `${count} row(s)` : "the file's rows";
}

/**
 * Guided "import a CSV/TSV/JSON file into a Firebird table" wizard (QuickPick/InputBox steps, per
 * the design doc — no webview needed for this phase). Forks after parsing into two target modes:
 * create a brand-new table (phase 2) or map columns onto an already-existing table (phase 3) —
 * see docs/roadmap/flat-file-import-wizard.md.
 *
 * CSV/TSV files are only ever read as a bounded preview sample here — the actual complete row set
 * (for the "create table" DDL's INSERTs, or the "map onto existing table" INSERTs) is read via a
 * fresh streaming pass at import time (see ImportSource), so this wizard never holds a large CSV/
 * TSV file's full contents in memory at once. JSON isn't covered by this pass: a JSON array of
 * objects doesn't line up with a byte-chunk boundary the way delimited text does (a `"`, `{`, or
 * `}` can appear anywhere), so a *correct* streaming JSON parser is a meaningfully bigger, riskier
 * lift than delimited-text streaming turned out to be — deliberately out of scope here, and still
 * disclosed as a remaining gap in docs/roadmap/flat-file-import-wizard.md. A huge JSON file still
 * reads entirely into memory, exactly as it always has.
 */
export async function runFlatFileImportWizard(connectionOptions: ConnectionOptions): Promise<void> {
  const openUris = await window.showOpenDialog({
    title: "Select a CSV, TSV, or JSON file to import",
    filters: { "Data files": ["csv", "tsv", "json", "txt"], "All files": ["*"] },
    canSelectMany: false,
  });
  if (!openUris || openUris.length === 0) {
    return;
  }
  const filePath = openUris[0].fsPath;
  const fileName = basename(filePath);
  const format = detectFormat(fileName);

  let headers: string[];
  let previewRows: string[][];
  let source: ImportSource;

  if (format === "json") {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err: any) {
      logger.showError(`Could not read ${fileName}: ${err?.message ?? err}`);
      return;
    }
    let rows: string[][];
    try {
      ({ headers, rows } = parseJsonRows(text));
    } catch (err: any) {
      logger.showError(`Could not parse ${fileName}: ${err?.message ?? err}`);
      return;
    }
    previewRows = rows;
    source = { kind: "array", rows };
  } else {
    const delimiter = format === "tsv" ? "\t" : await detectDelimiterFromFile(filePath);
    let preview: { headers: string[]; rows: string[][]; truncated: boolean };
    try {
      preview = await readDelimitedPreview(filePath, delimiter, PREVIEW_ROW_CAP);
    } catch (err: any) {
      logger.showError(`Could not read ${fileName}: ${err?.message ?? err}`);
      return;
    }
    headers = preview.headers;
    previewRows = preview.rows;
    // The preview read already reached end-of-file for a small/typical file (fewer than
    // PREVIEW_ROW_CAP data rows) — reuse that already-in-memory sample instead of re-opening and
    // re-streaming the file a second time for no benefit.
    source = preview.truncated
      ? { kind: "stream", filePath, delimiter }
      : { kind: "array", rows: preview.rows };
  }

  if (headers.length === 0 || previewRows.length === 0) {
    logger.showError(`${fileName} has no data to import.`);
    return;
  }

  const target = await window.showQuickPick(
    [
      { label: "Create a new table", detail: "Infers column types from the file and generates a CREATE TABLE statement.", target: "new" as const },
      { label: "Map onto an existing table", detail: "Matches file columns onto an already-existing table's columns.", target: "existing" as const },
    ],
    { title: `Flat File Import — ${fileName}`, placeHolder: "Where should this data go?" }
  );
  if (!target) {
    return;
  }

  if (target.target === "new") {
    await importIntoNewTable(fileName, headers, previewRows, source, connectionOptions);
  } else {
    await importIntoExistingTable(fileName, headers, source, connectionOptions);
  }
}

// ── Create a new table (phase 2) ─────────────────────────────────────────────

async function importIntoNewTable(
  fileName: string, headers: string[], previewRows: string[][], source: ImportSource, connectionOptions: ConnectionOptions
): Promise<void> {
  let schema = inferSchema(headers, previewRows);
  const defaultTableName = sanitizeIdentifier(basename(fileName, extname(fileName)));
  const rowCount = knownRowCount(source);

  // Phase 4 (docs/roadmap/flat-file-import-wizard.md): the type sniffer above is fully local/
  // deterministic by design — this step is optional, and skipping it (the default-first option)
  // costs nothing and needs no Copilot at all.
  const typeSourcePick = await window.showQuickPick(
    [
      { label: "Use inferred types", detail: "Fast, fully local — no Copilot needed.", useCopilot: false },
      { label: "Suggest types with Copilot", detail: "Sends column names, inferred types, and a few sample rows to Copilot for review.", useCopilot: true },
    ],
    { title: `Flat File Import — ${fileName}`, placeHolder: "How should column names/types be decided?" }
  );
  if (!typeSourcePick) {
    return;
  }
  if (typeSourcePick.useCopilot) {
    schema = await suggestTypesWithCopilot(fileName, schema, previewRows);
  }

  const tableNameInput = await window.showInputBox({
    title: "Flat File Import — Table Name",
    prompt: `Create a new table for ${rowCountPhrase(rowCount)} parsed from ${fileName}`,
    value: defaultTableName,
    validateInput: value => (value && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value.trim())) ? undefined : "Enter a valid table name",
  });
  if (!tableNameInput) {
    return;
  }
  const tableName = tableNameInput.trim().toUpperCase();

  const ddl = buildCreateTableDDL(tableName, schema);
  // Opened for review/audit — matches mock-data.ts's "generate then open in an editor" convention
  // — but the import still runs the exact same DDL automatically below, so the wizard completes
  // end-to-end rather than requiring the user to separately run it themselves.
  await Driver.createSQLTextDocument(ddl);

  const confirm = await window.showWarningMessage(
    `Create table ${tableName} and import ${rowCountPhrase(rowCount)} from ${fileName}?`,
    { modal: true },
    "Import"
  );
  if (confirm !== "Import") {
    return;
  }

  try {
    await Driver.runQuery(ddl, connectionOptions);
  } catch (err: any) {
    logger.error(`Flat file import: CREATE TABLE failed: ${err?.message ?? err}`);
    logger.showError(`Could not create table ${tableName}: ${err?.message ?? err}`, ["Show Logs"]).then(sel => {
      if (sel === "Show Logs") { logger.showOutput(); }
    });
    return;
  }

  const { succeeded, errors } = await runChunkedInsert(tableName, source, connectionOptions, chunk =>
    chunk.map(row => buildInsertStatement(tableName, schema, row)).join("\n")
  );
  reportImportResult(tableName, succeeded, errors);
}

// ── Copilot-assisted type/naming suggestions (phase 4) ───────────────────────
//
// Same "small structured JSON decision, deterministic code applies it" split already used by the
// Schema Designer's "Ask Copilot" panel and the Data API Builder's Copilot-assisted scoping — the
// model is asked for one name/sqlType/nullable triple per column index, never a raw CREATE TABLE
// statement, and buildCreateTableDDL() (already proven by the plain path above) turns the result
// into DDL. Only ever changes the "create new table" path — an existing table's real column types
// (phase 3) aren't something this wizard can change anyway, so there's nothing for Copilot to
// suggest there.

/** Sends the current inference + a handful of sample rows to Copilot and applies its suggestions, or falls back to the unchanged local inference if Copilot is unavailable, cancelled, or errors — this must never be a hard requirement for the wizard to work, per the design doc. */
async function suggestTypesWithCopilot(fileName: string, schema: ColumnInference[], rows: string[][]): Promise<ColumnInference[]> {
  const models = await lm.selectChatModels({ vendor: "copilot" });
  const model = models[0];
  if (!model) {
    logger.showError("No Copilot language model is available. Make sure GitHub Copilot Chat is installed and signed in. Using the locally-inferred types instead.");
    return schema;
  }

  const cts = new CancellationTokenSource();
  try {
    return await window.withProgress(
      { location: ProgressLocation.Notification, title: "Asking Copilot to suggest column names/types…", cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => cts.cancel());
        const messages = [LanguageModelChatMessage.User(buildTypeSuggestionPrompt(fileName, schema, rows))];
        const response = await model.sendRequest(messages, {}, cts.token);
        let text = "";
        for await (const fragment of response.text) {
          text += fragment;
        }
        return parseSuggestedSchema(text, schema);
      }
    );
  } catch (err: any) {
    if (err instanceof CancellationError) {
      return schema;
    }
    const message = err?.message ?? String(err);
    logger.error(`Flat file import Copilot type suggestion failed: ${message}`);
    logger.showError(`Copilot could not suggest types: ${message}. Using the locally-inferred types instead.`);
    return schema;
  }
}

/** Exported for testing. */
export function buildTypeSuggestionPrompt(fileName: string, schema: ColumnInference[], rows: string[][]): string {
  const columnsDescription = schema
    .map((c, i) => `  ${i}: header "${c.name}" -> inferred ${c.sqlType}${c.nullable ? " NULL" : " NOT NULL"}`)
    .join("\n");
  const sample = rows.slice(0, 5).map(r => r.join(", ")).join("\n");

  return [
    `You are helping refine a Firebird table schema mechanically inferred from a flat file ("${fileName}").`,
    "The inference already fits every sampled value, but it can't apply naming conventions or domain judgment the way a human would — e.g. a numeric-looking ZIP code or phone number should usually stay VARCHAR to preserve leading zeros/formatting, and a cryptic header could get a clearer name once you see the sample values.",
    "",
    `Columns (index: header -> current inference):\n${columnsDescription}`,
    "",
    `Sample rows (comma-separated, same column order as above):\n${sample}`,
    "",
    "For each column index, decide a possibly-improved column name and Firebird SQL type (e.g. VARCHAR(50), INTEGER, BIGINT, NUMERIC(10,2), DATE, TIMESTAMP, BOOLEAN) and whether it should allow NULL.",
    "You must return exactly one entry per column index above, in the same order — never add, remove, or reorder columns.",
    "If the current inference already looks right for a column, just repeat it back unchanged.",
    "Respond with ONLY a JSON object of this exact shape, no other text, no markdown fence:",
    '{"columns":[{"name":"CUSTOMER_ID","sqlType":"INTEGER","nullable":false}]}',
  ].join("\n");
}

/**
 * Exported for testing. Validates the model's response against the schema it was actually asked
 * about — a wrong column count is rejected outright (this wizard has no way to reconcile a
 * mismatched column count against the file's rows), and each entry falls back field-by-field to
 * the original inference for anything missing/malformed, rather than trusting the model's shape
 * blindly — the same "don't take a structured Copilot edit's own claims at face value" rule
 * applyCopilotEdit() (Schema Designer) and parseTableAccessResponse() (Data API Builder) both
 * already follow. A suggested name is still run through sanitizeIdentifier() — Copilot might
 * suggest something DDL-safe already, but this guarantees it regardless.
 */
export function parseSuggestedSchema(rawText: string, currentSchema: ColumnInference[]): ColumnInference[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    throw new Error(`Copilot didn't return valid JSON. Raw response:\n${rawText.slice(0, 500)}`);
  }

  const columns = (parsed as { columns?: unknown })?.columns;
  if (!Array.isArray(columns) || columns.length !== currentSchema.length) {
    throw new Error(
      `Copilot's response didn't have exactly ${currentSchema.length} column(s) in the expected {"columns": [...]} shape. Raw response:\n${rawText.slice(0, 500)}`
    );
  }

  return columns.map((entry, i) => {
    const fallback = currentSchema[i];
    const candidate = entry as { name?: unknown; sqlType?: unknown; nullable?: unknown };
    const name = typeof candidate.name === "string" && candidate.name.trim() ? sanitizeIdentifier(candidate.name, fallback.name) : fallback.name;
    const sqlType = typeof candidate.sqlType === "string" && candidate.sqlType.trim() ? candidate.sqlType.trim() : fallback.sqlType;
    const nullable = typeof candidate.nullable === "boolean" ? candidate.nullable : fallback.nullable;
    return { name, sqlType, nullable };
  });
}

// ── Map onto an existing table (phase 3) ─────────────────────────────────────

async function importIntoExistingTable(
  fileName: string, headers: string[], source: ImportSource, connectionOptions: ConnectionOptions
): Promise<void> {
  let tableRows: { TABLE_NAME: string }[];
  try {
    tableRows = await Driver.runQuery(getTablesQuery(0), connectionOptions);
  } catch (err: any) {
    logger.error(`Flat file import: could not list tables: ${err?.message ?? err}`);
    logger.showError(`Could not list tables: ${err?.message ?? err}`);
    return;
  }
  if (!tableRows || tableRows.length === 0) {
    logger.showError("This database has no existing tables to map onto — create a new table instead.");
    return;
  }

  const tablePick = await window.showQuickPick(
    tableRows.map(r => r.TABLE_NAME.trim()),
    { title: "Flat File Import — Target Table", placeHolder: "Select the existing table to import into" }
  );
  if (!tablePick) {
    return;
  }
  const tableName = tablePick;

  let targetColumns: FirebirdColumnMeta[];
  try {
    targetColumns = await Driver.runQuery(tableInfoQuery(tableName), connectionOptions);
  } catch (err: any) {
    logger.error(`Flat file import: could not read ${tableName}'s columns: ${err?.message ?? err}`);
    logger.showError(`Could not read ${tableName}'s columns: ${err?.message ?? err}`);
    return;
  }
  if (!targetColumns || targetColumns.length === 0) {
    logger.showError(`${tableName} has no columns.`);
    return;
  }

  let mapping = autoMapColumns(headers, targetColumns);

  const unmappedHeaders = headers.filter((_, i) => !mapping.some(m => m.sourceIndex === i));
  const preview = mapping
    .map(m => `${m.targetColumn}  ←  ${m.sourceIndex !== null ? headers[m.sourceIndex] : "(not mapped — table default/NULL)"}`)
    .join("\n");
  const unmappedNote = unmappedHeaders.length > 0
    ? `\n\nFile column(s) not used by this mapping: ${unmappedHeaders.join(", ")}`
    : "";

  const choice = await window.showInformationMessage(
    `Proposed mapping for ${tableName} (matched by column name):`,
    { modal: true, detail: `${preview}${unmappedNote}` },
    "Use This Mapping", "Customize Mapping"
  );
  if (!choice) {
    return;
  }
  if (choice === "Customize Mapping") {
    const customized = await customizeMapping(headers, mapping);
    if (!customized) {
      return; // user cancelled partway through
    }
    mapping = customized;
  }

  if (!mapping.some(m => m.sourceIndex !== null)) {
    logger.showError("No columns are mapped — nothing to import.");
    return;
  }

  const confirm = await window.showWarningMessage(
    `Import ${rowCountPhrase(knownRowCount(source))} from ${fileName} into ${tableName}?`,
    { modal: true },
    "Import"
  );
  if (confirm !== "Import") {
    return;
  }

  const { succeeded, errors } = await runChunkedInsert(tableName, source, connectionOptions, chunk =>
    chunk.map(row => buildInsertStatementForMapping(tableName, mapping, row)).join("\n")
  );
  reportImportResult(tableName, succeeded, errors);
}

/** Walks every target column, letting the user pick which file header (if any) feeds it — starting from the auto-matched mapping so the common case is mostly just confirming. Returns undefined if the user cancels (Escape) at any step. */
async function customizeMapping(headers: string[], mapping: ColumnMapping[]): Promise<ColumnMapping[] | undefined> {
  const result: ColumnMapping[] = [];

  for (const entry of mapping) {
    const usedElsewhere = new Set(result.filter(r => r.sourceIndex !== null).map(r => r.sourceIndex));
    const suggested = entry.sourceIndex;

    const items: (QuickPickItem & { headerIndex: number | null })[] = [
      { label: SKIP_COLUMN, headerIndex: null },
      ...headers
        .map((h, i) => ({ label: h, headerIndex: i }))
        .filter(item => item.headerIndex === suggested || !usedElsewhere.has(item.headerIndex))
        .map(item => item.headerIndex === suggested ? { ...item, label: `${item.label}  (suggested)` } : item),
    ];

    const picked = await window.showQuickPick(items, {
      title: `Flat File Import — Map "${entry.targetColumn}"`,
      placeHolder: "Which file column feeds this table column?",
    });
    if (!picked) {
      return undefined;
    }
    result.push({ ...entry, sourceIndex: picked.headerIndex });
  }

  return result;
}

// ── Shared: chunked insert + result reporting ────────────────────────────────

/**
 * Runs buildSql over every data row from `source` in INSERT_CHUNK_SIZE-row batches via
 * Driver.runBatch(), same as before this phase — the only thing that changed is where the rows
 * come from: an already-in-memory array (unchanged behavior, exact "X / Y row(s)" percentage
 * progress) or a streamed async iterable for a large CSV/TSV file, buffered one chunk at a time
 * and discarded immediately after each batch runs, so the full row set is never held in memory at
 * once. The streamed case can't show a percentage (the total isn't known until the stream ends),
 * so progress falls back to a running count instead.
 */
async function runChunkedInsert(
  tableName: string, source: ImportSource, connectionOptions: ConnectionOptions, buildSql: (chunk: string[][]) => string
): Promise<{ succeeded: number; errors: string[] }> {
  let succeeded = 0;
  const errors: string[] = [];
  let rowIndex = 0;
  const total = knownRowCount(source);

  const runChunk = async (chunk: string[][], progress: { report(v: { message?: string; increment?: number }): void }) => {
    const sql = buildSql(chunk);
    const results = await Driver.runBatch(sql, connectionOptions);
    results.forEach(r => {
      rowIndex++;
      if (r.error) {
        errors.push(`Row ${rowIndex}: ${r.error}`);
      } else {
        succeeded++;
      }
    });
    if (total !== undefined) {
      progress.report({ message: `${Math.min(rowIndex, total)} / ${total} row(s)`, increment: (chunk.length / total) * 100 });
    } else {
      progress.report({ message: `${rowIndex} row(s) imported so far…` });
    }
  };

  await window.withProgress(
    { location: ProgressLocation.Notification, title: `Importing into ${tableName}…`, cancellable: false },
    async progress => {
      if (source.kind === "array") {
        for (let i = 0; i < source.rows.length; i += INSERT_CHUNK_SIZE) {
          await runChunk(source.rows.slice(i, i + INSERT_CHUNK_SIZE), progress);
        }
        return;
      }

      let buffer: string[][] = [];
      for await (const row of streamDataRows(source.filePath, source.delimiter)) {
        buffer.push(row);
        if (buffer.length >= INSERT_CHUNK_SIZE) {
          await runChunk(buffer, progress);
          buffer = [];
        }
      }
      if (buffer.length > 0) {
        await runChunk(buffer, progress);
      }
    }
  );

  return { succeeded, errors };
}

function reportImportResult(tableName: string, succeeded: number, errors: string[]): void {
  if (errors.length === 0) {
    logger.showInfo(`Imported ${succeeded} row(s) into ${tableName}.`);
    return;
  }
  const total = succeeded + errors.length;
  logger.error(`Flat file import errors:\n${errors.join("\n")}`);
  logger.showError(
    `Imported ${succeeded} of ${total} row(s) into ${tableName} — ${errors.length} row(s) failed. Check logs for details.`,
    ["Show Logs"]
  ).then(sel => {
    if (sel === "Show Logs") { logger.showOutput(); }
  });
}
