import { window, QuickPickItem } from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { getOptions } from "../config";
import {
  getTablesQuery, getViewsQuery, getStoredProceduresQuery, getTriggersQuery,
  getGeneratorsQuery, getDomainsQuery, generatorCurrentValueQuery,
} from "../shared/queries";
import { NodeTable, NodeView, NodeProcedure, NodeTrigger, NodeDomain } from "../nodes";
import { buildSearchIndex, kindLabel, SearchResult } from "./search-model";
import { logger } from "../logger/logger";
import type QueryResultsView from "../result-view";

interface SearchQuickPickItem extends QuickPickItem {
  result: SearchResult;
}

/**
 * Fuzzy-searches every table/view/procedure/trigger/generator/domain in a connection by name
 * (VS Code's own QuickPick filtering already fuzzy-matches as you type) and jumps straight to
 * that object's most useful existing action — reusing NodeTable/NodeView/.../s own methods rather
 * than duplicating their logic, so there's exactly one place each object type's "primary action"
 * is implemented.
 */
export async function runObjectSearch(connectionOptions: ConnectionOptions, firebirdQueryResults: QueryResultsView): Promise<void> {
  const sql = [
    getTablesQuery(0), getViewsQuery(), getStoredProceduresQuery(), getTriggersQuery(), getGeneratorsQuery(), getDomainsQuery(),
  ].join("\n");

  let results;
  try {
    results = await Driver.runBatch(sql, connectionOptions);
  } catch (err: any) {
    logger.error(`Object Search failed: ${err?.message ?? err}`);
    logger.showError(`Could not search objects: ${err?.message ?? err}`);
    return;
  }

  for (const r of results) {
    if (r?.error) {
      logger.showError(`Could not search objects: ${r.error}`);
      return;
    }
  }
  const [tablesResult, viewsResult, proceduresResult, triggersResult, generatorsResult, domainsResult] = results;

  const index = buildSearchIndex({
    tables: tablesResult?.rows ?? [],
    views: viewsResult?.rows ?? [],
    procedures: proceduresResult?.rows ?? [],
    triggers: triggersResult?.rows ?? [],
    generators: generatorsResult?.rows ?? [],
    domains: domainsResult?.rows ?? [],
  });

  if (index.length === 0) {
    logger.showInfo("No tables, views, procedures, triggers, generators, or domains found in this database.");
    return;
  }

  const items: SearchQuickPickItem[] = index.map(result => ({
    label: result.name,
    description: kindLabel(result.kind),
    result,
  }));

  const picked = await window.showQuickPick(items, {
    title: "Search Objects",
    placeHolder: "Search tables, views, procedures, triggers, generators, and domains by name...",
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }

  await runPrimaryAction(picked.result, connectionOptions, firebirdQueryResults);
}

/** Table/view -> select all records (into the results grid); procedure/trigger/domain -> open an editable ALTER scaffold; generator -> a read-only current-value peek (it has no other non-destructive inspection action). */
async function runPrimaryAction(
  result: SearchResult, connectionOptions: ConnectionOptions, firebirdQueryResults: QueryResultsView
): Promise<void> {
  try {
    switch (result.kind) {
      case "TABLE": {
        const node = new NodeTable(connectionOptions, result.name);
        const rows = await node.selectAllRecords();
        firebirdQueryResults.display(rows, getOptions().recordsPerPage, result.name);
        return;
      }
      case "VIEW": {
        const node = new NodeView(connectionOptions, result.name);
        const rows = await node.selectAllRecords();
        firebirdQueryResults.display(rows, getOptions().recordsPerPage, result.name);
        return;
      }
      case "PROCEDURE": {
        const node = new NodeProcedure(connectionOptions, result.name);
        await node.editProcedure();
        return;
      }
      case "TRIGGER": {
        const node = new NodeTrigger(result.row, connectionOptions);
        await node.editTrigger();
        return;
      }
      case "DOMAIN": {
        const node = new NodeDomain(result.row, connectionOptions);
        await node.alterDomain();
        return;
      }
      case "GENERATOR": {
        const rows = await Driver.runQuery(generatorCurrentValueQuery(result.name), connectionOptions);
        firebirdQueryResults.display(rows, getOptions().recordsPerPage);
        return;
      }
    }
  } catch (err: any) {
    logger.error(`Object Search action failed: ${err?.message ?? err}`);
    logger.showError(`Could not open ${result.name}: ${err?.message ?? err}`);
  }
}
