/**
 * Unit tests for TaskTracker (docs/roadmap/connection-management-enhancements.md, phase 4).
 * Uses the vscode API (EventEmitter, TreeItem, ThemeIcon) via the mock in src/test/setup.ts, the
 * same way bookmark-provider.test.ts does — TaskTracker doesn't touch globalState (in-memory
 * only), so no mock ExtensionContext is needed here.
 */

import * as assert from 'assert';
import { TaskTracker, TaskItem, describeTaskStatus, iconIdForStatus, BackgroundTask } from '../task-panel/task-tracker';

suite('TaskTracker – getChildren', function () {
  test('returns a single empty-state item when no tasks have been started', function () {
    const tracker = new TaskTracker();
    const children = tracker.getChildren();
    assert.strictEqual(children.length, 1);
    assert.strictEqual((children[0] as any).contextValue, 'empty');
  });

  test('returns one TaskItem per started task', function () {
    const tracker = new TaskTracker();
    tracker.start('Task A');
    tracker.start('Task B');
    const children = tracker.getChildren();
    assert.strictEqual(children.length, 2);
    assert.ok(children.every(c => c instanceof TaskItem));
  });

  test('most recently started task appears first', function () {
    const tracker = new TaskTracker();
    tracker.start('First');
    tracker.start('Second');
    const children = tracker.getChildren() as TaskItem[];
    assert.strictEqual(children[0].task.title, 'Second');
    assert.strictEqual(children[1].task.title, 'First');
  });

  test('fires onDidChangeTreeData when a task starts', function () {
    const tracker = new TaskTracker();
    let fired = false;
    tracker.onDidChangeTreeData(() => { fired = true; });
    tracker.start('Task');
    assert.ok(fired);
  });
});

suite('TaskTracker – start() / TaskHandle', function () {
  test('a freshly started task is "running" with no finishedAt', function () {
    const tracker = new TaskTracker();
    tracker.start('Task');
    const [task] = tracker.getAll();
    assert.strictEqual(task.status, 'running');
    assert.strictEqual(task.finishedAt, undefined);
  });

  test('complete() marks the task succeeded and sets finishedAt', function () {
    const tracker = new TaskTracker();
    const handle = tracker.start('Task');
    handle.complete();
    const [task] = tracker.getAll();
    assert.strictEqual(task.status, 'succeeded');
    assert.ok(typeof task.finishedAt === 'number');
  });

  test('fail() marks the task failed, sets finishedAt, and records the error', function () {
    const tracker = new TaskTracker();
    const handle = tracker.start('Task');
    handle.fail('connection refused');
    const [task] = tracker.getAll();
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.error, 'connection refused');
    assert.ok(typeof task.finishedAt === 'number');
  });

  test('each started task has a distinct, non-empty id', function () {
    const tracker = new TaskTracker();
    tracker.start('A');
    tracker.start('B');
    const [a, b] = tracker.getAll();
    assert.ok(a.id && b.id && a.id !== b.id);
  });

  test('fires onDidChangeTreeData on complete() and again on fail() of a different task', function () {
    const tracker = new TaskTracker();
    const handle = tracker.start('Task');
    let fireCount = 0;
    tracker.onDidChangeTreeData(() => { fireCount++; });
    handle.complete();
    assert.strictEqual(fireCount, 1);
  });

  test('getAll() returns a copy, not a live reference to internal state', function () {
    const tracker = new TaskTracker();
    tracker.start('Task');
    const snapshot = tracker.getAll();
    tracker.start('Another');
    assert.strictEqual(snapshot.length, 1, 'the earlier snapshot must not grow when a new task starts');
  });

  test('the task list is capped so a long session does not grow unbounded', function () {
    const tracker = new TaskTracker();
    for (let i = 0; i < 60; i++) {
      tracker.start(`Task ${i}`);
    }
    assert.ok(tracker.getAll().length <= 50, `expected the list capped at 50, got ${tracker.getAll().length}`);
  });
});

suite('TaskTracker – clearCompleted()', function () {
  test('removes succeeded and failed tasks but keeps running ones', function () {
    const tracker = new TaskTracker();
    const running = tracker.start('Still running');
    const succeeded = tracker.start('Done');
    const failed = tracker.start('Broke');
    succeeded.complete();
    failed.fail('oops');
    void running;

    tracker.clearCompleted();

    const remaining = tracker.getAll();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].title, 'Still running');
  });

  test('fires onDidChangeTreeData', function () {
    const tracker = new TaskTracker();
    tracker.start('Task').complete();
    let fired = false;
    tracker.onDidChangeTreeData(() => { fired = true; });
    tracker.clearCompleted();
    assert.ok(fired);
  });

  test('a no-op clearCompleted() on an all-running list still fires (no error, no removal)', function () {
    const tracker = new TaskTracker();
    tracker.start('Still going');
    tracker.clearCompleted();
    assert.strictEqual(tracker.getAll().length, 1);
  });
});

suite('describeTaskStatus() (pure)', function () {
  test('a running task reads "Running…"', function () {
    const task: BackgroundTask = { id: '1', title: 'T', status: 'running', startedAt: Date.now() };
    assert.strictEqual(describeTaskStatus(task), 'Running…');
  });

  test('a succeeded task reports its duration in seconds', function () {
    const task: BackgroundTask = { id: '1', title: 'T', status: 'succeeded', startedAt: 1000, finishedAt: 3500 };
    assert.strictEqual(describeTaskStatus(task), 'Done in 2.5s');
  });

  test('a failed task reports its duration in seconds too', function () {
    const task: BackgroundTask = { id: '1', title: 'T', status: 'failed', startedAt: 1000, finishedAt: 2000, error: 'x' };
    assert.strictEqual(describeTaskStatus(task), 'Failed after 1.0s');
  });
});

suite('iconIdForStatus() (pure)', function () {
  test('running uses a spinning loading icon', function () {
    assert.strictEqual(iconIdForStatus('running'), 'loading~spin');
  });

  test('succeeded and failed use distinct, non-spinning icons', function () {
    const succeeded = iconIdForStatus('succeeded');
    const failed = iconIdForStatus('failed');
    assert.notStrictEqual(succeeded, failed);
    assert.ok(!succeeded.includes('spin'));
    assert.ok(!failed.includes('spin'));
  });
});

suite('TaskItem', function () {
  test('label matches the task title', function () {
    const task: BackgroundTask = { id: '1', title: 'Backup: employee.fdb', status: 'running', startedAt: Date.now() };
    const item = new TaskItem(task);
    assert.strictEqual(item.label, 'Backup: employee.fdb');
  });

  test('contextValue distinguishes a running task from a finished one', function () {
    const running = new TaskItem({ id: '1', title: 'T', status: 'running', startedAt: Date.now() });
    const done = new TaskItem({ id: '2', title: 'T', status: 'succeeded', startedAt: 1, finishedAt: 2 });
    assert.strictEqual(running.contextValue, 'task-running');
    assert.strictEqual(done.contextValue, 'task-done');
  });

  test('tooltip is the error message for a failed task, not just the title', function () {
    const task: BackgroundTask = { id: '1', title: 'Backup', status: 'failed', startedAt: 1, finishedAt: 2, error: 'disk full' };
    const item = new TaskItem(task);
    assert.strictEqual(item.tooltip, 'disk full');
  });

  test('tooltip falls back to the title when there is no error', function () {
    const task: BackgroundTask = { id: '1', title: 'Backup', status: 'succeeded', startedAt: 1, finishedAt: 2 };
    const item = new TaskItem(task);
    assert.strictEqual(item.tooltip, 'Backup');
  });
});
