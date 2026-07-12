import * as vscode from 'vscode';

/**
 * Prompt-building shared between the `@firebird` chat participant's `/optimize`/`/explain` slash
 * commands and the "AI Query Actions in the editor" commands (right-click SQL → Explain/Optimize
 * without opening the chat panel first) — the whole point of that feature is reusing this exact
 * logic, not a second copy of it.
 */

/** System prompt shared across every Copilot-backed feature in this extension. */
export function systemPrompt(schemaBlock: string): string {
    const base =
        'You are a Firebird SQL database expert assistant integrated into VS Code. ' +
        'You help users write, understand, and optimize Firebird SQL queries. ' +
        'Always use Firebird SQL dialect and syntax. ' +
        'When generating SQL, output it inside a fenced ```sql code block.';
    if (schemaBlock) {
        return (
            base +
            '\n\nThe user is connected to a Firebird database with the following schema:\n' +
            schemaBlock
        );
    }
    return base;
}

export function buildOptimizeMessages(sql: string, schemaBlock: string): vscode.LanguageModelChatMessage[] {
    return [
        vscode.LanguageModelChatMessage.User(systemPrompt(schemaBlock)),
        vscode.LanguageModelChatMessage.User(
            'Analyze the following Firebird SQL query and suggest optimizations. ' +
            'Consider indexing, query structure, and Firebird-specific best practices. ' +
            'Present the optimized query in a fenced ```sql code block and explain the changes.\n\n' +
            '```sql\n' + sql + '\n```'
        ),
    ];
}

export function buildExplainMessages(sql: string, schemaBlock: string): vscode.LanguageModelChatMessage[] {
    return [
        vscode.LanguageModelChatMessage.User(systemPrompt(schemaBlock)),
        vscode.LanguageModelChatMessage.User(
            'Explain the following Firebird SQL query in plain English. ' +
            'Break it down step by step so a beginner can understand it.\n\n' +
            '```sql\n' + sql + '\n```'
        ),
    ];
}
