import * as assert from 'assert';
import { extractJson } from '../copilot/json-extraction';

suite('json-extraction – extractJson()', function () {
  test('returns bare JSON unchanged', function () {
    assert.strictEqual(extractJson('{"a":1}'), '{"a":1}');
  });

  test('strips a ```json fenced block', function () {
    assert.strictEqual(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  });

  test('strips a bare ``` fenced block (no language tag)', function () {
    assert.strictEqual(extractJson('```\n{"a":1}\n```'), '{"a":1}');
  });

  test('trims surrounding whitespace', function () {
    assert.strictEqual(extractJson('  \n{"a":1}\n  '), '{"a":1}');
  });

  test('trims whitespace inside the fence too', function () {
    assert.strictEqual(extractJson('```json\n\n  {"a":1}  \n\n```'), '{"a":1}');
  });

  test('is case-insensitive about the "json" language tag', function () {
    assert.strictEqual(extractJson('```JSON\n{"a":1}\n```'), '{"a":1}');
  });
});
