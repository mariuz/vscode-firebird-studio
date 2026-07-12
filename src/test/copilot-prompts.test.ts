import * as assert from 'assert';
import { systemPrompt, buildOptimizeMessages, buildExplainMessages, buildAnalyzeResultsMessages, buildMigrateMessages } from '../copilot/prompts';

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

suite('copilot/prompts – buildMigrateMessages()', function () {
  test('returns a system message followed by the source DDL wrapped in a fenced code block', function () {
    const mysqlDdl = 'CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, name TEXT);';
    const messages = buildMigrateMessages(mysqlDdl, 'schema-block');
    assert.strictEqual(messages.length, 2);
    assert.ok((messages[0].content as unknown as string).includes('schema-block'));
    const userContent = messages[1].content as unknown as string;
    assert.ok(userContent.includes('```sql\n' + mysqlDdl + '\n```'));
    assert.ok(userContent.toLowerCase().includes('firebird'));
    assert.ok(userContent.toLowerCase().includes('convert'));
  });
});

suite('copilot/prompts – buildAnalyzeResultsMessages()', function () {
  test('returns a system message followed by the SQL and a markdown table of the results', function () {
    const messages = buildAnalyzeResultsMessages(
      'SELECT * FROM T',
      ['ID', 'NAME'],
      [['1', 'Alice'], ['2', 'Bob']],
      'schema-block'
    );
    assert.strictEqual(messages.length, 2);
    assert.ok((messages[0].content as unknown as string).includes('schema-block'));
    const userContent = messages[1].content as unknown as string;
    assert.ok(userContent.includes('```sql\nSELECT * FROM T\n```'));
    assert.ok(userContent.includes('| ID | NAME |'));
    assert.ok(userContent.includes('| 1 | Alice |'));
    assert.ok(userContent.toLowerCase().includes('summarize'));
  });
});
