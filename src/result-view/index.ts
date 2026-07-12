import { Disposable, window } from "vscode";
import { TextDecoder } from "util";
import { join } from "path";

import { QueryResultsView, Message } from "./queryResultsView";
import { BatchResult, Driver, extractTableNames } from "../shared/driver";
import { getPrimaryKeyColumnsQuery } from "../shared/queries";
import { RowChange, buildStatementForChange } from "../shared/row-edit";
import { logger } from "../logger/logger";
import { getOptions } from "../config";

type ResultSet = Array<any>;

/** Shape of a single result-set payload sent to the webview. */
export interface PreparedResultSet {
  sql: string;
  tableHeader: { title: string }[];
  tableBody: string[][];
  rowCount: number;
  durationMs: number;
  message?: string;
  error?: string;
  /** Table name auto-detected from the statement's FROM clause, pre-filled for row editing. */
  editableTable?: string;
}

/** Payload for the "applyChanges" message sent from the webview's edit toolbar. */
interface ApplyChangesRequest {
  requestId: string;
  tableName: string;
  columns: string[];
  changes: RowChange[];
}

export default class ResultView extends QueryResultsView implements Disposable {
  private resultSet?: ResultSet;
  private resultTableName?: string;
  private batchResults?: PreparedResultSet[];
  private recordsPerPage!: string;

  constructor(private extensionPath: string) {
    super("resultview", "Firebird Query Results");
  }

  /** Display a single (legacy) result set. `tableName`, when known, pre-fills row editing. */
  display(resultSet: any, recordsPerPage: string, tableName?: string) {
    this.resultSet = resultSet;
    this.resultTableName = tableName;
    this.batchResults = undefined;
    this.recordsPerPage = recordsPerPage;
    this.show(join(this.extensionPath, "src", "result-view", "htmlContent", "index.html"));
  }

  /** Display results from a batch run (multiple statements). */
  displayBatch(batchResults: BatchResult[], recordsPerPage: string) {
    this.batchResults = batchResults.map(r => this.prepareBatchResult(r));
    this.resultSet = undefined;
    this.recordsPerPage = recordsPerPage;
    this.show(join(this.extensionPath, "src", "result-view", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    if (message.command === "getData") {
      const shortcuts = getOptions().shortcuts;
      if (this.batchResults) {
        this.send({
          command: "batchData",
          data: { results: this.batchResults, recordsPerPage: this.recordsPerPage, shortcuts },
        });
      } else {
        const data = this.resultSet
          ? { ...this.getPreparedResults(), editableTable: this.resultTableName, shortcuts }
          : { tableHeader: [], tableBody: [], recordsPerPage: this.recordsPerPage, shortcuts };
        this.send({ command: "message", data });
      }
      return;
    }

    if (message.command === "getPrimaryKey") {
      this.handleGetPrimaryKey(message.data as { requestId: string; tableName: string });
      return;
    }

    if (message.command === "applyChanges") {
      this.handleApplyChanges(message.data as ApplyChangesRequest);
      return;
    }
  }

  /** Looks up a table's primary key columns, for targeting UPDATE/DELETE at a single row. */
  private async handleGetPrimaryKey(data: { requestId: string; tableName: string }): Promise<void> {
    const columns = await this.fetchPrimaryKeyColumns(data.tableName);
    this.send({ command: "primaryKey", data: { requestId: data.requestId, columns } });
  }

  private async fetchPrimaryKeyColumns(tableName: string): Promise<string[]> {
    if (!tableName) {
      return [];
    }
    try {
      const rows = await Driver.runQuery(getPrimaryKeyColumnsQuery(tableName));
      return (rows ?? []).map((r: any) => (r.FIELD_NAME ?? "").toString().trim()).filter(Boolean);
    } catch (err) {
      logger.error(err);
      return [];
    }
  }

  /**
   * Builds and executes the SQL for a batch of pending row edits (update/insert/delete),
   * after an explicit confirmation, and reports the outcome via a native notification.
   */
  private async handleApplyChanges(data: ApplyChangesRequest): Promise<void> {
    const { requestId, tableName, columns, changes } = data;

    if (!tableName) {
      logger.showError("Enter a table name before applying changes.");
      this.send({ command: "applyResult", data: { requestId, cancelled: true } });
      return;
    }
    if (!changes || changes.length === 0) {
      this.send({ command: "applyResult", data: { requestId, cancelled: true } });
      return;
    }

    const counts = { update: 0, insert: 0, delete: 0 };
    changes.forEach(c => counts[c.type]++);
    const summary = ([
      counts.update ? `${counts.update} update(s)` : null,
      counts.insert ? `${counts.insert} insert(s)` : null,
      counts.delete ? `${counts.delete} delete(s)` : null,
    ].filter(Boolean) as string[]).join(", ");

    const answer = await window.showWarningMessage(
      `Apply ${summary} to ${tableName}?`,
      { modal: true },
      "Apply"
    );
    if (answer !== "Apply") {
      this.send({ command: "applyResult", data: { requestId, cancelled: true } });
      return;
    }

    const pkColumns = await this.fetchPrimaryKeyColumns(tableName);

    const results: { changeIndex: number; sql: string; error?: string }[] = [];
    for (let i = 0; i < changes.length; i++) {
      let sql = "";
      try {
        sql = buildStatementForChange(tableName, columns, pkColumns, changes[i]);
        await Driver.runQuery(sql);
        results.push({ changeIndex: i, sql });
      } catch (err: any) {
        results.push({ changeIndex: i, sql, error: err?.message ?? String(err) });
        logger.error(`Row edit failed: ${sql || "(could not build statement)"} -> ${err?.message ?? err}`);
      }
    }

    const failed = results.filter(r => r.error);
    if (failed.length === 0) {
      logger.showInfo(`Applied ${results.length} change(s) to ${tableName}. Re-run the query to see the updated data.`);
    } else {
      logger.showError(
        `${failed.length} of ${results.length} change(s) to ${tableName} failed. Check logs for details.`,
        ["Show Logs"]
      ).then(sel => {
        if (sel === "Show Logs") {
          logger.showOutput();
        }
      });
    }

    this.send({ command: "applyResult", data: { requestId, results } });
  }

  /* prepare results before displaying */
  private getPreparedResults(): object {
    const decoder = new TextDecoder();
    const tableHeader: object[] = [];
    const tableBody: string[][] = [];

    if (!this.resultSet || this.resultSet.length === 0) {
      return { tableHeader: [], tableBody: [], recordsPerPage: this.recordsPerPage };
    }
    for (const field in this.resultSet[0]) {
      if (Object.prototype.hasOwnProperty.call(this.resultSet[0], field)) {
        tableHeader.push({ title: field });
      }
    }
    this.resultSet.forEach(row => {
      tableBody.push(encodeRow(row, decoder));
    });
    return { tableHeader, tableBody, recordsPerPage: this.recordsPerPage };
  }

  private prepareBatchResult(r: BatchResult): PreparedResultSet {
    const decoder = new TextDecoder();
    const editableTable = extractTableNames(r.sql)[0];
    const label = r.sql.replace(/\s+/g, " ").trim();
    const sql = label.length > 80 ? label.slice(0, 77) + "..." : label;

    if (r.error) {
      return { sql, tableHeader: [], tableBody: [], rowCount: 0, durationMs: r.durationMs, error: r.error };
    }
    if (r.message || !r.rows || r.rows.length === 0) {
      return { sql, tableHeader: [], tableBody: [], rowCount: 0, durationMs: r.durationMs, message: r.message };
    }

    const tableHeader = Object.keys(r.rows[0]).map(f => ({ title: f }));
    const tableBody = r.rows.map(row => encodeRow(row, decoder));
    return { sql, tableHeader, tableBody, rowCount: r.rows.length, durationMs: r.durationMs, editableTable };
  }
}

function encodeRow(row: any, decoder: TextDecoder): string[] {
  return Object.keys(row).map(field => {
    const v = row[field];
    if (v === null || v === undefined) { return "&lt;null&gt;"; }
    if (v instanceof Buffer) { return decoder.decode(v); }
    if (Object.prototype.toString.call(v) === "[object Date]") { return new Date(v).toLocaleDateString(); }
    if (typeof v === "object") { return JSON.stringify(v, null, "\t"); }
    return v.toString();
  });
}
