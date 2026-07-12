import * as assert from 'assert';
import { renderRowsAsMarkdown, renderTableAsMarkdown } from '../shared/notebook-render';

suite('notebook-render – renderRowsAsMarkdown()', function () {
  test('returns a placeholder for an empty result set', function () {
    assert.strictEqual(renderRowsAsMarkdown([]), '_0 rows returned._');
  });

  test('renders a header row, separator row, and one row per record', function () {
    const md = renderRowsAsMarkdown([{ ID: 1, NAME: 'Alice' }, { ID: 2, NAME: 'Bob' }]);
    assert.strictEqual(
      md,
      '| ID | NAME |\n| --- | --- |\n| 1 | Alice |\n| 2 | Bob |'
    );
  });

  test('renders null/undefined cells as empty', function () {
    const md = renderRowsAsMarkdown([{ ID: 1, NOTE: null }]);
    assert.strictEqual(md, '| ID | NOTE |\n| --- | --- |\n| 1 |  |');
  });

  test('escapes a pipe character inside a cell value', function () {
    const md = renderRowsAsMarkdown([{ TEXT: 'a|b' }]);
    assert.ok(md.includes('a\\|b'), `expected an escaped pipe, got: ${md}`);
  });

  test('collapses embedded newlines to a single space', function () {
    const md = renderRowsAsMarkdown([{ TEXT: 'line1\nline2' }]);
    assert.ok(md.includes('line1 line2'), `expected newline collapsed, got: ${md}`);
  });

  test('truncates beyond maxRows and appends a note', function () {
    const rows = Array.from({ length: 5 }, (_, i) => ({ N: i }));
    const md = renderRowsAsMarkdown(rows, 2);
    assert.ok(md.includes('| 0 |'));
    assert.ok(md.includes('| 1 |'));
    assert.ok(!md.includes('| 2 |'));
    assert.ok(md.includes('_...3 more row(s) not shown._'));
  });

  test('does not append a truncation note when under the limit', function () {
    const md = renderRowsAsMarkdown([{ N: 1 }], 500);
    assert.ok(!md.includes('more row(s) not shown'));
  });
});

suite('notebook-render – renderTableAsMarkdown()', function () {
  test('returns a placeholder for an empty result set', function () {
    assert.strictEqual(renderTableAsMarkdown(['ID', 'NAME'], []), '_0 rows returned._');
  });

  test('renders a header row, separator row, and one row per record', function () {
    const md = renderTableAsMarkdown(['ID', 'NAME'], [['1', 'Alice'], ['2', 'Bob']]);
    assert.strictEqual(
      md,
      '| ID | NAME |\n| --- | --- |\n| 1 | Alice |\n| 2 | Bob |'
    );
  });

  test('escapes a pipe character inside a cell value', function () {
    const md = renderTableAsMarkdown(['TEXT'], [['a|b']]);
    assert.ok(md.includes('a\\|b'), `expected an escaped pipe, got: ${md}`);
  });

  test('collapses embedded newlines to a single space', function () {
    const md = renderTableAsMarkdown(['TEXT'], [['line1\nline2']]);
    assert.ok(md.includes('line1 line2'), `expected newline collapsed, got: ${md}`);
  });

  test('truncates beyond maxRows and appends a note', function () {
    const rows = Array.from({ length: 5 }, (_, i) => [String(i)]);
    const md = renderTableAsMarkdown(['N'], rows, 2);
    assert.ok(md.includes('| 0 |'));
    assert.ok(md.includes('| 1 |'));
    assert.ok(!md.includes('| 2 |'));
    assert.ok(md.includes('_...3 more row(s) not shown._'));
  });

  test('does not append a truncation note when under the limit', function () {
    const md = renderTableAsMarkdown(['N'], [['1']], 500);
    assert.ok(!md.includes('more row(s) not shown'));
  });
});
