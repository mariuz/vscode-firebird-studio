import * as assert from 'assert';
import { copilotScopingPrompt, parseTableAccessResponse } from '../data-api-builder';

// ── copilotScopingPrompt() ────────────────────────────────────────────────────
//
// Data API Builder phase 3 (docs/roadmap/data-api-builder.md): Copilot-assisted scoping asks the
// model for a small structured JSON decision (which tables, "full" vs "read-only") rather than a
// raw OpenAPI spec — buildOpenApiSpec() (already proven) turns that into the actual spec.

suite('data-api-builder – copilotScopingPrompt()', function () {
  test('lists every available table name', function () {
    const prompt = copilotScopingPrompt(['CUSTOMERS', 'ORDERS', 'LOG'], 'expose customers read-only');
    assert.ok(prompt.includes('CUSTOMERS, ORDERS, LOG'), prompt);
  });

  test('includes the user\'s instruction verbatim', function () {
    const prompt = copilotScopingPrompt(['CUSTOMERS'], 'expose customers and orders as read-only');
    assert.ok(prompt.includes('expose customers and orders as read-only'), prompt);
  });

  test('asks for the exact {"tables": {...}} JSON shape, no markdown fence', function () {
    const prompt = copilotScopingPrompt(['A'], 'x');
    assert.ok(prompt.includes('{"tables":{"TABLE_NAME":"full"}}'), prompt);
    assert.ok(prompt.includes('no markdown fence'), prompt);
  });
});

// ── parseTableAccessResponse() ────────────────────────────────────────────────

suite('data-api-builder – parseTableAccessResponse()', function () {
  const knownTables = ['CUSTOMERS', 'ORDERS', 'LOG'];

  test('parses a clean {"tables": {...}} response', function () {
    const result = parseTableAccessResponse('{"tables":{"CUSTOMERS":"read-only","ORDERS":"full"}}', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'read-only', ORDERS: 'full' });
  });

  test('strips a ```json fence, matching extractJson()', function () {
    const result = parseTableAccessResponse('```json\n{"tables":{"CUSTOMERS":"full"}}\n```', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'full' });
  });

  test('normalizes case against the real table name, not whatever casing the model used', function () {
    const result = parseTableAccessResponse('{"tables":{"customers":"full"}}', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'full' });
  });

  test('drops a hallucinated/misspelled table name rather than trusting it', function () {
    const result = parseTableAccessResponse('{"tables":{"CUSTOMERS":"full","NONEXISTENT_TABLE":"full"}}', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'full' });
  });

  test('treats any access value other than exactly "read-only" as "full"', function () {
    const result = parseTableAccessResponse('{"tables":{"CUSTOMERS":"readonly","ORDERS":"something-else"}}', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'full', ORDERS: 'full' });
  });

  test('returns an empty object when every named table is unrecognized', function () {
    const result = parseTableAccessResponse('{"tables":{"NOPE":"full"}}', knownTables);
    assert.deepStrictEqual(result, {});
  });

  test('returns an empty object for an explicitly empty tables map (Copilot decided nothing matched)', function () {
    const result = parseTableAccessResponse('{"tables":{}}', knownTables);
    assert.deepStrictEqual(result, {});
  });

  test('throws with the raw response included when the model did not return valid JSON', function () {
    assert.throws(() => parseTableAccessResponse('Sure, here you go: not json', knownTables), /Copilot didn't return valid JSON/);
  });

  test('throws when the JSON is valid but missing the "tables" key', function () {
    assert.throws(() => parseTableAccessResponse('{"foo":"bar"}', knownTables), /expected \{"tables": \{\.\.\.\}\} shape/);
  });

  test('throws when "tables" is not an object', function () {
    assert.throws(() => parseTableAccessResponse('{"tables":"CUSTOMERS"}', knownTables), /expected \{"tables": \{\.\.\.\}\} shape/);
  });
});
