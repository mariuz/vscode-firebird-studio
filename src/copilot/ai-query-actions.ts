import * as vscode from 'vscode';
import { KeywordsDb } from '../language-server/db-words.provider';
import { buildSchemaContext } from './schema-context';
import { buildOptimizeMessages, buildExplainMessages, buildAnalyzeResultsMessages } from './prompts';
import { getActiveEditorSql } from './copilot-chat-participant';
import { logger } from '../logger/logger';

/**
 * "AI Query Actions in the editor" — right-click selected SQL (or the whole document, with no
 * selection) for Explain/Optimize without first opening the Copilot Chat panel. Reuses the exact
 * same prompt logic as the `@firebird` chat participant's `/optimize`/`/explain` slash commands
 * (src/copilot/prompts.ts) — the whole point of this feature is not maintaining a second copy of
 * that logic — but gets a language model directly via `vscode.lm.selectChatModels()` instead of
 * `request.model`, since there is no chat request here to source one from.
 */

type ActionKind = 'optimize' | 'explain';

export function registerAiQueryActions(context: vscode.ExtensionContext, schemaProvider: KeywordsDb): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('firebird.ai.explainSelection', () => runAiQueryAction('explain', schemaProvider)),
        vscode.commands.registerCommand('firebird.ai.optimizeSelection', () => runAiQueryAction('optimize', schemaProvider))
    );
}

async function getSchemaBlock(schemaProvider: KeywordsDb): Promise<string> {
    try {
        return buildSchemaContext(await schemaProvider.getSchema());
    } catch {
        logger.warn('Could not load database schema for AI Query Actions context.');
        return '';
    }
}

/** Shared by every AI Query Action: select a model, run the request with a progress notification, open the streamed response beside the editor. */
async function sendToModelAndShowResult(messages: vscode.LanguageModelChatMessage[], title: string): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) {
        logger.showError('No Copilot language model is available. Make sure GitHub Copilot Chat is installed and you\'re signed in.');
        return;
    }
    const model = models[0];

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (_progress, token) => {
            try {
                const response = await model.sendRequest(messages, {}, token);
                let text = '';
                for await (const fragment of response.text) {
                    text += fragment;
                }
                const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            } catch (err) {
                handleModelError(err);
            }
        }
    );
}

async function runAiQueryAction(kind: ActionKind, schemaProvider: KeywordsDb): Promise<void> {
    const sql = getActiveEditorSql();
    if (!sql.trim()) {
        logger.showError('Open a .sql file and select (or place your cursor in) a query first.');
        return;
    }

    const schema = await getSchemaBlock(schemaProvider);
    const messages = kind === 'optimize' ? buildOptimizeMessages(sql, schema) : buildExplainMessages(sql, schema);
    const title = kind === 'optimize' ? 'Optimizing query…' : 'Explaining query…';
    await sendToModelAndShowResult(messages, title);
}

/**
 * "AI analysis of query results" — reachable from the results panel's "🤖 Analyze" button
 * (src/result-view/index.ts emits "analyzeResults", wired up in extension.ts), not the editor.
 * Reuses sendToModelAndShowResult() exactly like the Explain/Optimize actions above.
 */
export async function runAnalyzeResultsAction(
    data: { sql: string; headers: string[]; rows: string[][] },
    schemaProvider: KeywordsDb
): Promise<void> {
    if (!data.rows || data.rows.length === 0) {
        logger.showError('No result rows to analyze.');
        return;
    }

    const schema = await getSchemaBlock(schemaProvider);
    const messages = buildAnalyzeResultsMessages(data.sql, data.headers, data.rows, schema);
    await sendToModelAndShowResult(messages, 'Analyzing results…');
}

function handleModelError(err: unknown): void {
    if (err instanceof vscode.LanguageModelError) {
        logger.error(`Language model error: ${err.message} [${err.code}]`);
        const cause = (err as { cause?: unknown }).cause;
        if (cause instanceof Error && cause.message.includes('off_topic')) {
            logger.showError('Sorry, the model can only help with Firebird SQL database topics.');
        } else {
            logger.showError(`AI request failed: ${err.message}`);
        }
        return;
    }
    logger.error(String(err));
    logger.showError('AI request failed. Check logs for details.');
}
