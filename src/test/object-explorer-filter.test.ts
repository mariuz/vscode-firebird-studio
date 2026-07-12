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
