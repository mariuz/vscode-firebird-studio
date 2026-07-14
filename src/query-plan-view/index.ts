import * as vscode from "vscode";
import { join } from "path";
import { readFile } from "fs/promises";
import { QueryResultsView, Message } from "../result-view/queryResultsView";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { parsePlan, PlanNode } from "../shared/plan-parser";
import { logger } from "../logger/logger";

/**
 * Prefixes NativeClient/NodeClient's getQueryPlan() uses for its "this isn't a real plan"
 * fallback text (see driver.ts) — not real Firebird plan syntax, so parsePlan() would just throw
 * on it anyway, but checking first lets this show a clearer, more actionable message.
 */
const FALLBACK_PREFIXES = ["-- PLAN not available", "-- Firebird Index Metadata"];

/**
 * Graphical execution-plan viewer: parses Firebird's legacy `PLAN (...)` syntax
 * (`src/shared/plan-parser.ts`) and renders it as a node diagram, in place of dumping the plan
 * as plain text into an editor (which `firebird.explainPlan` still does, unchanged). Phases 2
 * and (partially) 5 of `docs/roadmap/query-plan-visualizer.md` — estimated plan only, no
 * actual-plan monitoring overlay, result-view tab integration, or Copilot analysis yet (see that
 * doc for what's deferred and why).
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
    if (FALLBACK_PREFIXES.some(prefix => planText.startsWith(prefix))) {
      this.send({
        command: "planData",
        data: {
          error: 'Graphical plans need the native driver. Enable "firebird.useNativeDriver" in settings, then try again.',
          raw: planText
        }
      });
      return;
    }

    let blocks: PlanNode[];
    try {
      blocks = parsePlan(planText);
    } catch (err: any) {
      this.send({
        command: "planData",
        data: { error: `Couldn't parse the plan: ${err?.message ?? err}`, raw: planText }
      });
      return;
    }
    this.send({ command: "planData", data: { blocks, raw: planText, importedFrom } });
  }
}
