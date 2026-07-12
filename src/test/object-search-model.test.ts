import * as assert from 'assert';
import { buildSearchIndex, kindLabel, ObjectSearchInput } from '../object-search/search-model';

function emptyInput(overrides: Partial<ObjectSearchInput> = {}): ObjectSearchInput {
  return { tables: [], views: [], procedures: [], triggers: [], generators: [], domains: [], ...overrides };
}

suite('object-search-model – kindLabel()', function () {
  test('maps every kind to a human-readable label', function () {
    assert.strictEqual(kindLabel('TABLE'), 'Table');
    assert.strictEqual(kindLabel('VIEW'), 'View');
    assert.strictEqual(kindLabel('PROCEDURE'), 'Procedure');
    assert.strictEqual(kindLabel('TRIGGER'), 'Trigger');
    assert.strictEqual(kindLabel('GENERATOR'), 'Generator');
    assert.strictEqual(kindLabel('DOMAIN'), 'Domain');
  });
});

suite('object-search-model – buildSearchIndex()', function () {
  test('returns an empty array when every object type is empty', function () {
    assert.deepStrictEqual(buildSearchIndex(emptyInput()), []);
  });

  test('trims names and tags each result with its object kind', function () {
    const index = buildSearchIndex(emptyInput({ tables: [{ TABLE_NAME: '  CUSTOMERS  ' }] }));
    assert.strictEqual(index.length, 1);
    assert.strictEqual(index[0].name, 'CUSTOMERS');
    assert.strictEqual(index[0].kind, 'TABLE');
  });

  test('includes every object type', function () {
    const index = buildSearchIndex({
      tables: [{ TABLE_NAME: 'T1' }],
      views: [{ VIEW_NAME: 'V1' }],
      procedures: [{ PROCEDURE_NAME: 'P1' }],
      triggers: [{ TRIGGER_NAME: 'TR1' }],
      generators: [{ GENERATOR_NAME: 'G1' }],
      domains: [{ DOMAIN_NAME: 'D1' }],
    });
    const kinds = index.map(r => r.kind).sort();
    assert.deepStrictEqual(kinds, ['DOMAIN', 'GENERATOR', 'PROCEDURE', 'TABLE', 'TRIGGER', 'VIEW']);
  });

  test('keeps the original row for constructing the matching Node* class later', function () {
    const triggerRow = { TRIGGER_NAME: 'TR_AUDIT', TABLE_NAME: 'ORDERS', TRIGGER_TYPE: 1, INACTIVE: 0 };
    const index = buildSearchIndex(emptyInput({ triggers: [triggerRow] }));
    assert.strictEqual(index[0].row, triggerRow);
  });

  test('sorts the combined index alphabetically by name, across object types', function () {
    const index = buildSearchIndex({
      tables: [{ TABLE_NAME: 'ZEBRA' }],
      views: [{ VIEW_NAME: 'APPLE' }],
      procedures: [{ PROCEDURE_NAME: 'MANGO' }],
      triggers: [],
      generators: [],
      domains: [],
    });
    assert.deepStrictEqual(index.map(r => r.name), ['APPLE', 'MANGO', 'ZEBRA']);
  });
});
