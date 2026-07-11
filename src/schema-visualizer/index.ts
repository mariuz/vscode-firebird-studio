import { Disposable } from "vscode";
import { join } from "path";
import { QueryResultsView, Message } from "../result-view/queryResultsView";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { getSchemaColumnsQuery, getForeignKeysQuery } from "../shared/queries";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from "./schema-graph";
import { logger } from "../logger/logger";

/**
 * Webview panel showing an entity-relationship diagram (tables, columns, primary keys, and
 * foreign key relationships) for a whole database — similar to Microsoft's PostgreSQL extension
 * "Visualize Schema" feature. Firebird has no separate schema/catalog concept the way PostgreSQL
 * does, so unlike that feature this always shows the full database rather than one schema at a
 * time.
 */
export class SchemaVisualizer extends QueryResultsView implements Disposable {
  private dbDetails?: ConnectionOptions;

  constructor(private readonly extensionPath: string) {
    super("schemavisualizer", "Firebird Schema Visualizer");
  }

  open(dbDetails: ConnectionOptions) {
    this.dbDetails = dbDetails;
    super.show(join(this.extensionPath, "src", "schema-visualizer", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    if (message.command === "getData" || message.command === "refresh") {
      this.fetchAndSend().catch(err => logger.error(err));
    }
  }

  private async fetchAndSend(): Promise<void> {
    if (!this.dbDetails) {
      this.send({ command: "schemaData", data: { error: "No active database connection." } });
      return;
    }
    try {
      // Two SELECTs over one connection (runBatch also resolves the connection's stored
      // password automatically, the same as every other Driver-backed query in the extension).
      const sql = `${getSchemaColumnsQuery()}\n${getForeignKeysQuery()}`;
      const results = await Driver.runBatch(sql, this.dbDetails);
      const [columnsResult, fkResult] = results;
      if (columnsResult?.error) {
        throw new Error(columnsResult.error);
      }
      if (fkResult?.error) {
        throw new Error(fkResult.error);
      }
      const graph = buildSchemaGraph(
        (columnsResult?.rows ?? []) as SchemaColumnRow[],
        (fkResult?.rows ?? []) as ForeignKeyRow[]
      );
      this.send({ command: "schemaData", data: { graph } });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`Schema visualizer fetch failed: ${message}`);
      this.send({ command: "schemaData", data: { error: message } });
    }
  }
}
