import {
  ExtensionContext, NotebookCell, NotebookCellOutput, NotebookCellOutputItem, NotebookController,
  NotebookDocument, notebooks, window,
} from "vscode";
import { BatchResult, Driver } from "../shared/driver";
import { ConnectionOptions } from "../interfaces";
import { Constants } from "../config";
import { logger } from "../logger/logger";
import { renderRowsAsMarkdown } from "../shared/notebook-render";

export const FIREBIRD_NOTEBOOK_TYPE = "firebird-notebook";
const CONTROLLER_ID = "firebird-sql-notebook-controller";

/**
 * notebook.uri -> the connection its cells run against. In-memory only for Phase 1 (not persisted
 * into the .fbnb file's metadata) — reopening a notebook re-prompts. Persisting this binding is
 * Phase 3 (see docs/roadmap/sql-notebooks.md); this map is deliberately small/session-scoped so
 * skipping persistence now doesn't require an incompatible metadata-shape change later.
 */
const boundConnections = new Map<string, ConnectionOptions>();

/** Drops a notebook's remembered connection (and the password it carries) once the notebook closes. */
export function forgetNotebookConnection(notebook: NotebookDocument): void {
  boundConnections.delete(notebook.uri.toString());
}

let executionOrder = 0;

export function createSqlNotebookController(context: ExtensionContext): NotebookController {
  const controller = notebooks.createNotebookController(CONTROLLER_ID, FIREBIRD_NOTEBOOK_TYPE, "Firebird SQL");
  controller.supportedLanguages = ["sql"];
  controller.supportsExecutionOrder = true;
  controller.executeHandler = (cells, notebook) => executeCells(cells, notebook, context, controller);
  return controller;
}

async function executeCells(
  cells: NotebookCell[], notebook: NotebookDocument, context: ExtensionContext, controller: NotebookController
): Promise<void> {
  for (const cell of cells) {
    await executeCell(cell, notebook, context, controller);
  }
}

async function executeCell(
  cell: NotebookCell, notebook: NotebookDocument, context: ExtensionContext, controller: NotebookController
): Promise<void> {
  const execution = controller.createNotebookCellExecution(cell);
  execution.executionOrder = ++executionOrder;
  execution.start(Date.now());

  try {
    const connectionOptions = await resolveNotebookConnection(notebook, context);
    if (!connectionOptions) {
      await execution.replaceOutput(new NotebookCellOutput([
        NotebookCellOutputItem.text("No connection selected — cell not run.", "text/plain"),
      ]));
      execution.end(false, Date.now());
      return;
    }

    const results = await Driver.runBatch(cell.document.getText(), connectionOptions);
    await execution.replaceOutput(results.map(r => new NotebookCellOutput([resultToOutputItem(r)])));
    execution.end(!results.some(r => r.error), Date.now());
  } catch (err: any) {
    logger.error(`Notebook cell execution failed: ${err?.message ?? err}`);
    await execution.replaceOutput(new NotebookCellOutput([
      NotebookCellOutputItem.error(err instanceof Error ? err : new Error(String(err?.message ?? err))),
    ]));
    execution.end(false, Date.now());
  }
}

function resultToOutputItem(result: BatchResult): NotebookCellOutputItem {
  if (result.error) {
    return NotebookCellOutputItem.error(new Error(result.error));
  }
  if (result.rows) {
    return NotebookCellOutputItem.text(renderRowsAsMarkdown(result.rows), "text/markdown");
  }
  return NotebookCellOutputItem.text(result.message ?? "Statement executed successfully.", "text/plain");
}

async function resolveNotebookConnection(
  notebook: NotebookDocument, context: ExtensionContext
): Promise<ConnectionOptions | undefined> {
  const key = notebook.uri.toString();
  const existing = boundConnections.get(key);
  if (existing) {
    return existing;
  }

  const connections = context.globalState.get<Record<string, ConnectionOptions>>(Constants.ConectionsKey, {});
  const items = Object.values(connections).map(c => ({
    label: c.embedded ? `[embedded] ${c.database}` : `${c.host}: ${c.database}`,
    detail: c.id,
    conn: c,
  }));
  if (items.length === 0) {
    logger.showError("No saved connections found. Add a connection before running a notebook cell.");
    return undefined;
  }

  const picked = await window.showQuickPick(items, { placeHolder: "Select a connection for this notebook" });
  if (!picked) {
    return undefined;
  }

  const resolved = await Driver.resolvePassword(picked.conn);
  boundConnections.set(key, resolved);
  return resolved;
}
