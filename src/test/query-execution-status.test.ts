import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  formatExecutionTime,
  truncateSql,
  QueryExecutionManager,
  ActiveQueryExecution
} from '../shared/query-execution-status';

suite('Query Execution Status – formatExecutionTime', () => {
  test('formats seconds under a minute', () => {
    assert.strictEqual(formatExecutionTime(0), '0s');
    assert.strictEqual(formatExecutionTime(5), '5s');
    assert.strictEqual(formatExecutionTime(59), '59s');
    assert.strictEqual(formatExecutionTime(14.8), '14s');
    assert.strictEqual(formatExecutionTime(-3), '0s');
  });

  test('formats minutes and seconds', () => {
    assert.strictEqual(formatExecutionTime(60), '1m 00s');
    assert.strictEqual(formatExecutionTime(65), '1m 05s');
    assert.strictEqual(formatExecutionTime(125), '2m 05s');
    assert.strictEqual(formatExecutionTime(3599), '59m 59s');
  });

  test('formats hours, minutes, and seconds', () => {
    assert.strictEqual(formatExecutionTime(3600), '1h 00m 00s');
    assert.strictEqual(formatExecutionTime(3665), '1h 01m 05s');
    assert.strictEqual(formatExecutionTime(7325), '2h 02m 05s');
  });
});

suite('Query Execution Status – truncateSql', () => {
  test('returns fallback for empty or whitespace-only sql', () => {
    assert.strictEqual(truncateSql(''), 'Query');
    assert.strictEqual(truncateSql('   '), 'Query');
  });

  test('flattens newlines and extra spaces', () => {
    const sql = `SELECT\n  id,\n  name\nFROM\n  users`;
    assert.strictEqual(truncateSql(sql, 50), 'SELECT id, name FROM users');
  });

  test('truncates strings longer than maxLength with ellipsis', () => {
    const sql = 'SELECT id, first_name, last_name, email, created_at FROM system_users WHERE active = 1';
    const truncated = truncateSql(sql, 30);
    assert.ok(truncated.endsWith('…'));
    assert.ok(truncated.length <= 30);
  });

  test('keeps short strings unchanged', () => {
    const sql = 'SELECT 1 FROM RDB$DATABASE';
    assert.strictEqual(truncateSql(sql, 50), sql);
  });
});

suite('Query Execution Status – QueryExecutionManager', () => {
  let manager: QueryExecutionManager;

  setup(() => {
    manager = QueryExecutionManager.getInstance();
    manager.dispose();
    manager.setEnabled(true);
  });

  teardown(() => {
    manager.dispose();
  });

  test('registers execution and tracks active count', () => {
    assert.strictEqual(manager.getActiveCount(), 0);

    let cancelCalled = false;
    const execution: ActiveQueryExecution = {
      id: 'exec-1',
      sql: 'SELECT 1 FROM RDB$DATABASE',
      startedAt: Date.now(),
      cancel: async () => { cancelCalled = true; }
    };

    const reg = manager.registerExecution(execution);
    assert.strictEqual(manager.getActiveCount(), 1);
    assert.strictEqual(manager.getActiveExecutions().length, 1);
    assert.strictEqual(manager.getActiveExecutions()[0].id, 'exec-1');

    reg.dispose();
    assert.strictEqual(manager.getActiveCount(), 0);
    assert.strictEqual(cancelCalled, false);
  });

  test('cancelLatest cancels the most recent execution', async () => {
    let cancel1 = false;
    let cancel2 = false;

    const exec1: ActiveQueryExecution = {
      id: 'exec-1',
      sql: 'SELECT 1',
      startedAt: Date.now(),
      cancel: async () => { cancel1 = true; }
    };
    const exec2: ActiveQueryExecution = {
      id: 'exec-2',
      sql: 'SELECT 2',
      startedAt: Date.now(),
      cancel: async () => { cancel2 = true; }
    };

    const reg1 = manager.registerExecution(exec1);
    const reg2 = manager.registerExecution(exec2);

    const cancelled = await manager.cancelLatest();
    assert.strictEqual(cancelled, true);
    assert.strictEqual(cancel1, false);
    assert.strictEqual(cancel2, true);

    reg1.dispose();
    reg2.dispose();
  });

  test('cancelLatest returns false when no query is running', async () => {
    const cancelled = await manager.cancelLatest();
    assert.strictEqual(cancelled, false);
  });

  test('cancelAll cancels all running executions', async () => {
    let cancel1 = false;
    let cancel2 = false;

    const reg1 = manager.registerExecution({
      id: 'exec-1',
      sql: 'SELECT 1',
      startedAt: Date.now(),
      cancel: async () => { cancel1 = true; }
    });
    const reg2 = manager.registerExecution({
      id: 'exec-2',
      sql: 'SELECT 2',
      startedAt: Date.now(),
      cancel: async () => { cancel2 = true; }
    });

    await manager.cancelAll();
    assert.strictEqual(cancel1, true);
    assert.strictEqual(cancel2, true);

    reg1.dispose();
    reg2.dispose();
  });

  test('respects setEnabled(false)', () => {
    manager.setEnabled(false);
    const reg = manager.registerExecution({
      id: 'exec-1',
      sql: 'SELECT 1',
      startedAt: Date.now(),
      cancel: async () => {}
    });

    // Still registered in registry even if status bar display is disabled
    assert.strictEqual(manager.getActiveCount(), 1);
    reg.dispose();
    assert.strictEqual(manager.getActiveCount(), 0);
  });
});
