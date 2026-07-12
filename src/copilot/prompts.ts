import * as vscode from 'vscode';
import { renderTableAsMarkdown } from '../shared/notebook-render';

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

/**
 * "AI analysis of query results" — summarizes/explains an already-executed query's result set
 * (not the SQL itself, that's buildExplainMessages()'s job). headers/rows are the same
 * already-rendered strings the results webview displays, reused here via renderTableAsMarkdown()
 * rather than re-querying the database for the same data a second time.
 */
export function buildAnalyzeResultsMessages(
    sql: string,
    headers: string[],
    rows: string[][],
    schemaBlock: string
): vscode.LanguageModelChatMessage[] {
    const table = renderTableAsMarkdown(headers, rows);
    return [
        vscode.LanguageModelChatMessage.User(systemPrompt(schemaBlock)),
        vscode.LanguageModelChatMessage.User(
            'The user ran the following Firebird SQL query and got the result set below. ' +
            'Summarize what the results show — notable patterns, outliers, totals or counts worth ' +
            'mentioning, and anything that looks unexpected or worth a second look. ' +
            'Be concise: a short paragraph or a few bullet points, not an exhaustive essay.\n\n' +
            '```sql\n' + sql + '\n```\n\n' + table
        ),
    ];
}
