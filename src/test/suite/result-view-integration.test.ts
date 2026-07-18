/**
 * Extension Development Host integration test for ResultView's message-handling chain that
 * doesn't need a real database connection: `handleMessage()`'s delegation of certain webview
 * messages to extension.ts via the EventEmitter base (the same pattern
 * query-plan-view-integration.test.ts already covers for QueryPlanView's "analyzePlan").
 *
 * "viewTableDiagram" (docs/roadmap/query-results-enhancements.md, phase 5) is exercised here
 * rather than through a live SchemaDesigner, since ResultView itself never calls into
 * SchemaDesigner directly — it only emits an event, which is exactly what's under test.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import ResultView, { ViewTableDiagramRequest } from '../../result-view';

suite('ResultView – message-handling chain (extension host)', function () {
  this.timeout(20000);

  let view: ResultView;

  setup(function () {
    view = new ResultView(vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio')!.extensionPath);
  });

  teardown(function () {
    view.dispose();
  });

  test('"viewTableDiagram" emits with the table name from the webview message, unchanged', function () {
    let emitted: ViewTableDiagramRequest | undefined;
    view.once('viewTableDiagram', (payload: ViewTableDiagramRequest) => { emitted = payload; });

    view.handleMessage({ command: 'viewTableDiagram', data: { tableName: 'CUSTOMERS' } });

    assert.ok(emitted, 'expected the viewTableDiagram event to fire');
    assert.strictEqual(emitted!.tableName, 'CUSTOMERS');
  });

  test('a second "viewTableDiagram" message for a different table fires again with the new name', function () {
    const seen: string[] = [];
    view.on('viewTableDiagram', (payload: ViewTableDiagramRequest) => { seen.push(payload.tableName); });

    view.handleMessage({ command: 'viewTableDiagram', data: { tableName: 'ORDERS' } });
    view.handleMessage({ command: 'viewTableDiagram', data: { tableName: 'PRODUCTS' } });

    assert.deepStrictEqual(seen, ['ORDERS', 'PRODUCTS']);
  });
});
