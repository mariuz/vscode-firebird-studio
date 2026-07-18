import * as vscode from 'vscode';
import { v1 as uuidv1 } from 'uuid';

/**
 * Background task panel (docs/roadmap/connection-management-enhancements.md, phase 4) — a
 * discoverability layer over long-running operations (container provisioning, backup/restore)
 * that already report via a transient `withProgress` notification or status bar spinner. Those
 * existing per-operation notifications are left unchanged; this is purely an *additional*, durable
 * record so a user who dismisses or misses one can still check whether it actually finished.
 *
 * In-memory only (not persisted to globalState) — a completed task from a previous VS Code session
 * isn't meaningfully "recent" anymore, and every operation this tracks is itself already
 * session-scoped (a Docker container or a backup file either exists or it doesn't; there's nothing
 * this panel is the source of truth for).
 */

export type TaskStatus = 'running' | 'succeeded' | 'failed';

export interface BackgroundTask {
  id: string;
  title: string;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** Returned by TaskTracker.start() — the running operation reports its own outcome through this. */
export interface TaskHandle {
  complete(): void;
  fail(error: string): void;
}

const ICON_BY_STATUS: Record<TaskStatus, string> = {
  running: 'loading~spin',
  succeeded: 'pass',
  failed: 'error',
};

/** Pure — the icon codicon id for a task's current status. Exported for testing. */
export function iconIdForStatus(status: TaskStatus): string {
  return ICON_BY_STATUS[status];
}

/** Pure — the tree item's description text for a task's current status. Exported for testing. */
export function describeTaskStatus(task: BackgroundTask): string {
  if (task.status === 'running') {
    return 'Running…';
  }
  const durationSec = ((task.finishedAt! - task.startedAt) / 1000).toFixed(1);
  return task.status === 'succeeded' ? `Done in ${durationSec}s` : `Failed after ${durationSec}s`;
}

export class TaskItem extends vscode.TreeItem {
  constructor(public readonly task: BackgroundTask) {
    super(task.title, vscode.TreeItemCollapsibleState.None);
    this.description = describeTaskStatus(task);
    this.tooltip = task.error ?? task.title;
    this.contextValue = task.status === 'running' ? 'task-running' : 'task-done';
    this.iconPath = new vscode.ThemeIcon(iconIdForStatus(task.status));
  }
}

class EmptyTaskItem extends vscode.TreeItem {
  constructor() {
    super('No background tasks yet.', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'empty';
  }
}

/** TreeDataProvider for the Background Tasks view. */
export class TaskTracker implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  /** Capped so a long session doesn't accumulate an unbounded list — oldest completed tasks fall off first. */
  private static readonly MAX_TASKS = 50;

  private tasks: BackgroundTask[] = [];
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Registers a new running task and returns the handle its own operation reports completion through. */
  start(title: string): TaskHandle {
    const task: BackgroundTask = { id: uuidv1(), title, status: 'running', startedAt: Date.now() };
    this.tasks.unshift(task);
    if (this.tasks.length > TaskTracker.MAX_TASKS) {
      this.tasks.length = TaskTracker.MAX_TASKS;
    }
    this.refresh();

    return {
      complete: () => {
        task.status = 'succeeded';
        task.finishedAt = Date.now();
        this.refresh();
      },
      fail: (error: string) => {
        task.status = 'failed';
        task.finishedAt = Date.now();
        task.error = error;
        this.refresh();
      },
    };
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.tasks.length === 0) {
      return [new EmptyTaskItem()];
    }
    return this.tasks.map(t => new TaskItem(t));
  }

  /** Returns a copy — callers must not mutate task state directly, only through a TaskHandle. */
  getAll(): BackgroundTask[] {
    return [...this.tasks];
  }

  /** Removes every finished (succeeded or failed) task, keeping only ones still running. */
  clearCompleted(): void {
    this.tasks = this.tasks.filter(t => t.status === 'running');
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
