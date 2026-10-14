import * as assert from 'assert';
import * as vscode from 'vscode';
import { getOptions, PROFILER_DASHBOARD_TILES, MIN_PROFILER_POLL_INTERVAL_MS } from '../config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json');

suite('Profiler settings & customizable dashboard', () => {
  suite('package.json contributions', () => {
    const props = pkg.contributes.configuration.properties;

    test('declares firebird.profiler.pollIntervalMs with default 3000 and minimum 500', () => {
      const prop = props['firebird.profiler.pollIntervalMs'];
      assert.ok(prop, 'property should be declared');
      assert.strictEqual(prop.type, 'number');
      assert.strictEqual(prop.default, 3000);
      assert.strictEqual(prop.minimum, 500);
    });

    test('declares firebird.profiler.dashboardTiles with array of known tiles', () => {
      const prop = props['firebird.profiler.dashboardTiles'];
      assert.ok(prop, 'property should be declared');
      assert.strictEqual(prop.type, 'array');
      assert.strictEqual(prop.uniqueItems, true);
      assert.deepStrictEqual(prop.default, ['connections', 'cacheHit', 'pageIo']);
      assert.deepStrictEqual(prop.items.enum, Array.from(PROFILER_DASHBOARD_TILES));
    });
  });

  suite('getOptions() defaults and validation', () => {
    test('returns default profilerPollIntervalMs (3000) and dashboardTiles', () => {
      const options = getOptions();
      assert.strictEqual(options.profilerPollIntervalMs, 3000);
      assert.deepStrictEqual(options.profilerDashboardTiles, ['connections', 'cacheHit', 'pageIo']);
    });

    test('reads valid user-configured pollIntervalMs and dashboardTiles', () => {
      const orig = vscode.workspace.getConfiguration;
      try {
        vscode.workspace.getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'profiler.pollIntervalMs') { return 5000; }
            if (key === 'profiler.dashboardTiles') { return ['memory', 'transactions', 'lockContention']; }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });
        const opts = getOptions();
        assert.strictEqual(opts.profilerPollIntervalMs, 5000);
        assert.deepStrictEqual(opts.profilerDashboardTiles, ['memory', 'transactions', 'lockContention']);
      } finally {
        vscode.workspace.getConfiguration = orig;
      }
    });

    test('falls back to default when pollIntervalMs is below MIN_PROFILER_POLL_INTERVAL_MS or invalid', () => {
      const orig = vscode.workspace.getConfiguration;
      try {
        // Less than 500
        vscode.workspace.getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'profiler.pollIntervalMs') { return 100; }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });
        let opts = getOptions();
        assert.strictEqual(opts.profilerPollIntervalMs, 3000);

        // Not a number
        vscode.workspace.getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'profiler.pollIntervalMs') { return 'invalid'; }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });
        opts = getOptions();
        assert.strictEqual(opts.profilerPollIntervalMs, 3000);
      } finally {
        vscode.workspace.getConfiguration = orig;
      }
    });

    test('filters unknown tile IDs and deduplicates in dashboardTiles', () => {
      const orig = vscode.workspace.getConfiguration;
      try {
        vscode.workspace.getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'profiler.dashboardTiles') {
              return ['memory', 'fakeTile', 'memory', 'pageIo', 123];
            }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });
        const opts = getOptions();
        assert.deepStrictEqual(opts.profilerDashboardTiles, ['memory', 'pageIo']);
      } finally {
        vscode.workspace.getConfiguration = orig;
      }
    });

    test('falls back to default if dashboardTiles is not an array', () => {
      const orig = vscode.workspace.getConfiguration;
      try {
        vscode.workspace.getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'profiler.dashboardTiles') { return 'not-an-array'; }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });
        const opts = getOptions();
        assert.deepStrictEqual(opts.profilerDashboardTiles, ['connections', 'cacheHit', 'pageIo']);
      } finally {
        vscode.workspace.getConfiguration = orig;
      }
    });
  });
});
