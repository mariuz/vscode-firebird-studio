/**
 * Unit coverage for src/profiler/htmlContent/js/app.js's helper functions, via its existing
 * `module.exports.__test__` hook (previously unused by any committed test — see
 * src/test/webview-harness.ts's doc comment).
 */

import * as assert from 'assert';
import * as path from 'path';
import { installWebviewStubs, loadWebviewModule } from './webview-harness';

const APP_JS_PATH = path.join(__dirname, '..', '..', 'src', 'profiler', 'htmlContent', 'js', 'app.js');

suite('profiler app.js – helpers (via __test__ hook)', function () {
  let hooks: any;
  let restore: () => void;

  suiteSetup(function () {
    restore = installWebviewStubs();
    hooks = loadWebviewModule(APP_JS_PATH).__test__;
  });
  suiteTeardown(function () { restore(); });

  suite('rate()', function () {
    test('computes a simple delta-over-time rate', function () {
      assert.strictEqual(hooks.rate(110, 100, 10), 1);
    });

    test('a decreasing cumulative counter (attachment id reused) returns null, not a negative rate', function () {
      assert.strictEqual(hooks.rate(50, 100, 10), null);
    });

    test('treats a missing/falsy current value as 0', function () {
      assert.strictEqual(hooks.rate(null, 0, 10), 0);
    });

    test('an unchanged counter is a rate of 0, not null', function () {
      assert.strictEqual(hooks.rate(100, 100, 10), 0);
    });
  });

  suite('truncateOneLine()', function () {
    test('collapses embedded whitespace/newlines to single spaces', function () {
      assert.strictEqual(hooks.truncateOneLine('select *\nfrom   t', 80), 'select * from t');
    });

    test('leaves short text untouched (no ellipsis)', function () {
      assert.strictEqual(hooks.truncateOneLine('short', 80), 'short');
    });

    test('truncates and appends an ellipsis once past max length', function () {
      const result = hooks.truncateOneLine('a'.repeat(100), 10);
      assert.strictEqual(result, `${'a'.repeat(10)}…`);
    });

    test('trims leading/trailing whitespace before measuring length', function () {
      assert.strictEqual(hooks.truncateOneLine('   padded   ', 80), 'padded');
    });
  });

  suite('isolationLabel()', function () {
    test('maps known RDB$ISOLATION_MODE values to their labels', function () {
      assert.strictEqual(hooks.isolationLabel(0), 'Consistency');
      assert.strictEqual(hooks.isolationLabel(1), 'Concurrency (Snapshot)');
      assert.strictEqual(hooks.isolationLabel(4), 'Read Committed (Read Consistency)');
    });

    test('falls back to "Mode N" for an unrecognized value', function () {
      assert.strictEqual(hooks.isolationLabel(99), 'Mode 99');
    });
  });

  suite('matchesFilter()', function () {
    const row = { USER_NAME: 'SYSDBA', REMOTE_ADDRESS: '192.168.1.5', ATTACHMENT_STATE: 1, SQL_TEXT: 'SELECT * FROM CUSTOMERS' };

    test('an empty filter matches everything', function () {
      assert.strictEqual(hooks.matchesFilter(row, ''), true);
    });

    test('matches against the user name, case-insensitively', function () {
      assert.strictEqual(hooks.matchesFilter(row, 'sysdba'), true);
    });

    test('matches against the remote address', function () {
      assert.strictEqual(hooks.matchesFilter(row, '192.168'), true);
    });

    test('matches "active"/"idle" derived from ATTACHMENT_STATE, not a raw field', function () {
      assert.strictEqual(hooks.matchesFilter(row, 'active'), true);
      assert.strictEqual(hooks.matchesFilter({ ...row, ATTACHMENT_STATE: 0 }, 'active'), false);
      assert.strictEqual(hooks.matchesFilter({ ...row, ATTACHMENT_STATE: 0 }, 'idle'), true);
    });

    test('matches against the SQL text', function () {
      assert.strictEqual(hooks.matchesFilter(row, 'customers'), true);
    });

    test('a non-matching filter excludes the row', function () {
      assert.strictEqual(hooks.matchesFilter(row, 'nope'), false);
    });

    test('tolerates missing fields (null SQL_TEXT) without throwing', function () {
      const sparse = { USER_NAME: 'X', REMOTE_ADDRESS: null, ATTACHMENT_STATE: 0, SQL_TEXT: null };
      assert.strictEqual(hooks.matchesFilter(sparse, 'x'), true);
    });
  });

  suite('lockTimeoutLabel()', function () {
    test('-1 means infinite', function () {
      assert.strictEqual(hooks.lockTimeoutLabel(-1), 'Infinite');
    });
    test('0 means no wait', function () {
      assert.strictEqual(hooks.lockTimeoutLabel(0), 'No Wait');
    });
    test('a positive value is shown in seconds', function () {
      assert.strictEqual(hooks.lockTimeoutLabel(30), '30s');
    });
    test('null/undefined renders as an empty string', function () {
      assert.strictEqual(hooks.lockTimeoutLabel(null), '');
      assert.strictEqual(hooks.lockTimeoutLabel(undefined), '');
    });
  });

  suite('formatDuration()', function () {
    test('formats sub-minute durations in seconds', function () {
      assert.strictEqual(hooks.formatDuration(45000), '45s');
    });
    test('formats sub-hour durations in minutes + seconds', function () {
      assert.strictEqual(hooks.formatDuration(125000), '2m 5s');
    });
    test('formats durations over an hour in hours + minutes', function () {
      assert.strictEqual(hooks.formatDuration(2 * 3600000 + 15 * 60000), '2h 15m');
    });
    test('clamps a negative duration to 0s rather than throwing or going negative', function () {
      assert.strictEqual(hooks.formatDuration(-500), '0s');
    });
  });

  suite('lastDefined()', function () {
    test('returns the last non-null/undefined value', function () {
      assert.strictEqual(hooks.lastDefined([1, 2, null, undefined]), 2);
    });
    test('returns the true last value when it is itself defined', function () {
      assert.strictEqual(hooks.lastDefined([1, 2, 3]), 3);
    });
    test('returns null when every value is null/undefined', function () {
      assert.strictEqual(hooks.lastDefined([null, undefined]), null);
    });
    test('returns null for an empty array', function () {
      assert.strictEqual(hooks.lastDefined([]), null);
    });
    test('0 is a defined value, not skipped', function () {
      assert.strictEqual(hooks.lastDefined([5, 0]), 0);
    });
  });

  suite('buildSparklineSvg()', function () {
    test('returns well-formed SVG markup with a path per series', function () {
      const svg = hooks.buildSparklineSvg([{ values: [1, 2, 3] }]);
      assert.ok(svg.startsWith('<svg'), svg);
      assert.ok(svg.includes('<path'), svg);
    });

    test('a null/undefined value breaks the line rather than interpolating through it (starts a new "M" segment)', function () {
      const svg = hooks.buildSparklineSvg([{ values: [1, null, 3] }]);
      assert.strictEqual((svg.match(/M /g) || []).length, 2, svg);
    });

    test('renders two series with distinct colors', function () {
      const svg = hooks.buildSparklineSvg([{ values: [1, 2] }, { values: [3, 4] }]);
      assert.strictEqual((svg.match(/<path/g) || []).length, 2, svg);
    });

    test('an explicit maxValue option is honored instead of the data\'s own max', function () {
      const svg = hooks.buildSparklineSvg([{ values: [50] }], { maxValue: 100 });
      assert.ok(!svg.includes('NaN'), svg);
    });
  });

  suite('handleActivityData() — smoke test through the real render pipeline against stub DOM', function () {
    test('processes a real activity payload without throwing, and updates internal state', function () {
      hooks.handleActivityData({
        rows: [
          { ATTACHMENT_ID: 1, USER_NAME: 'SYSDBA', REMOTE_ADDRESS: '127.0.0.1', ATTACHMENT_STATE: 1, ISOLATION_MODE: 1, SQL_TEXT: 'SELECT 1', PAGE_READS: 10, PAGE_WRITES: 2, PAGE_FETCHES: 20 },
        ],
      });
      assert.strictEqual(hooks.getPrevious().size, 1, 'one connection should be tracked after the first poll');
    });

    test('an empty rows array resets tracked state (previous/pinned) rather than throwing', function () {
      hooks.handleActivityData({ rows: [{ ATTACHMENT_ID: 1, USER_NAME: 'X', ATTACHMENT_STATE: 1 }] });
      hooks.handleActivityData({ rows: [] });
      assert.strictEqual(hooks.getPrevious().size, 0);
      assert.strictEqual(hooks.getPinned().size, 0);
    });

    test('an error payload does not throw and does not add to history', function () {
      const before = hooks.getHistory().length;
      hooks.handleActivityData({ error: 'connection lost' });
      assert.strictEqual(hooks.getHistory().length, before);
    });
  });
});
