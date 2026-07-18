/**
 * Unit coverage for src/query-plan-view/htmlContent/js/app.js's pure tree-layout/table/icicle
 * helpers, via its existing `module.exports.__test__` hook (previously unused by any committed
 * test — see src/test/webview-harness.ts's doc comment).
 */

import * as assert from 'assert';
import * as path from 'path';
import { installWebviewStubs, loadWebviewModule } from './webview-harness';

const APP_JS_PATH = path.join(__dirname, '..', '..', 'src', 'query-plan-view', 'htmlContent', 'js', 'app.js');

function scan(overrides: Partial<any> & { table: string } = { table: 'T' }): any {
  return { kind: 'scan', method: 'NATURAL', ...overrides };
}

function indexScan(table: string, indexes: string[]): any {
  return { kind: 'scan', table, method: 'INDEX', indexes };
}

suite('query-plan-view app.js – helpers (via __test__ hook)', function () {
  let hooks: any;
  let restore: () => void;

  suiteSetup(function () {
    restore = installWebviewStubs();
    hooks = loadWebviewModule(APP_JS_PATH).__test__;
  });
  suiteTeardown(function () { restore(); });

  suite('countLeaves()', function () {
    test('a single scan is 1 leaf', function () {
      assert.strictEqual(hooks.countLeaves(scan({ table: 'T' })), 1);
    });

    test('a JOIN of two scans has 2 leaves', function () {
      const join = { kind: 'JOIN', children: [scan({ table: 'A' }), scan({ table: 'B' })] };
      assert.strictEqual(hooks.countLeaves(join), 2);
    });

    test('nested joins sum leaves recursively', function () {
      const inner = { kind: 'JOIN', children: [scan({ table: 'A' }), scan({ table: 'B' })] };
      const outer = { kind: 'JOIN', children: [inner, scan({ table: 'C' })] };
      assert.strictEqual(hooks.countLeaves(outer), 3);
    });

    test('a wrapper node with no children (defensive) counts as 1 leaf, not 0', function () {
      assert.strictEqual(hooks.countLeaves({ kind: 'SORT', children: [] }), 1);
    });
  });

  suite('nodeLabel()', function () {
    test('a scan node is labeled by table name + access method', function () {
      const label = hooks.nodeLabel(scan({ table: 'CUSTOMERS' }));
      assert.strictEqual(label.title, 'CUSTOMERS');
      assert.strictEqual(label.subtitle, 'Natural Scan');
    });

    test('a wrapper node is labeled by its kind + input count', function () {
      const label = hooks.nodeLabel({ kind: 'JOIN', children: [scan({ table: 'A' }), scan({ table: 'B' })] });
      assert.strictEqual(label.title, 'JOIN');
      assert.strictEqual(label.subtitle, '2 inputs');
    });

    test('a single-input wrapper node uses the singular "input"', function () {
      const label = hooks.nodeLabel({ kind: 'SORT', children: [scan({ table: 'A' })] });
      assert.strictEqual(label.subtitle, '1 input');
    });
  });

  suite('scanMethodLabel()', function () {
    test('NATURAL', function () {
      assert.strictEqual(hooks.scanMethodLabel(scan({ table: 'T', method: 'NATURAL' })), 'Natural Scan');
    });
    test('INDEX lists every index used', function () {
      assert.strictEqual(hooks.scanMethodLabel(indexScan('T', ['IX_A', 'IX_B'])), 'Index: IX_A, IX_B');
    });
    test('ORDER names the ordering index', function () {
      assert.strictEqual(hooks.scanMethodLabel({ kind: 'scan', table: 'T', method: 'ORDER', index: 'IX_SORT' }), 'Ordered: IX_SORT');
    });
    test('an unrecognized method returns an empty string rather than throwing', function () {
      assert.strictEqual(hooks.scanMethodLabel({ kind: 'scan', table: 'T', method: 'WEIRD' }), '');
    });
  });

  suite('layoutForest()', function () {
    test('lays out a single scan at depth 0', function () {
      const [root] = hooks.layoutForest([scan({ table: 'T' })]);
      assert.strictEqual(root.y, 0);
      assert.strictEqual(root.children.length, 0);
    });

    test('a JOIN sits at a shallower depth (smaller y) than its two scan children, which sit side by side', function () {
      const join = { kind: 'JOIN', children: [scan({ table: 'A' }), scan({ table: 'B' })] };
      const [root] = hooks.layoutForest([join]);
      assert.strictEqual(root.children.length, 2);
      assert.ok(root.children[0].x < root.children[1].x, 'children should be laid out left-to-right, distinct x positions');
      assert.ok(root.children[0].y > root.y, 'a child sits at a greater depth (y) than its parent');
    });

    test('multiple independent blocks (e.g. two separate statements) get non-overlapping x ranges', function () {
      const roots = hooks.layoutForest([scan({ table: 'A' }), scan({ table: 'B' })]);
      assert.strictEqual(roots.length, 2);
      assert.ok(roots[1].x > roots[0].x);
    });
  });

  suite('flattenBlocks()', function () {
    test('flattens a single scan into one row', function () {
      const rows = hooks.flattenBlocks([scan({ table: 'T', method: 'NATURAL' })]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].kind, 'Scan');
      assert.strictEqual(rows[0].table, 'T');
      assert.strictEqual(rows[0].depth, 0);
    });

    test('flattens a JOIN depth-first, parent row before its children, incrementing depth', function () {
      const join = { kind: 'JOIN', children: [scan({ table: 'A' }), scan({ table: 'B' })] };
      const rows = hooks.flattenBlocks([join]);
      assert.strictEqual(rows.length, 3);
      assert.strictEqual(rows[0].kind, 'JOIN');
      assert.strictEqual(rows[0].depth, 0);
      assert.strictEqual(rows[1].table, 'A');
      assert.strictEqual(rows[1].depth, 1);
      assert.strictEqual(rows[2].table, 'B');
      assert.strictEqual(rows[2].depth, 1);
    });

    test('order is a stable 1-based counter across the whole forest, not per-block', function () {
      const rows = hooks.flattenBlocks([scan({ table: 'A' }), scan({ table: 'B' })]);
      assert.deepStrictEqual(rows.map((r: any) => r.order), [1, 2]);
    });

    test('an INDEX scan\'s detail column lists the index names', function () {
      const rows = hooks.flattenBlocks([indexScan('T', ['IX_A', 'IX_B'])]);
      assert.strictEqual(rows[0].detail, 'IX_A, IX_B');
    });
  });

  suite('sortRows()', function () {
    test('sorts numerically by "order" ascending', function () {
      const input = [{ order: 3 }, { order: 1 }, { order: 2 }];
      const sorted = hooks.sortRows(input, 'order', 'asc');
      assert.deepStrictEqual(sorted.map((r: any) => r.order), [1, 2, 3]);
    });

    test('descending reverses the sort', function () {
      const input = [{ order: 1 }, { order: 2 }, { order: 3 }];
      const sorted = hooks.sortRows(input, 'order', 'desc');
      assert.deepStrictEqual(sorted.map((r: any) => r.order), [3, 2, 1]);
    });

    test('sorts a text column ("table") case-insensitively', function () {
      const input = [{ table: 'banana' }, { table: 'Apple' }, { table: 'cherry' }];
      const sorted = hooks.sortRows(input, 'table', 'asc');
      assert.deepStrictEqual(sorted.map((r: any) => r.table), ['Apple', 'banana', 'cherry']);
    });

    test('does not mutate the original array', function () {
      const input = [{ order: 2 }, { order: 1 }];
      hooks.sortRows(input, 'order', 'asc');
      assert.strictEqual(input[0].order, 2, 'input array order should be untouched');
    });
  });

  suite('icicleLayout()', function () {
    test('a single scan occupies the full width (0..1) at depth 0', function () {
      const [seg] = hooks.icicleLayout([scan({ table: 'T' })]);
      assert.strictEqual(seg.depth, 0);
      assert.strictEqual(seg.x0, 0);
      assert.strictEqual(seg.width, 1);
    });

    test('two equal-weight children of a JOIN split the width evenly', function () {
      const join = { kind: 'JOIN', children: [scan({ table: 'A' }), scan({ table: 'B' })] };
      const segments = hooks.icicleLayout([join]);
      const children = segments.filter((s: any) => s.depth === 1);
      assert.strictEqual(children.length, 2);
      assert.ok(Math.abs(children[0].width - 0.5) < 1e-9);
      assert.ok(Math.abs(children[1].width - 0.5) < 1e-9);
      assert.ok(Math.abs(children[1].x0 - 0.5) < 1e-9, 'the second child should start where the first one ends');
    });

    test('a child with more leaves gets a proportionally wider segment', function () {
      const heavy = { kind: 'JOIN', children: [scan({ table: 'A' }), scan({ table: 'B' })] }; // 2 leaves
      const join = { kind: 'JOIN', children: [heavy, scan({ table: 'C' })] }; // 3 leaves total
      const segments = hooks.icicleLayout([join]);
      const depth1 = segments.find((s: any) => s.depth === 1 && s.node === heavy);
      assert.ok(Math.abs(depth1.width - 2 / 3) < 1e-9, `expected ~0.667, got ${depth1.width}`);
    });

    test('segments cover the whole 0..1 range with no gaps for multiple root blocks', function () {
      const segments = hooks.icicleLayout([scan({ table: 'A' }), scan({ table: 'B' })]);
      const roots = segments.filter((s: any) => s.depth === 0);
      assert.strictEqual(roots.length, 2);
      assert.ok(Math.abs(roots[0].x0) < 1e-9);
      assert.ok(Math.abs(roots[1].x0 - 0.5) < 1e-9);
    });
  });

  suite('flattenActualPlan()', function () {
    function node(overrides: any): any {
      return { label: 'L', accessPath: 'A', openCount: 1, openElapsedMs: 1, fetchCount: 1, fetchElapsedMs: 1, level: 0, children: [], ...overrides };
    }

    test('flattens a single node', function () {
      const rows = hooks.flattenActualPlan([node({ label: 'ROOT' })]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].label, 'ROOT');
      assert.strictEqual(rows[0].order, 1);
    });

    test('flattens nested children depth-first, incrementing order', function () {
      const child = node({ label: 'CHILD' });
      const rows = hooks.flattenActualPlan([node({ label: 'ROOT', children: [child] })]);
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].label, 'ROOT');
      assert.strictEqual(rows[1].label, 'CHILD');
      assert.strictEqual(rows[1].order, 2);
    });
  });

  suite('sortActualRows()', function () {
    test('sorts numerically by a stats column (e.g. fetchCount)', function () {
      const rows = [{ label: 'a', fetchCount: 30 }, { label: 'b', fetchCount: 10 }, { label: 'c', fetchCount: 20 }];
      const sorted = hooks.sortActualRows(rows, 'fetchCount', 'asc');
      assert.deepStrictEqual(sorted.map((r: any) => r.fetchCount), [10, 20, 30]);
    });

    test('sorts "label" as case-insensitive text, not numerically', function () {
      const rows = [{ label: 'Banana' }, { label: 'apple' }];
      const sorted = hooks.sortActualRows(rows, 'label', 'asc');
      assert.deepStrictEqual(sorted.map((r: any) => r.label), ['apple', 'Banana']);
    });

    test('descending reverses the sort', function () {
      const rows = [{ label: 'a', openCount: 1 }, { label: 'b', openCount: 3 }, { label: 'c', openCount: 2 }];
      const sorted = hooks.sortActualRows(rows, 'openCount', 'desc');
      assert.deepStrictEqual(sorted.map((r: any) => r.openCount), [3, 2, 1]);
    });
  });
});
