import * as assert from 'assert';
import { systemPrompt, buildOptimizeMessages, buildExplainMessages } from '../copilot/prompts';

suite('copilot/prompts – systemPrompt()', function () {
  test('mentions Firebird SQL and code-block formatting with no schema', function () {
    const prompt = systemPrompt('');
    assert.ok(prompt.includes('Firebird SQL'));
    assert.ok(prompt.includes('```sql'));
    assert.ok(!prompt.includes('schema'));
  });

  test('appends the schema block when one is given', function () {
    const prompt = systemPrompt('TABLE CUSTOMERS (ID INTEGER)');
    assert.ok(prompt.includes('TABLE CUSTOMERS (ID INTEGER)'));
    assert.ok(prompt.includes('connected to a Firebird database'));
  });
});

suite('copilot/prompts – buildOptimizeMessages()', function () {
  test('returns a system message followed by the SQL wrapped in a fenced code block', function () {
    const messages = buildOptimizeMessages('SELECT * FROM T', 'schema-block');
    assert.strictEqual(messages.length, 2);
    assert.ok((messages[0].content as unknown as string).includes('schema-block'));
    assert.ok((messages[1].content as unknown as string).includes('```sql\nSELECT * FROM T\n```'));
    assert.ok((messages[1].content as unknown as string).toLowerCase().includes('optimiz'));
  });
});

suite('copilot/prompts – buildExplainMessages()', function () {
  test('returns a system message followed by the SQL wrapped in a fenced code block', function () {
    const messages = buildExplainMessages('SELECT * FROM T', 'schema-block');
    assert.strictEqual(messages.length, 2);
    assert.ok((messages[0].content as unknown as string).includes('schema-block'));
    assert.ok((messages[1].content as unknown as string).includes('```sql\nSELECT * FROM T\n```'));
    assert.ok((messages[1].content as unknown as string).toLowerCase().includes('explain'));
  });
});
