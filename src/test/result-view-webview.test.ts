/**
 * Unit coverage for src/result-view/htmlContent/js/app.js's pure helper functions, via its
 * existing `module.exports.__test__` hook (previously unused by any committed test — see
 * src/test/webview-harness.ts's doc comment). These are exactly the functions the file's own
 * section comments already call out as "pure — no DOM/jQuery": SQL-literal/selection helpers,
 * shortcut-combo parsing, and the hand-rolled SVG chart builders.
 */

import * as assert from 'assert';
import * as path from 'path';
import { installWebviewStubs, loadWebviewModule } from './webview-harness';

const APP_JS_PATH = path.join(__dirname, '..', '..', 'src', 'result-view', 'htmlContent', 'js', 'app.js');

suite('result-view app.js – pure helpers (via __test__ hook)', function () {
  let hooks: any;
  let restore: () => void;

  suiteSetup(function () {
    restore = installWebviewStubs();
    hooks = loadWebviewModule(APP_JS_PATH).__test__;
  });
  suiteTeardown(function () { restore(); });

  suite('sqlLiteral()', function () {
    test('null/undefined/empty-string all become NULL', function () {
      assert.strictEqual(hooks.sqlLiteral(null), 'NULL');
      assert.strictEqual(hooks.sqlLiteral(undefined), 'NULL');
      assert.strictEqual(hooks.sqlLiteral(''), 'NULL');
    });

    test('a plain integer is unquoted', function () {
      assert.strictEqual(hooks.sqlLiteral('42'), '42');
      assert.strictEqual(hooks.sqlLiteral('-7'), '-7');
    });

    test('a decimal is unquoted', function () {
      assert.strictEqual(hooks.sqlLiteral('3.14'), '3.14');
    });

    test('a non-numeric string is quoted and single-quote-escaped', function () {
      assert.strictEqual(hooks.sqlLiteral("O'Brien"), "'O''Brien'");
    });

    test('a numeric-looking-but-not-quite string (e.g. a ZIP with letters) is quoted', function () {
      assert.strictEqual(hooks.sqlLiteral('02139-1A'), "'02139-1A'");
    });
  });

  suite('buildInsertStatement()', function () {
    test('builds one INSERT with values run through sqlLiteral', function () {
      const sql = hooks.buildInsertStatement('CUSTOMERS', ['ID', 'NAME'], ['1', "O'Brien"]);
      assert.strictEqual(sql, "INSERT INTO CUSTOMERS (ID, NAME) VALUES (1, 'O''Brien');");
    });
  });

  suite('buildInClause()', function () {
    test('builds an IN (...) clause with each value through sqlLiteral', function () {
      assert.strictEqual(hooks.buildInClause(['1', '2', 'x']), "IN (1, 2, 'x')");
    });

    test('an empty array produces an empty IN ()', function () {
      assert.strictEqual(hooks.buildInClause([]), 'IN ()');
    });
  });

  suite('selectionRange()', function () {
    test('normalizes an anchor/end pair regardless of drag direction', function () {
      const range = hooks.selectionRange({ row: 3, col: 1 }, { row: 1, col: 4 });
      assert.deepStrictEqual(range, { rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 4 });
    });

    test('a single-cell selection collapses to a 1x1 range', function () {
      const range = hooks.selectionRange({ row: 2, col: 2 }, { row: 2, col: 2 });
      assert.deepStrictEqual(range, { rowStart: 2, rowEnd: 2, colStart: 2, colEnd: 2 });
    });
  });

  suite('parseShortcut()', function () {
    test('parses a single key with no modifiers', function () {
      assert.deepStrictEqual(hooks.parseShortcut('g'), { key: 'g', ctrl: false, alt: false, shift: false, meta: false });
    });

    test('parses ctrl+alt+g', function () {
      assert.deepStrictEqual(hooks.parseShortcut('ctrl+alt+g'), { key: 'g', ctrl: true, alt: true, shift: false, meta: false });
    });

    test('ctrlcmd maps to ctrl on a non-mac platform', function () {
      const parsed = hooks.parseShortcut('ctrlcmd+alt+i');
      assert.strictEqual(parsed.ctrl, true);
      assert.strictEqual(parsed.meta, false);
    });

    test('is case-insensitive and tolerates surrounding whitespace', function () {
      assert.deepStrictEqual(hooks.parseShortcut(' CTRL + Alt + G '), { key: 'g', ctrl: true, alt: true, shift: false, meta: false });
    });

    test('an empty/falsy combo returns null', function () {
      assert.strictEqual(hooks.parseShortcut(''), null);
      assert.strictEqual(hooks.parseShortcut(undefined), null);
    });

    test('recognizes cmd/command/win as meta', function () {
      assert.strictEqual(hooks.parseShortcut('cmd+k').meta, true);
      assert.strictEqual(hooks.parseShortcut('win+k').meta, true);
    });
  });

  suite('matchesShortcut()', function () {
    test('matches an event whose key/modifiers exactly match the parsed combo', function () {
      const parsed = hooks.parseShortcut('ctrl+alt+g');
      const event = { key: 'g', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
      assert.strictEqual(hooks.matchesShortcut(event, parsed), true);
    });

    test('rejects an event with an extra modifier held down', function () {
      const parsed = hooks.parseShortcut('ctrl+g');
      const event = { key: 'g', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
      assert.strictEqual(hooks.matchesShortcut(event, parsed), false);
    });

    test('rejects a different key entirely', function () {
      const parsed = hooks.parseShortcut('ctrl+g');
      const event = { key: 'x', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
      assert.strictEqual(hooks.matchesShortcut(event, parsed), false);
    });

    test('a null parsed combo (disabled shortcut) never matches', function () {
      assert.strictEqual(hooks.matchesShortcut({ key: 'g' }, null), false);
    });

    test('key comparison is case-insensitive', function () {
      const parsed = hooks.parseShortcut('ctrl+g');
      const event = { key: 'G', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
      assert.strictEqual(hooks.matchesShortcut(event, parsed), true);
    });
  });

  suite('detectNumericColumns()', function () {
    test('detects a column whose every non-empty value is numeric', function () {
      const headers = [{ title: 'ID' }, { title: 'NAME' }];
      const rows = [['1', 'Alice'], ['2', 'Bob']];
      assert.deepStrictEqual(hooks.detectNumericColumns(headers, rows), [0]);
    });

    test('a column with even one non-numeric value is excluded', function () {
      const headers = [{ title: 'A' }, { title: 'B' }];
      const rows = [['1', 'x'], ['2', '3']];
      assert.deepStrictEqual(hooks.detectNumericColumns(headers, rows), [0]);
    });

    test('a column with only empty values is excluded (nothing to sniff)', function () {
      const headers = [{ title: 'A' }];
      const rows = [[''], ['']];
      assert.deepStrictEqual(hooks.detectNumericColumns(headers, rows), []);
    });
  });

  suite('chart SVG builders — return well-formed <svg> markup with one shape per data point', function () {
    test('buildBarChartSvg() emits one <rect> per value, wrapped in an <svg> root', function () {
      const svg = hooks.buildBarChartSvg(['a', 'b', 'c'], [1, 2, 3]);
      assert.ok(svg.startsWith('<svg'), svg);
      assert.strictEqual((svg.match(/<rect/g) || []).length, 3);
    });

    test('buildLineChartSvg() emits one <circle> per value plus a connecting <path>', function () {
      const svg = hooks.buildLineChartSvg(['a', 'b'], [1, 2]);
      assert.ok(svg.includes('<path'), svg);
      assert.strictEqual((svg.match(/<circle/g) || []).length, 2);
    });

    test('buildPieChartSvg() emits one <path> slice per value', function () {
      const svg = hooks.buildPieChartSvg(['a', 'b'], [1, 3]);
      assert.strictEqual((svg.match(/<path/g) || []).length, 2);
    });

    test('buildPieChartSvg() with an all-zero series still returns valid (not NaN-poisoned) markup', function () {
      const svg = hooks.buildPieChartSvg(['a', 'b'], [0, 0]);
      assert.ok(!svg.includes('NaN'), svg);
    });

    test('buildScatterChartSvg() emits one <circle> per (x, y) pair', function () {
      const svg = hooks.buildScatterChartSvg([1, 2, 3], [4, 5, 6]);
      assert.strictEqual((svg.match(/<circle/g) || []).length, 3);
    });
  });
});
