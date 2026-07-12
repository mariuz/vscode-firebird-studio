import { window, workspace, ViewColumn, Uri, commands } from "vscode";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join, dirname } from "path";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import {
  getSchemaColumnsQuery, getForeignKeysQuery, getAllViewSourcesQuery,
  getAllProcedureSourcesQuery, getAllTriggerSourcesQuery, getGeneratorsQuery,
} from "../shared/queries";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from "../schema-designer/schema-graph";
import { buildProjectFiles, MANIFEST_FILE_NAME, ProjectInput } from "./project-model";
import { logger } from "../logger/logger";

/**
 * Extract: reads the connected schema and writes it out as one .sql file per table/view/
 * procedure/trigger/generator under a folder the user picks, plus a firebird.project.json
 * manifest recording a dependency-safe file order — Phase 1 of the design doc. Domains, roles,
 * exceptions, and users are out of scope for this pass (see the design doc's "explicitly
 * deferred" section).
 */
export async function runExtractProject(connectionOptions: ConnectionOptions): Promise<void> {
  const folders = await window.showOpenDialog({
    title: "Select a Destination Folder for the Extracted Project",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!folders || folders.length === 0) {
    return;
  }
  const destFolder = folders[0].fsPath;

  const sql = [
    getSchemaColumnsQuery(),
    getForeignKeysQuery(),
    getAllViewSourcesQuery(),
    getAllProcedureSourcesQuery(),
    getAllTriggerSourcesQuery(),
    getGeneratorsQuery(),
  ].join("\n");

  let results;
  try {
    results = await Driver.runBatch(sql, connectionOptions);
  } catch (err: any) {
    logger.error(`Database Projects extract failed: ${err?.message ?? err}`);
    logger.showError(`Could not read the schema: ${err?.message ?? err}`);
    return;
  }

  const [columnsResult, fkResult, viewsResult, proceduresResult, triggersResult, generatorsResult] = results;
  for (const r of [columnsResult, fkResult, viewsResult, proceduresResult, triggersResult, generatorsResult]) {
    if (r?.error) {
      logger.showError(`Could not read the schema: ${r.error}`);
      return;
    }
  }

  const graph = buildSchemaGraph(
    (columnsResult?.rows ?? []) as SchemaColumnRow[],
    (fkResult?.rows ?? []) as ForeignKeyRow[]
  );

  const input: ProjectInput = {
    graph,
    views: ((viewsResult?.rows ?? []) as any[]).map(r => ({ name: r.VIEW_NAME.trim(), source: r.VIEW_SOURCE ?? "" })),
    procedures: ((proceduresResult?.rows ?? []) as any[]).map(r => ({ name: r.PROCEDURE_NAME.trim(), source: r.PROCEDURE_SOURCE ?? "" })),
    triggers: ((triggersResult?.rows ?? []) as any[]).map(r => ({
      name: r.TRIGGER_NAME.trim(),
      table: (r.TABLE_NAME ?? "").trim(),
      inactive: !!r.INACTIVE,
      source: r.TRIGGER_SOURCE ?? "",
    })),
    generators: ((generatorsResult?.rows ?? []) as any[]).map(r => r.GENERATOR_NAME.trim()),
  };

  if (graph.tables.length === 0 && input.views.length === 0 && input.procedures.length === 0
    && input.triggers.length === 0 && input.generators.length === 0) {
    logger.showError("No objects found in this database — nothing to extract.");
    return;
  }

  const files = buildProjectFiles(input);
  for (const file of files) {
    const fullPath = join(destFolder, ...file.path.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, "utf8");
  }

  window.showInformationMessage(`Extracted ${files.length - 1} object(s) to ${destFolder}.`, "Reveal in Explorer").then(sel => {
    if (sel === "Reveal in Explorer") {
      commands.executeCommand("revealFileInOS", Uri.file(join(destFolder, MANIFEST_FILE_NAME)));
    }
  });
}

/**
 * Build: reads an existing project folder's manifest and concatenates its files, in the order the
 * manifest recorded at Extract time, into one reviewable script — Phase 2 of the design doc.
 * Never executed automatically; opened in an editor like every other generated DDL in this
 * extension.
 */
export async function runBuildProject(): Promise<void> {
  const folders = await window.showOpenDialog({
    title: "Select a Database Project Folder to Build",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!folders || folders.length === 0) {
    return;
  }
  const projectFolder = folders[0].fsPath;

  let manifest: { files: string[] };
  try {
    const manifestText = await readFile(join(projectFolder, MANIFEST_FILE_NAME), "utf8");
    manifest = JSON.parse(manifestText);
  } catch (err: any) {
    logger.showError(`Could not read ${MANIFEST_FILE_NAME} in ${projectFolder}: ${err?.message ?? err}`);
    return;
  }

  const sections: string[] = [];
  for (const relativePath of manifest.files ?? []) {
    try {
      const content = await readFile(join(projectFolder, ...relativePath.split("/")), "utf8");
      sections.push(`-- ${relativePath}\n${content.trim()}`);
    } catch (err: any) {
      logger.error(`Database Projects build: could not read ${relativePath}: ${err?.message ?? err}`);
      logger.showError(`Could not read ${relativePath} — check the project folder for missing files.`);
      return;
    }
  }

  const script = sections.join("\n\n");
  const doc = await workspace.openTextDocument({ content: script, language: "sql" });
  await window.showTextDocument(doc, ViewColumn.Beside);
  logger.showInfo(`Built a ${manifest.files?.length ?? 0}-file deployable script. Review it, then run it against your target database.`);
}
