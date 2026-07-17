import { window, ProgressLocation, QuickPickItem } from "vscode";
import { readFile } from "fs/promises";
import { basename, extname } from "path";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { logger } from "../logger/logger";
import { getTablesQuery, tableInfoQuery } from "../shared/queries";
import {
  parseFlatFile, inferSchema, buildCreateTableDDL, buildInsertStatement, sanitizeIdentifier,
  autoMapColumns, buildInsertStatementForMapping, ColumnMapping, FirebirdColumnMeta,
} from "../shared/flat-file-parser";

/** Rows per Driver.runBatch() call — keeps any one batch's SQL text and transaction count bounded for large files. */
const INSERT_CHUNK_SIZE = 200;

const SKIP_COLUMN = "— Skip this column —";

/**
 * Guided "import a CSV/TSV/JSON file into a Firebird table" wizard (QuickPick/InputBox steps, per
 * the design doc — no webview needed for this phase). Forks after parsing into two target modes:
 * create a brand-new table (phase 2) or map columns onto an already-existing table (phase 3) —
 * see docs/roadmap/flat-file-import-wizard.md.
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

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err: any) {
    logger.showError(`Could not read ${fileName}: ${err?.message ?? err}`);
    return;
  }

  let headers: string[];
  let rows: string[][];
  try {
    ({ headers, rows } = parseFlatFile(fileName, text));
  } catch (err: any) {
    logger.showError(`Could not parse ${fileName}: ${err?.message ?? err}`);
    return;
  }
  if (headers.length === 0 || rows.length === 0) {
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
    await importIntoNewTable(fileName, headers, rows, connectionOptions);
  } else {
    await importIntoExistingTable(fileName, headers, rows, connectionOptions);
  }
}

// ── Create a new table (phase 2) ─────────────────────────────────────────────

async function importIntoNewTable(
  fileName: string, headers: string[], rows: string[][], connectionOptions: ConnectionOptions
): Promise<void> {
  const schema = inferSchema(headers, rows);
  const defaultTableName = sanitizeIdentifier(basename(fileName, extname(fileName)));

  const tableNameInput = await window.showInputBox({
    title: "Flat File Import — Table Name",
    prompt: `Create a new table for the ${rows.length} row(s) parsed from ${fileName}`,
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
    `Create table ${tableName} and import ${rows.length} row(s) from ${fileName}?`,
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

  const { succeeded, errors } = await runChunkedInsert(tableName, rows, connectionOptions, chunk =>
    chunk.map(row => buildInsertStatement(tableName, schema, row)).join("\n")
  );
  reportImportResult(tableName, rows.length, succeeded, errors);
}

// ── Map onto an existing table (phase 3) ─────────────────────────────────────

async function importIntoExistingTable(
  fileName: string, headers: string[], rows: string[][], connectionOptions: ConnectionOptions
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
    `Import ${rows.length} row(s) from ${fileName} into ${tableName}?`,
    { modal: true },
    "Import"
  );
  if (confirm !== "Import") {
    return;
  }

  const { succeeded, errors } = await runChunkedInsert(tableName, rows, connectionOptions, chunk =>
    chunk.map(row => buildInsertStatementForMapping(tableName, mapping, row)).join("\n")
  );
  reportImportResult(tableName, rows.length, succeeded, errors);
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

async function runChunkedInsert(
  tableName: string, rows: string[][], connectionOptions: ConnectionOptions, buildSql: (chunk: string[][]) => string
): Promise<{ succeeded: number; errors: string[] }> {
  let succeeded = 0;
  const errors: string[] = [];

  await window.withProgress(
    { location: ProgressLocation.Notification, title: `Importing into ${tableName}…`, cancellable: false },
    async progress => {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
        const sql = buildSql(chunk);
        const results = await Driver.runBatch(sql, connectionOptions);
        results.forEach((r, idx) => {
          if (r.error) {
            errors.push(`Row ${i + idx + 1}: ${r.error}`);
          } else {
            succeeded++;
          }
        });
        progress.report({
          message: `${Math.min(i + INSERT_CHUNK_SIZE, rows.length)} / ${rows.length} row(s)`,
          increment: (chunk.length / rows.length) * 100,
        });
      }
    }
  );

  return { succeeded, errors };
}

function reportImportResult(tableName: string, total: number, succeeded: number, errors: string[]): void {
  if (errors.length === 0) {
    logger.showInfo(`Imported ${succeeded} row(s) into ${tableName}.`);
    return;
  }
  logger.error(`Flat file import errors:\n${errors.join("\n")}`);
  logger.showError(
    `Imported ${succeeded} of ${total} row(s) into ${tableName} — ${errors.length} row(s) failed. Check logs for details.`,
    ["Show Logs"]
  ).then(sel => {
    if (sel === "Show Logs") { logger.showOutput(); }
  });
}
