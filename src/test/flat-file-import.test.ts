import * as assert from 'assert';
import { buildTypeSuggestionPrompt, parseSuggestedSchema } from '../flat-file-import';
import { ColumnInference } from '../shared/flat-file-parser';

// ── buildTypeSuggestionPrompt() ───────────────────────────────────────────────
//
// Flat File Import Wizard phase 4 (docs/roadmap/flat-file-import-wizard.md): Copilot-assisted
// type/naming suggestions ask the model for a small structured JSON decision (one name/sqlType/
// nullable triple per column index), never a raw CREATE TABLE statement — buildCreateTableDDL()
// (already proven by the plain "create new table" path) turns the result into DDL.

function schema(overrides: Partial<ColumnInference> & { name: string } = { name: 'COL' }): ColumnInference {
  return { sqlType: 'VARCHAR(50)', nullable: true, ...overrides };
}

suite('flat-file-import – buildTypeSuggestionPrompt()', function () {
  test('describes every column by index, header, inferred type, and nullability', function () {
    const prompt = buildTypeSuggestionPrompt('customers.csv', [
      schema({ name: 'ID', sqlType: 'INTEGER', nullable: false }),
      schema({ name: 'ZIP', sqlType: 'INTEGER', nullable: true }),
    ], [['1', '02139'], ['2', '94105']]);
    assert.ok(prompt.includes('0: header "ID" -> inferred INTEGER NOT NULL'), prompt);
    assert.ok(prompt.includes('1: header "ZIP" -> inferred INTEGER NULL'), prompt);
  });

  test('includes the file name', function () {
    const prompt = buildTypeSuggestionPrompt('orders.tsv', [schema()], [['x']]);
    assert.ok(prompt.includes('orders.tsv'), prompt);
  });

  test('includes sample rows, comma-joined', function () {
    const prompt = buildTypeSuggestionPrompt('f.csv', [schema(), schema({ name: 'B' })], [['1', 'a'], ['2', 'b']]);
    assert.ok(prompt.includes('1, a'), prompt);
    assert.ok(prompt.includes('2, b'), prompt);
  });

  test('caps the sample to the first 5 rows even when given more', function () {
    const rows = Array.from({ length: 20 }, (_, i) => [`ROW${i}`]);
    const prompt = buildTypeSuggestionPrompt('f.csv', [schema()], rows);
    const sampleBlock = prompt.split('Sample rows')[1];
    assert.ok(sampleBlock.includes('ROW4'), sampleBlock);
    assert.ok(!sampleBlock.includes('ROW5'), sampleBlock);
    assert.ok(!sampleBlock.includes('ROW19'), sampleBlock);
  });

  test('asks for the exact {"columns": [...]} JSON shape, no markdown fence', function () {
    const prompt = buildTypeSuggestionPrompt('f.csv', [schema()], [['x']]);
    assert.ok(prompt.includes('{"columns":[{"name":"CUSTOMER_ID","sqlType":"INTEGER","nullable":false}]}'), prompt);
    assert.ok(prompt.includes('no markdown fence'), prompt);
  });

  test('instructs the model never to add/remove/reorder columns', function () {
    const prompt = buildTypeSuggestionPrompt('f.csv', [schema()], [['x']]);
    assert.ok(/never add, remove, or reorder columns/i.test(prompt), prompt);
  });
});

// ── parseSuggestedSchema() ─────────────────────────────────────────────────────

suite('flat-file-import – parseSuggestedSchema()', function () {
  const current: ColumnInference[] = [
    schema({ name: 'ID', sqlType: 'INTEGER', nullable: false }),
    schema({ name: 'ZIP', sqlType: 'INTEGER', nullable: true }),
  ];

  test('applies a clean suggestion for every column', function () {
    const result = parseSuggestedSchema(
      '{"columns":[{"name":"CUSTOMER_ID","sqlType":"BIGINT","nullable":false},{"name":"ZIP_CODE","sqlType":"VARCHAR(10)","nullable":true}]}',
      current
    );
    assert.deepStrictEqual(result, [
      { name: 'CUSTOMER_ID', sqlType: 'BIGINT', nullable: false },
      { name: 'ZIP_CODE', sqlType: 'VARCHAR(10)', nullable: true },
    ]);
  });

  test('strips a ```json fence, matching extractJson()', function () {
    const result = parseSuggestedSchema('```json\n{"columns":[{"name":"A","sqlType":"INTEGER","nullable":false}]}\n```', [schema()]);
    assert.strictEqual(result[0].name, 'A');
  });

  test('falls back to the original name/sqlType/nullable field-by-field when an entry omits them', function () {
    const result = parseSuggestedSchema('{"columns":[{},{}]}', current);
    assert.deepStrictEqual(result, current);
  });

  test('sanitizes a suggested name through sanitizeIdentifier() (lowercase, spaces, etc.)', function () {
    const result = parseSuggestedSchema('{"columns":[{"name":"customer id"},{}]}', current);
    assert.strictEqual(result[0].name, 'CUSTOMER_ID');
  });

  test('ignores a non-string sqlType and keeps the original', function () {
    const result = parseSuggestedSchema('{"columns":[{"sqlType":42},{}]}', current);
    assert.strictEqual(result[0].sqlType, 'INTEGER');
  });

  test('ignores a non-boolean nullable and keeps the original', function () {
    const result = parseSuggestedSchema('{"columns":[{"nullable":"yes"},{}]}', current);
    assert.strictEqual(result[0].nullable, false);
  });

  test('throws when the model did not return valid JSON', function () {
    assert.throws(() => parseSuggestedSchema('Sure, here you go: not json', current), /didn't return valid JSON/);
  });

  test('throws when "columns" is missing', function () {
    assert.throws(() => parseSuggestedSchema('{"foo":"bar"}', current), /expected \{"columns": \[\.\.\.\]\} shape/);
  });

  test('throws when the column count does not match — this wizard has no way to reconcile a mismatched count against the file', function () {
    assert.throws(() => parseSuggestedSchema('{"columns":[{"name":"A"}]}', current), /exactly 2 column\(s\)/);
  });

  test('throws when given more columns than expected too', function () {
    assert.throws(
      () => parseSuggestedSchema('{"columns":[{"name":"A"},{"name":"B"},{"name":"C"}]}', current),
      /exactly 2 column\(s\)/
    );
  });
});
