import * as vscode from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { getSchemaColumnsQuery, getForeignKeysQuery } from "../shared/queries";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow, SchemaGraph } from "../schema-designer/schema-graph";
import { buildOpenApiSpec, TableAccess } from "./openapi-spec";
import { extractJson } from "../copilot/json-extraction";
import { logger } from "../logger/logger";
import { getDatabaseFileName } from "../shared/utils";

/**
 * Generates an OpenAPI 3.0 spec (one CRUD route set per table) from the connected schema and
 * opens it as a plain JSON document for review — Option A from the design doc, deliberately not
 * a bundled server the extension runs itself.
 */
export async function runDataApiSpecGenerator(connectionOptions: ConnectionOptions): Promise<void> {
  const graph = await fetchSchemaGraph(connectionOptions);
  if (!graph) {
    return;
  }

  const spec = buildOpenApiSpec(graph, { title: `${getDatabaseFileName(connectionOptions.database)} Data API` });
  await openSpecDocument(spec);
  logger.showInfo(`Generated a Data API spec for ${graph.tables.length} table(s). Review it, then hand it to your own REST/GraphQL backend — this extension doesn't run a server itself.`);
}

/**
 * Copilot-assisted scoping (docs/roadmap/data-api-builder.md phase 3): asks the user for a
 * plain-English description of what to expose ("expose customers and orders as read-only"), sends
 * it plus the table list to the language model, and asks for a small structured JSON decision
 * (which tables, and "full" vs "read-only" access for each) — not a raw OpenAPI spec. The model
 * never has to get OpenAPI JSON syntax right; buildOpenApiSpec() (already proven by the plain
 * generator above) turns that decision into the actual spec, the same "small structured edit,
 * deterministic code applies it" split the Schema Designer's "Ask Copilot" panel already uses.
 */
export async function runDataApiSpecGeneratorWithCopilot(connectionOptions: ConnectionOptions): Promise<void> {
  const graph = await fetchSchemaGraph(connectionOptions);
  if (!graph) {
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "Generate Data API Spec with Copilot",
    prompt: "Describe which tables to expose and how (e.g. \"expose customers and orders as read-only\")",
    placeHolder: "expose customers and orders as read-only",
  });
  if (!instruction?.trim()) {
    return;
  }

  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  const model = models[0];
  if (!model) {
    logger.showError("No Copilot language model is available. Make sure GitHub Copilot Chat is installed and signed in.");
    return;
  }

  const tableNames = graph.tables.map(t => t.name);
  const cts = new vscode.CancellationTokenSource();
  let tableAccess: Record<string, TableAccess>;
  try {
    tableAccess = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Asking Copilot which tables to expose…", cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => cts.cancel());
        const messages = [vscode.LanguageModelChatMessage.User(copilotScopingPrompt(tableNames, instruction))];
        const response = await model.sendRequest(messages, {}, cts.token);
        let text = "";
        for await (const fragment of response.text) {
          text += fragment;
        }
        return parseTableAccessResponse(text, tableNames);
      }
    );
  } catch (err: any) {
    if (err instanceof vscode.CancellationError) {
      return;
    }
    const message = err?.message ?? String(err);
    logger.error(`Data API spec Copilot scoping failed: ${message}`);
    logger.showError(`Copilot could not scope the spec: ${message}`);
    return;
  }

  if (Object.keys(tableAccess).length === 0) {
    logger.showError("Copilot didn't match any of your database's tables to that description — try rephrasing, or use \"Generate Data API Spec...\" for every table.");
    return;
  }

  const spec = buildOpenApiSpec(graph, { title: `${getDatabaseFileName(connectionOptions.database)} Data API`, tableAccess });
  await openSpecDocument(spec);

  const readOnlyCount = Object.values(tableAccess).filter(a => a === "read-only").length;
  const scopeNote = readOnlyCount > 0 ? ` (${readOnlyCount} read-only)` : "";
  logger.showInfo(`Generated a Data API spec for ${Object.keys(tableAccess).length} of ${graph.tables.length} table(s)${scopeNote}, based on your description.`);
}

/** Shared by both generators: fetches the schema over one connection and reports any error itself, so callers only need to check for undefined. */
async function fetchSchemaGraph(connectionOptions: ConnectionOptions): Promise<SchemaGraph | undefined> {
  const sql = `${getSchemaColumnsQuery()}\n${getForeignKeysQuery()}`;

  let results;
  try {
    results = await Driver.runBatch(sql, connectionOptions);
  } catch (err: any) {
    logger.error(`Data API spec generation failed: ${err?.message ?? err}`);
    logger.showError(`Could not read the schema: ${err?.message ?? err}`);
    return undefined;
  }

  const [columnsResult, fkResult] = results;
  if (columnsResult?.error) {
    logger.showError(`Could not read the schema: ${columnsResult.error}`);
    return undefined;
  }
  if (fkResult?.error) {
    logger.showError(`Could not read foreign keys: ${fkResult.error}`);
    return undefined;
  }

  const graph = buildSchemaGraph(
    (columnsResult?.rows ?? []) as SchemaColumnRow[],
    (fkResult?.rows ?? []) as ForeignKeyRow[]
  );
  if (graph.tables.length === 0) {
    logger.showError("No tables found in this database — nothing to generate a Data API spec for.");
    return undefined;
  }
  return graph;
}

async function openSpecDocument(spec: Record<string, any>): Promise<void> {
  const content = JSON.stringify(spec, null, 2);
  const doc = await vscode.workspace.openTextDocument({ content, language: "json" });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

/** Exported for testing. */
export function copilotScopingPrompt(tableNames: string[], instruction: string): string {
  return [
    "You are helping scope a Data API specification (OpenAPI 3.0) generated for a Firebird database.",
    "The user will describe, in plain English, which tables to expose and with what access level.",
    "",
    `Available tables: ${tableNames.join(", ")}`,
    "",
    `User's request: ${instruction}`,
    "",
    "Decide which of the available tables above should be exposed, and for each, whether it should have",
    "\"full\" access (list/create/get/update/delete) or \"read-only\" access (list/get only).",
    "Only ever use table names from the \"Available tables\" list above, exactly as spelled there.",
    "Respond with ONLY a JSON object of this exact shape, no other text, no markdown fence:",
    '{"tables":{"TABLE_NAME":"full"}}',
    "Omit any table that should not be exposed at all — do not include every table by default.",
  ].join("\n");
}

/**
 * Exported for testing. Validates the model's response against the real table list — a
 * hallucinated or misspelled table name is dropped rather than trusted, matching this codebase's
 * existing rule for Copilot-produced structured edits (see schema-designer's applyCopilotEdit()):
 * the model's own claims aren't taken at face value against ground truth the extension already has.
 */
export function parseTableAccessResponse(rawText: string, tableNames: string[]): Record<string, TableAccess> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    throw new Error(`Copilot didn't return valid JSON. Raw response:\n${rawText.slice(0, 500)}`);
  }

  const tables = (parsed as { tables?: unknown })?.tables;
  if (typeof tables !== "object" || tables === null) {
    throw new Error(`Copilot's response didn't have the expected {"tables": {...}} shape. Raw response:\n${rawText.slice(0, 500)}`);
  }

  const knownByUppercase = new Map(tableNames.map(name => [name.toUpperCase(), name]));
  const result: Record<string, TableAccess> = {};
  for (const [name, access] of Object.entries(tables as Record<string, unknown>)) {
    const realName = knownByUppercase.get(name.toUpperCase());
    if (!realName) {
      continue; // hallucinated/misspelled table name — drop it rather than generate a broken $ref
    }
    result[realName] = access === "read-only" ? "read-only" : "full";
  }
  return result;
}
