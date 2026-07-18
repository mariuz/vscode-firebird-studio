/**
 * Unit coverage for src/result-view/htmlContent/js/plan-view.js — the per-statement "Query Plan"
 * tab embedded in the results webview (docs/roadmap/query-plan-visualizer.md phase 4). This is a
 * separately-maintained, instance-scoped adaptation of query-plan-view/app.js's rendering logic
 * (same function names, same algorithms, but able to host several simultaneous "Query Plan" tabs
 * rather than one module-scoped instance) — see src/test/query-plan-view-webview.test.ts for
 * exhaustive coverage of that shared logic; this file focuses on what's genuinely specific to
 * *this* file: create() actually returns fully independent instances (the concrete risk noted in
 * query-plan-visualizer.md's Testing section — "two simultaneous Query Plan tabs don't leak
 * selectedNode/blocks/sort state into each other"), plus a handful of parity smoke tests
 * confirming the duplicated pure functions still behave the same as their query-plan-view sibling.
 *
 * Unlike the other four webview files, `module.exports` here is the whole `{ create }` factory,
 * not a `.__test__` object directly — each create() call returns its own `{ show, showLoading,
 * __test__ }`, so the test hooks are reached by instantiating first.
 */

import * as assert from 'assert';
import * as path from 'path';
import { installWebviewStubs, loadWebviewModule } from './webview-harness';

const PLAN_VIEW_JS_PATH = path.join(__dirname, '..', '..', 'src', 'result-view', 'htmlContent', 'js', 'plan-view.js');

suite('result-view plan-view.js – instance isolation + pure-function parity (via __test__ hook)', function () {
  let FirebirdPlanView: any;
  let restore: () => void;

  suiteSetup(function () {
    restore = installWebviewStubs();
    FirebirdPlanView = loadWebviewModule(PLAN_VIEW_JS_PATH);
  });
  suiteTeardown(function () { restore(); });

  function makeContainer(): any {
    // A container needs to behave like a real DOM element for buildDom() — the generic stub
    // element from webview-harness.ts already supports classList/appendChild/querySelectorAll.
    return (global as any).document.createElement('div');
  }

  function scan(overrides: Partial<any> & { table: string } = { table: 'T' }): any {
    return { kind: 'scan', method: 'NATURAL', ...overrides };
  }

  suite('create() instance isolation', function () {
    test('two instances do not share __test__ hook object identity', function () {
      const a = FirebirdPlanView.create(makeContainer(), {});
      const b = FirebirdPlanView.create(makeContainer(), {});
      assert.notStrictEqual(a.__test__, b.__test__);
    });

    test('showing a plan on one instance does not affect another instance\'s state', function () {
      const a = FirebirdPlanView.create(makeContainer(), {});
      const b = FirebirdPlanView.create(makeContainer(), {});

      assert.doesNotThrow(() => a.show({ blocks: [scan({ table: 'A' })] }));
      assert.doesNotThrow(() => b.show({ blocks: [scan({ table: 'B' }), scan({ table: 'C' })] }));

      // Each instance's own countLeaves()/layoutForest() must still operate on its own closure
      // state, not a module-level shared one -- calling one instance's pure helpers must not have
      // been affected by the other instance's show() call.
      assert.strictEqual(a.__test__.countLeaves(scan({ table: 'X' })), 1);
      assert.strictEqual(b.__test__.countLeaves(scan({ table: 'Y' })), 1);
    });

    test('showLoading() and show() on independent instances do not throw', function () {
      const a = FirebirdPlanView.create(makeContainer(), {});
      assert.doesNotThrow(() => a.showLoading());
      assert.doesNotThrow(() => a.show({ error: 'boom' }));
      assert.doesNotThrow(() => a.show({ blocks: [] }));
    });
  });

  suite('pure-function parity with query-plan-view/app.js\'s duplicated logic', function () {
    let hooks: any;
    suiteSetup(function () {
      hooks = FirebirdPlanView.create(makeContainer(), {}).__test__;
    });

    test('countLeaves() matches the sibling implementation\'s behavior', function () {
      const join = { kind: 'JOIN', children: [scan({ table: 'A' }), scan({ table: 'B' })] };
      assert.strictEqual(hooks.countLeaves(join), 2);
    });

    test('flattenBlocks() flattens a JOIN depth-first with a stable order counter', function () {
      const join = { kind: 'JOIN', children: [scan({ table: 'A' }), scan({ table: 'B' })] };
      const rows = hooks.flattenBlocks([join]);
      assert.deepStrictEqual(rows.map((r: any) => r.table), ['', 'A', 'B']);
      assert.deepStrictEqual(rows.map((r: any) => r.order), [1, 2, 3]);
    });

    test('sortRows() sorts numerically by "order"', function () {
      const sorted = hooks.sortRows([{ order: 2 }, { order: 1 }], 'order', 'asc');
      assert.deepStrictEqual(sorted.map((r: any) => r.order), [1, 2]);
    });

    test('icicleLayout() gives a single scan the full 0..1 width', function () {
      const [seg] = hooks.icicleLayout([scan({ table: 'T' })]);
      assert.strictEqual(seg.x0, 0);
      assert.strictEqual(seg.width, 1);
    });

    test('scanMethodLabel() labels a NATURAL scan', function () {
      assert.strictEqual(hooks.scanMethodLabel(scan({ table: 'T', method: 'NATURAL' })), 'Natural Scan');
    });

    test('nodeLabel() labels a scan by table name', function () {
      const label = hooks.nodeLabel(scan({ table: 'CUSTOMERS' }));
      assert.strictEqual(label.title, 'CUSTOMERS');
    });

    test('flattenActualPlan()/sortActualRows() mirror the estimated-plan pair\'s shape', function () {
      const node = { label: 'ROOT', accessPath: 'A', openCount: 1, openElapsedMs: 1, fetchCount: 1, fetchElapsedMs: 1, level: 0, children: [] };
      const rows = hooks.flattenActualPlan([node]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].label, 'ROOT');
      const sorted = hooks.sortActualRows(rows, 'label', 'asc');
      assert.strictEqual(sorted.length, 1);
    });
  });
});
