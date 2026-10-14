import * as vscode from "vscode";
import { join } from "path";
import { QueryResultsView, Message } from "../result-view/queryResultsView";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { profilerActivityQuery, killAttachmentQuery, rollbackTransactionQuery } from "../shared/queries";
import { getOptions, PROFILER_DASHBOARD_TILES, MIN_PROFILER_POLL_INTERVAL_MS as MIN_POLL_INTERVAL_MS } from "../config";
import { logger } from "../logger/logger";

/**
 * Live connection/query activity monitor: polls MON$ tables on an interval and shows a
 * continuously refreshing table (delta rates like reads/sec are computed webview-side, from one
 * poll to the next). Phases 1+2 of `docs/roadmap/live-profiler.md` are done; phase 3 (filter/pin,
 * done webview-side) adds the "Kill"/"Rollback" actions handled below. Charted dashboard and
 * Queries/Sessions drill-down tabs are still not done (see that doc for what's deferred).
 *
 * Uses its own dedicated connection (created lazily, reused across polls, closed on dispose)
 * rather than going through Driver.runQuery()'s per-call connect/detach — so repeated polling
 * doesn't pay a fresh connection's cost every few seconds and never contends with the user's own
 * query execution or the connection pool.
 *
 * Polling itself lives entirely in the webview (a plain `setInterval` posting "refresh"): this
 * webview, unlike the results panel, keeps `retainContextWhenHidden: false` (overriding
 * `QueryResultsView`'s default `true`), so VS Code tears down its script the moment the panel is
 * hidden and re-runs it from scratch when shown again — which already gives "stop polling when
 * not visible, resume when shown" for free, with no extra lifecycle wiring needed here.
 */
export class ProfilerView extends QueryResultsView implements vscode.Disposable {
  protected override retainContextWhenHidden = false;
  private dbDetails?: ConnectionOptions;
  private connection?: unknown;
  /** Queued for the webview's first "ready" — see the ready/init handshake other webviews in this extension use. */
  private pendingInit: Message | undefined;
  private configListener: vscode.Disposable | undefined;

  constructor(private readonly extensionPath: string) {
    super("profiler", "Firebird Connection Profiler", "pulse");
  }

  /** What the webview needs from settings: its poll cadence and which dashboard tiles to draw. */
  static currentConfig(): { pollIntervalMs: number; dashboardTiles: string[] } {
    const options = getOptions();
    return { pollIntervalMs: options.profilerPollIntervalMs, dashboardTiles: options.profilerDashboardTiles };
  }

  open(dbDetails: ConnectionOptions): void {
    this.dbDetails = dbDetails;
    this.pendingInit = { command: "init", data: ProfilerView.currentConfig() };
    // The tile/refresh choices can be changed from Settings while the panel is open -- push them in
    // rather than leaving the panel on stale choices until it is reopened. Registered here and
    // dropped in dispose() rather than held for the instance's life: this one instance is reused
    // across panels, and dispose() runs every time a panel is closed.
    if (!this.configListener) {
      this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("firebird.profiler")) {
          this.send({ command: "config", data: ProfilerView.currentConfig() });
        }
      });
    }
    super.show(join(this.extensionPath, "src", "profiler", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    if (message.command === "ready") {
      if (this.pendingInit) {
        this.send(this.pendingInit);
        this.pendingInit = undefined;
      }
      return;
    }
    if (message.command === "refresh") {
      this.pollOnce().catch(err => logger.error(err));
    }
    if (message.command === "setPollInterval") {
      const ms = Number((message.data as { pollIntervalMs: unknown })?.pollIntervalMs);
      if (Number.isFinite(ms) && ms >= MIN_POLL_INTERVAL_MS) {
        ProfilerView.saveSetting("pollIntervalMs", Math.round(ms));
      }
    }
    if (message.command === "setDashboardTiles") {
      const tiles = (message.data as { tiles: unknown })?.tiles;
      if (Array.isArray(tiles)) {
        const known = new Set<string>(PROFILER_DASHBOARD_TILES);
        ProfilerView.saveSetting("dashboardTiles", tiles.filter(t => typeof t === "string" && known.has(t)));
      }
    }
    if (message.command === "killAttachment") {
      const { attachmentId, label } = message.data as { attachmentId: number; label: string };
      this.runAdminAction(
        `Force-detach connection ${label}? Any uncommitted work on it will be rolled back.`,
        "Kill Connection",
        () => killAttachmentQuery(attachmentId)
      );
    }
    if (message.command === "rollbackTransaction") {
      const { transactionId, label } = message.data as { transactionId: number; label: string };
      this.runAdminAction(
        `Roll back transaction ${transactionId} on connection ${label}?`,
        "Rollback Transaction",
        () => rollbackTransactionQuery(transactionId)
      );
    }
  }

  /**
   * Writes a `firebird.profiler.*` setting at the scope it is already set at. Writing to Global
   * while a workspace value exists would "succeed" and change nothing the user can see, since the
   * workspace value wins — so a workspace- or folder-level value is updated in place instead.
   */
  private static saveSetting(key: string, value: unknown): void {
    const config = vscode.workspace.getConfiguration("firebird.profiler");
    const inspected = config.inspect?.(key);
    const target = inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    Promise.resolve(config.update(key, value, target)).catch((err: any) => {
      logger.error(`Could not save firebird.profiler.${key}: ${err?.message ?? err}`);
    });
  }

  /** Shared confirm-then-execute path for the "Kill"/"Rollback" row actions -- both need the same
   *  modal-confirm-then-refresh flow, just against a different MON$ DELETE statement. */
  private runAdminAction(confirmMessage: string, confirmLabel: string, buildSql: () => string): void {
    vscode.window.showWarningMessage(confirmMessage, { modal: true }, confirmLabel).then(async answer => {
      if (answer !== confirmLabel) {
        return;
      }
      try {
        const connection = await this.ensureConnection();
        await Driver.client.queryPromise(connection, buildSql());
        this.send({ command: "actionResult", data: { ok: true } });
      } catch (err: any) {
        const message = err?.message ?? String(err);
        logger.error(`Live Profiler action failed: ${message}`);
        this.send({ command: "actionResult", data: { ok: false, error: message } });
      }
      this.pollOnce().catch(err => logger.error(err));
    });
  }

  dispose(): void {
    this.configListener?.dispose();
    this.configListener = undefined;
    if (this.connection) {
      Driver.client.detach(this.connection).catch(() => { /* already gone */ });
      this.connection = undefined;
    }
    super.dispose();
  }

  private async ensureConnection(): Promise<unknown> {
    if (this.connection) {
      return this.connection;
    }
    if (!this.dbDetails) {
      throw new Error("No active database connection.");
    }
    const resolved = await Driver.resolvePassword(this.dbDetails);
    this.connection = await Driver.client.createConnection(resolved);
    return this.connection;
  }

  private async pollOnce(): Promise<void> {
    try {
      const connection = await this.ensureConnection();
      const rows = await Driver.client.queryPromise(connection, profilerActivityQuery());
      this.send({ command: "activityData", data: { rows } });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`Live Profiler poll failed: ${message}`);
      // The connection may have died (server restart, network blip) -- drop it so the next poll
      // reconnects instead of repeating the same failure forever.
      this.connection = undefined;
      this.send({ command: "activityData", data: { error: message } });
    }
  }
}
