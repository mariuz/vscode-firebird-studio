import { window, ProgressLocation } from "vscode";
import { readFile } from "fs/promises";
import { basename, extname } from "path";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { logger } from "../logger/logger";
import {
  parseFlatFile, inferSchema, buildCreateTableDDL, buildInsertStatement, sanitizeIdentifier,
} from "../shared/flat-file-parser";

/** Rows per Driver.runBatch() call — keeps any one batch's SQL text and transaction count bounded for large files. */
const INSERT_CHUNK_SIZE = 200;

/**
 * Guided "create a new table from a CSV/TSV/JSON file" wizard (QuickPick/InputBox steps, per the
 * design doc — no webview needed for this phase). Only supports creating a brand-new table;
 * mapping onto an existing table is a later phase (see docs/roadmap/flat-file-import-wizard.md).
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

  let succeeded = 0;
  const errors: string[] = [];

  await window.withProgress(
    { location: ProgressLocation.Notification, title: `Importing into ${tableName}…`, cancellable: false },
    async progress => {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
        const sql = chunk.map(row => buildInsertStatement(tableName, schema, row)).join("\n");
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

  if (errors.length === 0) {
    logger.showInfo(`Imported ${succeeded} row(s) into ${tableName}.`);
    return;
  }
  logger.error(`Flat file import errors:\n${errors.join("\n")}`);
  logger.showError(
    `Imported ${succeeded} of ${rows.length} row(s) into ${tableName} — ${errors.length} row(s) failed. Check logs for details.`,
    ["Show Logs"]
  ).then(sel => {
    if (sel === "Show Logs") { logger.showOutput(); }
  });
}
