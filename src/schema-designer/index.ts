import { Disposable } from "vscode";
import { join } from "path";
import { QueryResultsView, Message } from "../result-view/queryResultsView";
import { ConnectionOptions } from "../interfaces";
import { Driver, BatchResult } from "../shared/driver";
import { getSchemaColumnsQuery, getForeignKeysQuery, getAllPrimaryKeyConstraintNamesQuery } from "../shared/queries";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from "./schema-graph";
import { logger } from "../logger/logger";

/**
 * Webview merging the former read-only Schema Visualizer and single-table Table Designer into
 * one multi-table entity-relationship editor: view the whole database's tables/relationships,
 * add new tables/columns/foreign keys, and alter existing tables' columns and primary key —
 * always loading the full schema graph regardless of entry point (Firebird schemas here are
 * modest in size, and the visualizer this replaces already always loaded everything in one go).
 */
export class SchemaDesigner extends QueryResultsView implements Disposable {
  private dbDetails?: ConnectionOptions;
  /**
   * The webview can't reliably receive a postMessage() sent immediately after show() — its
   * script may not have run yet. It posts a "ready" message once loaded; until then, what to
   * focus once the schema loads is held here and flushed from handleMessage() on "ready".
   */
  private pendingInit: Message | undefined;

  constructor(private readonly extensionPath: string) {
    super("schemadesigner", "Firebird Schema Designer");
  }

  /** Opens the designer showing the whole schema — was SchemaVisualizer.open(). */
  openFullSchema(dbDetails: ConnectionOptions): void {
    this.dbDetails = dbDetails;
    this.pendingInit = { command: "init", data: {} };
    this.showDesigner();
  }

  /** Opens the designer with a blank new table seeded and focused — was TableDesigner.open(). */
  openNewTable(dbDetails: ConnectionOptions): void {
    this.dbDetails = dbDetails;
    this.pendingInit = { command: "init", data: { addNewTable: true } };
    this.showDesigner();
  }

  /** Opens the designer with an existing table focused — was TableDesigner.openForAlter(). */
  openForAlterTable(dbDetails: ConnectionOptions, tableName: string): void {
    this.dbDetails = dbDetails;
    this.pendingInit = { command: "init", data: { focusTable: tableName } };
    this.showDesigner();
  }

  private showDesigner(): void {
    super.show(join(this.extensionPath, "src", "schema-designer", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    const { command, data } = message as Message & { data: { ddl?: string } };
    if (command === "ready") {
      if (this.pendingInit) {
        this.send(this.pendingInit);
        this.pendingInit = undefined;
      }
      return;
    }
    if (command === "getData" || command === "refresh") {
      this.fetchAndSend().catch(err => logger.error(err));
      return;
    }
    if (command === "openInEditor") {
      Driver.createSQLTextDocument(data.ddl ?? "").catch(err => logger.error(err));
      return;
    }
    if (command === "executeDDL") {
      this.executeDDL(data.ddl ?? "");
    }
  }

  private async fetchAndSend(): Promise<void> {
    if (!this.dbDetails) {
      this.send({ command: "schemaData", data: { error: "No active database connection." } });
      return;
    }
    try {
      // Three SELECTs over one connection (runBatch also resolves the connection's stored
      // password automatically, the same as every other Driver-backed query in the extension).
      const sql = `${getSchemaColumnsQuery()}\n${getForeignKeysQuery()}\n${getAllPrimaryKeyConstraintNamesQuery()}`;
      const results = await Driver.runBatch(sql, this.dbDetails);
      const [columnsResult, fkResult, pkResult] = results;
      if (columnsResult?.error) {
        throw new Error(columnsResult.error);
      }
      if (fkResult?.error) {
        throw new Error(fkResult.error);
      }
      if (pkResult?.error) {
        throw new Error(pkResult.error);
      }

      const graph = buildSchemaGraph(
        (columnsResult?.rows ?? []) as SchemaColumnRow[],
        (fkResult?.rows ?? []) as ForeignKeyRow[]
      );
      const pkConstraintNames: Record<string, string> = {};
      for (const row of (pkResult?.rows ?? []) as { TABLE_NAME: string; CONSTRAINT_NAME: string }[]) {
        pkConstraintNames[row.TABLE_NAME] = row.CONSTRAINT_NAME;
      }
      this.send({ command: "schemaData", data: { graph, pkConstraintNames } });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`Schema Designer fetch failed: ${message}`);
      this.send({ command: "schemaData", data: { error: message } });
    }
  }

  /**
   * Runs the generated DDL via Driver.runBatch() — not runQuery() — since it's routinely
   * multi-statement once more than one table is touched, and node-firebird's wire protocol only
   * prepares/executes one statement at a time.
   */
  private executeDDL(ddl: string): void {
    if (!this.dbDetails) {
      this.send({ command: "result", data: { text: "No active database connection." } });
      return;
    }
    Driver.runBatch(ddl, this.dbDetails)
      .then(results => {
        this.send({ command: "result", data: { text: summarizeBatchResults(results) } });
      })
      .catch(err => {
        const text = err?.message ?? String(err);
        logger.error(text);
        this.send({ command: "result", data: { text: `Error: ${text}` } });
      });
  }
}

/** One line per failed statement, plus a succeeded/failed count — shown in the webview's result panel. */
function summarizeBatchResults(results: BatchResult[]): string {
  const failed = results.filter(r => r.error);
  const lines = [`${results.length - failed.length} of ${results.length} statement(s) succeeded.`];
  failed.forEach(r => {
    const trimmed = r.sql.trim();
    const snippet = trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
    lines.push(`  ERROR (${snippet}): ${r.error}`);
  });
  return lines.join("\n");
}
