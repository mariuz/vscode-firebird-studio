import * as assert from 'assert';
import { themeColorIdFor, CONNECTION_COLORS } from '../shared/connection-color';

suite('connection-color – themeColorIdFor()', function () {
  test('maps every palette color to a terminal.ansi* theme color id', function () {
    assert.strictEqual(themeColorIdFor('red'), 'terminal.ansiRed');
    assert.strictEqual(themeColorIdFor('yellow'), 'terminal.ansiYellow');
    assert.strictEqual(themeColorIdFor('green'), 'terminal.ansiGreen');
    assert.strictEqual(themeColorIdFor('blue'), 'terminal.ansiBlue');
    assert.strictEqual(themeColorIdFor('purple'), 'terminal.ansiMagenta');
  });

  test('returns undefined for "no color"', function () {
    assert.strictEqual(themeColorIdFor(undefined), undefined);
  });

  test('CONNECTION_COLORS lists exactly the colors themeColorIdFor() maps', function () {
    CONNECTION_COLORS.forEach(color => {
      assert.ok(themeColorIdFor(color), `expected a theme color id for "${color}"`);
    });
  });
});
