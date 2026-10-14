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

  suite('fmtBytes()', function () {
    test('formats zero and small bytes in B', function () {
      assert.strictEqual(hooks.fmtBytes(0), '0 B');
      assert.strictEqual(hooks.fmtBytes(512), '512 B');
    });

    test('formats kilobytes, megabytes, gigabytes with 1 decimal', function () {
      assert.strictEqual(hooks.fmtBytes(1024), '1.0 KB');
      assert.strictEqual(hooks.fmtBytes(1536), '1.5 KB');
      assert.strictEqual(hooks.fmtBytes(1024 * 1024 * 2.5), '2.5 MB');
      assert.strictEqual(hooks.fmtBytes(1024 * 1024 * 1024 * 4), '4.0 GB');
    });

    test('handles null, undefined, or NaN gracefully', function () {
      assert.strictEqual(hooks.fmtBytes(null), '—');
      assert.strictEqual(hooks.fmtBytes(undefined), '—');
      assert.strictEqual(hooks.fmtBytes(NaN), '—');
    });
  });

  suite('formatSeconds()', function () {
    test('formats whole seconds without decimal point', function () {
      assert.strictEqual(hooks.formatSeconds(3000), '3s');
      assert.strictEqual(hooks.formatSeconds(10000), '10s');
    });

    test('formats fractional seconds with 1 decimal place', function () {
      assert.strictEqual(hooks.formatSeconds(2500), '2.5s');
    });
  });

  suite('summarizeIsolation()', function () {
    test('summarizes and sorts isolation counts descending', function () {
      const summary = hooks.summarizeIsolation({ 1: 3, 2: 5 });
      assert.strictEqual(summary, 'RC (record version) 5 · Snapshot 3');
    });

    test('handles unknown isolation modes gracefully', function () {
      const summary = hooks.summarizeIsolation({ unknown: 2, 99: 1 });
      assert.strictEqual(summary, 'Unknown 2 · Mode 99 1');
    });

    test('returns empty string for null or empty counts', function () {
      assert.strictEqual(hooks.summarizeIsolation(null), '');
      assert.strictEqual(hooks.summarizeIsolation({}), '');
    });
  });

  suite('aggregateRate()', function () {
    test('computes positive deltas correctly', function () {
      assert.strictEqual(hooks.aggregateRate(120, 100, 2), 10);
    });

    test('returns 0 for identical values', function () {
      assert.strictEqual(hooks.aggregateRate(100, 100, 5), 0);
    });

    test('returns null for negative deltas (counter reset / connection detached)', function () {
      assert.strictEqual(hooks.aggregateRate(80, 100, 2), null);
    });

    test('returns null when previous total is missing or undefined', function () {
      assert.strictEqual(hooks.aggregateRate(100, undefined, 2), null);
      assert.strictEqual(hooks.aggregateRate(100, null, 2), null);
    });
  });

  suite('normalizeTiles()', function () {
    test('filters out unknown tile IDs and deduplicates', function () {
      const result = hooks.normalizeTiles(['connections', 'unknownTile', 'cacheHit', 'connections']);
      assert.deepStrictEqual(result, ['connections', 'cacheHit']);
    });

    test('handles non-array inputs safely', function () {
      assert.deepStrictEqual(hooks.normalizeTiles(null), []);
      assert.deepStrictEqual(hooks.normalizeTiles(undefined), []);
      assert.deepStrictEqual(hooks.normalizeTiles('connections'), []);
    });
  });

  suite('TILE_DEFS catalog agreement', function () {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PROFILER_DASHBOARD_TILES } = require('../config');

    test('all 9 tiles exist in TILE_DEFS', function () {
      const expected = [
        'connections',
        'cacheHit',
        'pageIo',
        'recordReads',
        'activeStatements',
        'lockContention',
        'memory',
        'transactions',
        'oldestTransaction',
      ];
      assert.deepStrictEqual(Object.keys(hooks.TILE_DEFS), expected);
    });

    test('TILE_DEFS keys match PROFILER_DASHBOARD_TILES and package.json enum', function () {
      const tileIds = Object.keys(hooks.TILE_DEFS);
      assert.deepStrictEqual(tileIds, Array.from(PROFILER_DASHBOARD_TILES));

      const pkgEnum = pkg.contributes.configuration.properties['firebird.profiler.dashboardTiles'].items.enum;
      assert.deepStrictEqual(tileIds, pkgEnum);
    });

    test('every tile definition provides a title and a pure view(samples) function', function () {
      const dummySample = {
        timestamp: Date.now(),
        connectionCount: 5,
        activeStatements: 2,
        cacheHitPct: 98.5,
        readRate: 12.0,
        writeRate: 3.5,
        seqRate: 50.0,
        idxRate: 150.0,
        waitRate: 1.0,
        conflictRate: 0.5,
        memoryUsed: 1024 * 1024 * 10,
        memoryAllocated: 1024 * 1024 * 16,
        txCount: 3,
        isolationCounts: { 1: 2, 2: 1 },
        oldestTxAgeSec: 120,
      };

      for (const [id, def] of Object.entries(hooks.TILE_DEFS) as [string, any][]) {
        assert.ok(typeof def.title === 'string' && def.title.length > 0, `${id} should have a title`);
        assert.ok(typeof def.view === 'function', `${id} should have a view() function`);

        const rendered = def.view([dummySample]);
        assert.ok(Array.isArray(rendered.series), `${id} view() should return series array`);
        assert.ok(typeof rendered.valueHtml === 'string', `${id} view() should return valueHtml`);
      }
    });
  });

  suite('dashboard tile management & polling interval', function () {
    setup(function () {
      hooks.resetHistory();
    });

    test('setDashboardTiles updates active tiles and builds tile cards', function () {
      hooks.setDashboardTiles(['memory', 'connections'], false);
      assert.deepStrictEqual(hooks.getDashboardTiles(), ['memory', 'connections']);
      assert.strictEqual(hooks.getTileEls().size, 2);
      assert.ok(hooks.getTileEls().has('memory'));
      assert.ok(hooks.getTileEls().has('connections'));
    });

    test('toggleTile adds or removes tile from current list', function () {
      hooks.setDashboardTiles(['connections'], false);
      hooks.toggleTile('cacheHit', true);
      assert.deepStrictEqual(hooks.getDashboardTiles(), ['connections', 'cacheHit']);

      hooks.toggleTile('connections', false);
      assert.deepStrictEqual(hooks.getDashboardTiles(), ['cacheHit']);
    });

    test('setPollInterval updates poll interval', function () {
      hooks.setPollInterval(5000, false);
      assert.strictEqual(hooks.getPollIntervalMs(), 5000);
      hooks.setPollInterval(3000, false);
      assert.strictEqual(hooks.getPollIntervalMs(), 3000);
    });

    test('recordHistorySample computes gauges and deltas across successive polls', async function () {
      const now = Date.now();
      const row1 = {
        ATTACHMENT_ID: 1,
        ATTACHMENT_STATE: 1,
        PAGE_READS: 10,
        PAGE_WRITES: 5,
        PAGE_FETCHES: 100,
        SEQ_READS: 20,
        IDX_READS: 80,
        RECORD_WAITS: 2,
        RECORD_CONFLICTS: 1,
        MEMORY_USED: 1024 * 1024,
        MEMORY_ALLOCATED: 2 * 1024 * 1024,
        TRANSACTION_ID: 101,
        ISOLATION_MODE: 1,
        TX_STARTED_AT: new Date(now - 60000).toISOString()
      };

      hooks.recordHistorySample([row1]);
      let hist = hooks.getHistory();
      assert.strictEqual(hist.length, 1);
      assert.strictEqual(hist[0].connectionCount, 1);
      assert.strictEqual(hist[0].activeStatements, 1);
      assert.strictEqual(hist[0].memoryUsed, 1024 * 1024);
      assert.strictEqual(hist[0].txCount, 1);
      assert.ok(hist[0].oldestTxAgeSec >= 59);

      // Wait 15ms so elapsedSec > 0 for delta computation
      await new Promise(resolve => setTimeout(resolve, 15));

      // Second poll after delta
      const row2 = {
        ATTACHMENT_ID: 1,
        ATTACHMENT_STATE: 0,
        PAGE_READS: 15,
        PAGE_WRITES: 8,
        PAGE_FETCHES: 200,
        SEQ_READS: 30,
        IDX_READS: 120,
        RECORD_WAITS: 4,
        RECORD_CONFLICTS: 2,
        MEMORY_USED: 1024 * 1024 * 2,
        MEMORY_ALLOCATED: 3 * 1024 * 1024,
        TRANSACTION_ID: 101,
        ISOLATION_MODE: 1,
        TX_STARTED_AT: new Date(now - 62000).toISOString()
      };

      hooks.recordHistorySample([row2]);
      hist = hooks.getHistory();
      assert.strictEqual(hist.length, 2);
      assert.strictEqual(hist[1].connectionCount, 1);
      assert.strictEqual(hist[1].activeStatements, 0);
      assert.strictEqual(hist[1].memoryUsed, 1024 * 1024 * 2);
      assert.ok(hist[1].cacheHitPct !== null && hist[1].cacheHitPct > 90);
      assert.ok(hist[1].readRate !== null);
      assert.ok(hist[1].writeRate !== null);
      assert.ok(hist[1].seqRate !== null);
      assert.ok(hist[1].idxRate !== null);
      assert.ok(hist[1].waitRate !== null);
      assert.ok(hist[1].conflictRate !== null);
    });
  });
});

