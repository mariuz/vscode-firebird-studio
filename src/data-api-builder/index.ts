import { window, workspace, ViewColumn } from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { getSchemaColumnsQuery, getForeignKeysQuery } from "../shared/queries";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from "../schema-designer/schema-graph";
import { buildOpenApiSpec } from "./openapi-spec";
import { logger } from "../logger/logger";
import { getDatabaseFileName } from "../shared/utils";

/**
 * Generates an OpenAPI 3.0 spec (one CRUD route set per table) from the connected schema and
 * opens it as a plain JSON document for review — Option A from the design doc, deliberately not
 * a bundled server the extension runs itself.
 */
export async function runDataApiSpecGenerator(connectionOptions: ConnectionOptions): Promise<void> {
  const sql = `${getSchemaColumnsQuery()}\n${getForeignKeysQuery()}`;

  let results;
  try {
    results = await Driver.runBatch(sql, connectionOptions);
  } catch (err: any) {
    logger.error(`Data API spec generation failed: ${err?.message ?? err}`);
    logger.showError(`Could not read the schema: ${err?.message ?? err}`);
    return;
  }

  const [columnsResult, fkResult] = results;
  if (columnsResult?.error) {
    logger.showError(`Could not read the schema: ${columnsResult.error}`);
    return;
  }
  if (fkResult?.error) {
    logger.showError(`Could not read foreign keys: ${fkResult.error}`);
    return;
  }

  const graph = buildSchemaGraph(
    (columnsResult?.rows ?? []) as SchemaColumnRow[],
    (fkResult?.rows ?? []) as ForeignKeyRow[]
  );
  if (graph.tables.length === 0) {
    logger.showError("No tables found in this database — nothing to generate a Data API spec for.");
    return;
  }

  const spec = buildOpenApiSpec(graph, { title: `${getDatabaseFileName(connectionOptions.database)} Data API` });
  const content = JSON.stringify(spec, null, 2);

  const doc = await workspace.openTextDocument({ content, language: "json" });
  await window.showTextDocument(doc, ViewColumn.Beside);
  logger.showInfo(`Generated a Data API spec for ${graph.tables.length} table(s). Review it, then hand it to your own REST/GraphQL backend — this extension doesn't run a server itself.`);
}
