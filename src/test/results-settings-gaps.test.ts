import * as assert from 'assert';
import { getOptions, DEFAULT_SHORTCUTS } from '../config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json');

suite('Results panel settings gaps (mssql 1.45.1 alignment)', () => {
  suite('DEFAULT_SHORTCUTS', () => {
    test('contains plain copySelection mapping to ctrlcmd+c', () => {
      assert.strictEqual(DEFAULT_SHORTCUTS['event.copySelection'], 'ctrlcmd+c');
    });

    test('preserves existing toggleFreezeColumn and copy variants', () => {
      assert.strictEqual(DEFAULT_SHORTCUTS['event.toggleFreezeColumn'], 'ctrlcmd+alt+z');
      assert.strictEqual(DEFAULT_SHORTCUTS['event.copyAsInsert'], 'ctrlcmd+alt+i');
      assert.strictEqual(DEFAULT_SHORTCUTS['event.copyAsInClause'], 'ctrlcmd+alt+k');
      assert.strictEqual(DEFAULT_SHORTCUTS['event.copyAsMarkdown'], 'ctrlcmd+alt+m');
    });
  });

  suite('getOptions() defaults and custom overrides', () => {
    test('freezeFirstColumnByDefault defaults to false', () => {
      const options = getOptions();
      assert.strictEqual(options.freezeFirstColumnByDefault, false);
    });

    test('showBatchMessages defaults to true', () => {
      const options = getOptions();
      assert.strictEqual(options.showBatchMessages, true);
    });

    test('reads user-configured booleans when present', () => {
      const vscode = require('vscode');
      const orig = vscode.workspace.getConfiguration;
      try {
        vscode.workspace.getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'resultsGrid.freezeFirstColumnByDefault') { return true; }
            if (key === 'results.showBatchMessages') { return false; }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });
        const opts = getOptions();
        assert.strictEqual(opts.freezeFirstColumnByDefault, true);
        assert.strictEqual(opts.showBatchMessages, false);
      } finally {
        vscode.workspace.getConfiguration = orig;
      }
    });
  });

  suite('package.json contributions', () => {
    const props = pkg.contributes.configuration.properties;

    test('declares firebird.resultsGrid.freezeFirstColumnByDefault', () => {
      const prop = props['firebird.resultsGrid.freezeFirstColumnByDefault'];
      assert.ok(prop, 'property should be declared');
      assert.strictEqual(prop.type, 'boolean');
      assert.strictEqual(prop.default, false);
    });

    test('declares firebird.results.showBatchMessages', () => {
      const prop = props['firebird.results.showBatchMessages'];
      assert.ok(prop, 'property should be declared');
      assert.strictEqual(prop.type, 'boolean');
      assert.strictEqual(prop.default, true);
    });

    test('firebird.shortcuts documents event.copySelection and Ctrl+Insert', () => {
      const desc = props['firebird.shortcuts'].markdownDescription;
      assert.ok(desc.includes('event.copySelection'), desc);
      assert.ok(desc.includes('Ctrl+Insert'), desc);
    });
  });
});
