import * as assert from 'assert';
import {
  getObjectFilter,
  setObjectFilter,
  clearObjectFilter,
  matchesObjectFilter,
} from '../shared/object-explorer-filter';

suite('object-explorer-filter', function () {

  test('getObjectFilter returns undefined when nothing has been set for that connection/category', function () {
    assert.strictEqual(getObjectFilter('conn-never-used', 'tables'), undefined);
  });

  test('setObjectFilter stores a filter retrievable by the same connectionId/category', function () {
    setObjectFilter('conn-1', 'tables', 'CUST');
    assert.strictEqual(getObjectFilter('conn-1', 'tables'), 'CUST');
    clearObjectFilter('conn-1', 'tables');
  });

  test('filters are scoped per category, not shared across a connection', function () {
    setObjectFilter('conn-2', 'tables', 'CUST');
    setObjectFilter('conn-2', 'views', 'ACTIVE');
    assert.strictEqual(getObjectFilter('conn-2', 'tables'), 'CUST');
    assert.strictEqual(getObjectFilter('conn-2', 'views'), 'ACTIVE');
    clearObjectFilter('conn-2', 'tables');
    clearObjectFilter('conn-2', 'views');
  });

  test('filters are scoped per connection, not shared across connections', function () {
    setObjectFilter('conn-3a', 'tables', 'CUST');
    assert.strictEqual(getObjectFilter('conn-3b', 'tables'), undefined);
    clearObjectFilter('conn-3a', 'tables');
  });

  test('trims the filter text before storing it', function () {
    setObjectFilter('conn-4', 'tables', '  CUST  ');
    assert.strictEqual(getObjectFilter('conn-4', 'tables'), 'CUST');
    clearObjectFilter('conn-4', 'tables');
  });

  test('setting an empty string clears an existing filter', function () {
    setObjectFilter('conn-5', 'tables', 'CUST');
    setObjectFilter('conn-5', 'tables', '');
    assert.strictEqual(getObjectFilter('conn-5', 'tables'), undefined);
  });

  test('setting a whitespace-only string clears an existing filter', function () {
    setObjectFilter('conn-6', 'tables', 'CUST');
    setObjectFilter('conn-6', 'tables', '   ');
    assert.strictEqual(getObjectFilter('conn-6', 'tables'), undefined);
  });

  test('clearObjectFilter removes a filter that was set', function () {
    setObjectFilter('conn-7', 'tables', 'CUST');
    clearObjectFilter('conn-7', 'tables');
    assert.strictEqual(getObjectFilter('conn-7', 'tables'), undefined);
  });
});

suite('matchesObjectFilter', function () {
  test('matches everything when no filter is set', function () {
    assert.strictEqual(matchesObjectFilter('CUSTOMERS', undefined), true);
  });

  test('is a case-insensitive substring match', function () {
    assert.strictEqual(matchesObjectFilter('CUSTOMERS', 'cust'), true);
    assert.strictEqual(matchesObjectFilter('CUSTOMERS', 'CUST'), true);
    assert.strictEqual(matchesObjectFilter('customers', 'CUST'), true);
  });

  test('rejects a name that does not contain the filter', function () {
    assert.strictEqual(matchesObjectFilter('PRODUCTS', 'cust'), false);
  });

  test('trims trailing padding from fixed-width RDB$ identifier columns before matching', function () {
    assert.strictEqual(matchesObjectFilter('CUSTOMERS                        ', 'cust'), true);
  });
});

suite('object-explorer-filter – presets', function () {
  setup(async function () {
    // Reset preset storage before each test
    const { setSavedPresets, clearAllObjectFilters, initObjectFilterPresets } = await import('../shared/object-explorer-filter');
    initObjectFilterPresets(undefined);
    await setSavedPresets([]);
    clearAllObjectFilters();
  });

  test('saveFilterPreset creates a valid preset with id and timestamp', async function () {
    const { saveFilterPreset, getSavedPresets } = await import('../shared/object-explorer-filter');
    const preset = await saveFilterPreset('Sales Tables', 'SALES_', 'tables');
    assert.ok(preset.id, 'preset must have an id');
    assert.strictEqual(preset.name, 'Sales Tables');
    assert.strictEqual(preset.filter, 'SALES_');
    assert.strictEqual(preset.category, 'tables');
    assert.ok(preset.createdTimestamp && preset.createdTimestamp > 0);

    const saved = getSavedPresets();
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].id, preset.id);
  });

  test('saveFilterPreset rejects empty or whitespace-only name and filter', async function () {
    const { saveFilterPreset } = await import('../shared/object-explorer-filter');
    await assert.rejects(async () => {
      await saveFilterPreset('', 'CUST');
    }, /Preset name cannot be empty/);

    await assert.rejects(async () => {
      await saveFilterPreset('   ', 'CUST');
    }, /Preset name cannot be empty/);

    await assert.rejects(async () => {
      await saveFilterPreset('Cust Tables', '');
    }, /Preset filter expression cannot be empty/);

    await assert.rejects(async () => {
      await saveFilterPreset('Cust Tables', '   ');
    }, /Preset filter expression cannot be empty/);
  });

  test('saveFilterPreset updates existing preset when name and scope match', async function () {
    const { saveFilterPreset, getSavedPresets } = await import('../shared/object-explorer-filter');
    const first = await saveFilterPreset('Orders', 'ORD_', 'tables');
    const second = await saveFilterPreset('Orders', 'ORDER_', 'tables');

    const saved = getSavedPresets();
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(second.id, first.id);
    assert.strictEqual(saved[0].filter, 'ORDER_');
  });

  test('deleteFilterPreset deletes preset by id', async function () {
    const { saveFilterPreset, deleteFilterPreset, getSavedPresets } = await import('../shared/object-explorer-filter');
    const p1 = await saveFilterPreset('P1', 'FILTER_1');
    const p2 = await saveFilterPreset('P2', 'FILTER_2');

    assert.strictEqual(getSavedPresets().length, 2);

    const deleted = await deleteFilterPreset(p1.id);
    assert.strictEqual(deleted, true);
    const remaining = getSavedPresets();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, p2.id);

    const notFound = await deleteFilterPreset('non-existent-id');
    assert.strictEqual(notFound, false);
  });

  test('getAllFilterPresets filters by category scope and connection scope', async function () {
    const { saveFilterPreset, getAllFilterPresets } = await import('../shared/object-explorer-filter');
    await saveFilterPreset('Universal', 'UNI_');
    await saveFilterPreset('Tables Only', 'TBL_', 'tables');
    await saveFilterPreset('Views Only', 'VW_', 'views');
    await saveFilterPreset('Conn1 Tables', 'CONN1_', 'tables', 'conn-1');

    const allForTablesConn1 = getAllFilterPresets('tables', 'conn-1');
    const names1 = allForTablesConn1.map(p => p.name);
    assert.ok(names1.includes('Universal'), 'Universal preset should match tables');
    assert.ok(names1.includes('Tables Only'), 'Tables Only preset should match tables');
    assert.ok(names1.includes('Conn1 Tables'), 'Conn1 Tables should match conn-1');
    assert.ok(!names1.includes('Views Only'), 'Views Only preset should not match tables');

    const allForTablesConn2 = getAllFilterPresets('tables', 'conn-2');
    const names2 = allForTablesConn2.map(p => p.name);
    assert.ok(!names2.includes('Conn1 Tables'), 'Conn1 Tables should not match conn-2');

    const allForViews = getAllFilterPresets('views');
    const namesViews = allForViews.map(p => p.name);
    assert.ok(namesViews.includes('Universal'));
    assert.ok(namesViews.includes('Views Only'));
    assert.ok(!namesViews.includes('Tables Only'));
  });

  test('initObjectFilterPresets connects to extension globalState', async function () {
    const { initObjectFilterPresets, saveFilterPreset, getSavedPresets } = await import('../shared/object-explorer-filter');
    const store = new Map<string, any>();
    const fakeContext: any = {
      globalState: {
        get: (k: string) => store.get(k),
        update: async (k: string, v: any) => { store.set(k, v); },
      },
    };

    initObjectFilterPresets(fakeContext);
    await saveFilterPreset('FromContext', 'CTX_');

    const inGlobalState = store.get('firebird.objectFilterPresets');
    assert.ok(Array.isArray(inGlobalState));
    assert.strictEqual(inGlobalState.length, 1);
    assert.strictEqual(inGlobalState[0].name, 'FromContext');

    const retrieved = getSavedPresets();
    assert.strictEqual(retrieved.length, 1);
    assert.strictEqual(retrieved[0].name, 'FromContext');

    // Reset back to undefined for downstream tests
    initObjectFilterPresets(undefined);
  });
});

