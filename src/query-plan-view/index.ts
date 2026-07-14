import * as vscode from "vscode";
import { join } from "path";
import { readFile } from "fs/promises";
import { QueryResultsView, Message } from "../result-view/queryResultsView";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { interpretPlanText } from "../shared/plan-parser";
import { logger } from "../logger/logger";

/**
 * Graphical execution-plan viewer: parses Firebird's legacy `PLAN (...)` syntax
 * (`src/shared/plan-parser.ts`) and renders it as a node diagram, in place of dumping the plan
 * as plain text into an editor (which `firebird.explainPlan` still does, unchanged). Phases 2 and
 * 5 of `docs/roadmap/query-plan-visualizer.md` are done; phase 4's result-view tab integration is
 * also done (see `ResultView`'s "Query Plan" tab) — this standalone panel remains for the
 * dedicated `firebird.showEstimatedPlan` command. No actual-plan monitoring overlay or Copilot
 * analysis yet (see that doc for what's deferred and why).
 */
export class QueryPlanView extends QueryResultsView implements vscode.Disposable {
  private sql?: string;
  private dbDetails?: ConnectionOptions;

  constructor(private readonly extensionPath: string) {
    super("queryplanview", "Firebird Query Plan");
  }

  /** Both args are optional — Driver.getQueryPlan() resolves from the active editor/active connection itself, same as firebird.explainPlan. */
  open(sql?: string, dbDetails?: ConnectionOptions): void {
    this.sql = sql;
    this.dbDetails = dbDetails;
    super.show(join(this.extensionPath, "src", "query-plan-view", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    if (message.command === "ready" || message.command === "refresh") {
      this.fetchAndSend().catch(err => logger.error(err));
    }
    if (message.command === "importPlan") {
      this.importFromFile().catch(err => logger.error(err));
    }
  }

  private async fetchAndSend(): Promise<void> {
    let planText: string;
    try {
      planText = await Driver.getQueryPlan(this.sql, this.dbDetails);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`Query plan view failed: ${message}`);
      this.send({ command: "planData", data: { error: message } });
      return;
    }
    this.parseAndSend(planText);
  }

  /**
   * "Import a saved plan" (phase 5): loads a plan previously saved as plain text (e.g. copied
   * from `firebird.explainPlan`'s output, or `isql`'s `SET PLANONLY ON`) and renders it with no
   * live connection needed — reuses the exact same parse/fallback-detection path as a live fetch
   * so an imported plan behaves identically to one just fetched.
   */
  private async importFromFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      title: "Import Query Plan",
      canSelectMany: false,
      filters: { "Plan / Text": ["txt", "plan", "sql"], "All files": ["*"] },
    });
    if (!uris || uris.length === 0) {
      return;
    }
    const filePath = uris[0].fsPath;
    let planText: string;
    try {
      planText = await readFile(filePath, "utf8");
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`Query plan import failed: ${message}`);
      this.send({ command: "planData", data: { error: `Couldn't read the file: ${message}` } });
      return;
    }
    this.parseAndSend(planText, filePath);
  }

  /** Shared by both a live fetch and a file import: fallback-text detection, parsing, and error reporting. */
  private parseAndSend(planText: string, importedFrom?: string): void {
    const result = interpretPlanText(planText);
    if ("error" in result) {
      this.send({ command: "planData", data: { error: result.error, raw: result.raw } });
      return;
    }
    this.send({ command: "planData", data: { blocks: result.blocks, raw: result.raw, importedFrom } });
  }
}
