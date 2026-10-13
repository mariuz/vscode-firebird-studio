import * as vscode from "vscode";

/**
 * Formats elapsed seconds as a human-friendly string (e.g. "0s", "14s", "1m 05s", "1h 02m 03s").
 * Exported as pure function for unit testing.
 */
export function formatExecutionTime(seconds: number): string {
  if (seconds < 0) {
    seconds = 0;
  }
  const s = Math.floor(seconds);
  if (s < 60) {
    return `${s}s`;
  }
  const minutes = Math.floor(s / 60);
  const remainingSec = s % 60;
  const padSec = remainingSec.toString().padStart(2, "0");
  if (minutes < 60) {
    return `${minutes}m ${padSec}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMin = (minutes % 60).toString().padStart(2, "0");
  return `${hours}h ${remainingMin}m ${padSec}s`;
}

/**
 * Truncates SQL statement text for task panel or status tooltip display.
 * Strips leading/trailing whitespace and replaces newlines with single spaces.
 */
export function truncateSql(sql: string, maxLength: number = 60): string {
  if (!sql || !sql.trim()) {
    return "Query";
  }
  const flattened = sql.trim().replace(/\s+/g, " ");
  if (flattened.length <= maxLength) {
    return flattened;
  }
  return flattened.substring(0, maxLength - 1).trim() + "…";
}

/**
 * Represents an active in-flight query execution, allowing cancellation.
 */
export interface ActiveQueryExecution {
  id: string;
  sql: string;
  startedAt: number;
  connectionOptions?: { host?: string; database?: string };
  cancel: () => Promise<void>;
}

/**
 * Registry and UI manager for query execution status bar indicator and cancellation.
 */
export class QueryExecutionManager {
  private static instance?: QueryExecutionManager;
  private statusBarItem?: vscode.StatusBarItem;
  private activeExecutions = new Map<string, ActiveQueryExecution>();
  private timer?: ReturnType<typeof setInterval>;
  private isEnabled = true;

  private constructor() {}

  public static getInstance(): QueryExecutionManager {
    if (!QueryExecutionManager.instance) {
      QueryExecutionManager.instance = new QueryExecutionManager();
    }
    return QueryExecutionManager.instance;
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    if (!enabled && this.statusBarItem) {
      this.statusBarItem.hide();
    } else if (enabled && this.activeExecutions.size > 0) {
      this.updateStatusBar();
      this.statusBarItem?.show();
    }
  }

  public registerExecution(execution: ActiveQueryExecution): vscode.Disposable {
    this.activeExecutions.set(execution.id, execution);
    if (!this.timer) {
      this.timer = setInterval(() => this.onTick(), 1000);
      this.timer.unref?.();
    }
    this.updateStatusBar();

    return {
      dispose: () => {
        this.activeExecutions.delete(execution.id);
        if (this.activeExecutions.size === 0) {
          if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
          }
          this.statusBarItem?.hide();
        } else {
          this.updateStatusBar();
        }
      }
    };
  }

  public getActiveCount(): number {
    return this.activeExecutions.size;
  }

  public getActiveExecutions(): ActiveQueryExecution[] {
    return Array.from(this.activeExecutions.values());
  }

  public async cancelLatest(): Promise<boolean> {
    const list = this.getActiveExecutions();
    if (list.length === 0) {
      return false;
    }
    // Cancel the most recently registered active query
    const latest = list[list.length - 1];
    await latest.cancel();
    return true;
  }

  public async cancelAll(): Promise<void> {
    const list = this.getActiveExecutions();
    await Promise.all(list.map(e => e.cancel()));
  }

  private onTick(): void {
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (!this.isEnabled) {
      this.statusBarItem?.hide();
      return;
    }
    if (this.activeExecutions.size === 0) {
      this.statusBarItem?.hide();
      return;
    }

    if (!this.statusBarItem) {
      this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
      this.statusBarItem.command = "firebird.cancelQuery";
    }

    const list = this.getActiveExecutions();
    const latest = list[list.length - 1];
    const elapsedSec = (Date.now() - latest.startedAt) / 1000;
    const formattedTime = formatExecutionTime(elapsedSec);

    const countText = list.length > 1 ? ` (${list.length} running)` : "";
    this.statusBarItem.text = `$(sync~spin) Executing query... (${formattedTime})${countText}`;
    this.statusBarItem.tooltip = `Executing: ${truncateSql(latest.sql, 80)}\nElapsed: ${formattedTime}\nClick to cancel query.`;
    this.statusBarItem.show();
  }

  public dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.statusBarItem?.dispose();
    this.statusBarItem = undefined;
    this.activeExecutions.clear();
  }
}
