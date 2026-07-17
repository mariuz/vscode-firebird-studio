import {ExtensionContext, TreeItem, TreeItemCollapsibleState, window, Uri, ThemeIcon, ThemeColor} from "vscode";
import {join} from "path";
import {NodeTable, NodeCategoryFolder, NodeView, NodeProcedure, NodeTrigger, NodeGenerator, NodeDomain, NodeRole, NodeException, NodeSystemTable, NodeUser} from "./";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {getOptions, Constants} from "../config";
import {Driver} from "../shared/driver";
import {Global} from "../shared/global";
import {CredentialStore} from "../shared/credential-store";
import {FirebirdTreeDataProvider} from "../firebirdTreeDataProvider";
import {databaseInfoQry, getTablesQuery, getViewsQuery, getStoredProceduresQuery, getTriggersQuery, getGeneratorsQuery, getDomainsQuery, getRolesQuery, getExceptionsQuery, getSystemTablesQuery, getUsersQuery} from "../shared/queries";
import {logger} from "../logger/logger";
import {getDatabaseFileName} from "../shared/utils";
import {getObjectFilter, matchesObjectFilter} from "../shared/object-explorer-filter";
import {SchemaDesigner} from "../schema-designer";
import {ProfilerView} from "../profiler";
import {runFlatFileImportWizard} from "../flat-file-import";
import {runDataApiSpecGenerator, runDataApiSpecGeneratorWithCopilot} from "../data-api-builder";
import {runExtractProject} from "../database-projects";
import {runObjectSearch} from "../object-search";
import QueryResultsView from "../result-view";
import {notifyMcpExposureChanged} from "../mcp-server";
import {themeColorIdFor, CONNECTION_COLORS, ConnectionColor} from "../shared/connection-color";
import * as cp from 'node:child_process';


export class NodeDatabase implements FirebirdTree {

  constructor(private readonly dbDetails: ConnectionOptions) {}

  // list databases grouped by host names
  public getTreeItem(context: ExtensionContext): TreeItem {
    const colorId = themeColorIdFor(this.dbDetails.color);
    return {
      label: getDatabaseFileName(this.dbDetails.database),
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "database",
      tooltip: this.dbDetails.workspace
        ? `[DATABASE] ${this.dbDetails.database}\nFrom this workspace's .vscode/firebird.json`
        : `[DATABASE] ${this.dbDetails.database}`,
      // A color tag (set via "Set Connection Color...") swaps the usual custom SVG icon for a
      // themed codicon, since TreeItem iconPath can't tint an arbitrary SVG file — untagged
      // connections keep the existing icon unchanged.
      iconPath: colorId
        ? new ThemeIcon("database", new ThemeColor(colorId))
        : {
            dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "db-dark.svg")),
            light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "db-light.svg"))
          }
    };
  }

  /** Returns a copy of dbDetails with password resolved from SecretStorage if needed. */
  private async resolvedDetails(): Promise<ConnectionOptions> {
    return Driver.resolvePassword(this.dbDetails);
  }

  // list database object categories
  public async getChildren(): Promise<FirebirdTree[]> {
    const children: FirebirdTree[] = [
      new NodeCategoryFolder("Tables", "tables", this.dbDetails, this.getTableChildren.bind(this)),
      new NodeCategoryFolder("Views", "views", this.dbDetails, this.getViewChildren.bind(this)),
      new NodeCategoryFolder("Stored Procedures", "procedures", this.dbDetails, this.getProcedureChildren.bind(this)),
      new NodeCategoryFolder("Triggers", "triggers", this.dbDetails, this.getTriggerChildren.bind(this)),
      new NodeCategoryFolder("Generators", "generators", this.dbDetails, this.getGeneratorChildren.bind(this)),
      new NodeCategoryFolder("Domains", "domains", this.dbDetails, this.getDomainChildren.bind(this)),
      new NodeCategoryFolder("Roles", "roles", this.dbDetails, this.getRoleChildren.bind(this)),
      new NodeCategoryFolder("Exceptions", "exceptions", this.dbDetails, this.getExceptionChildren.bind(this)),
      new NodeCategoryFolder("Users", "users", this.dbDetails, this.getUserChildren.bind(this)),
    ];
    if (getOptions().showSystemObjects) {
      children.push(new NodeCategoryFolder("System Tables", "systemTables", this.dbDetails, this.getSystemTableChildren.bind(this)));
    }
    return children;
  }

  /** Narrows rows to those matching this category's active object filter (if any), set via NodeCategoryFolder#setFilter(). */
  private filterRows<T>(rows: T[], category: string, nameOf: (row: T) => string): T[] {
    const filter = getObjectFilter(this.dbDetails.id, category);
    if (!filter) { return rows; }
    return rows.filter(row => matchesObjectFilter(nameOf(row), filter));
  }

  private async getTableChildren(): Promise<FirebirdTree[]> {
    const tablesQry = getTablesQuery(getOptions().maxTablesCount);
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const tables = await Driver.client.queryPromise<any>(connection, tablesQry);
    return this.filterRows(tables, "tables", t => t.TABLE_NAME).map<NodeTable>(table => new NodeTable(this.dbDetails, table.TABLE_NAME));
  }

  private async getViewChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const views = await Driver.client.queryPromise<any>(connection, getViewsQuery());
    return this.filterRows(views, "views", v => v.VIEW_NAME).map<NodeView>(view => new NodeView(this.dbDetails, view.VIEW_NAME));
  }

  private async getProcedureChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const procs = await Driver.client.queryPromise<any>(connection, getStoredProceduresQuery());
    return this.filterRows(procs, "procedures", p => p.PROCEDURE_NAME).map<NodeProcedure>(proc => new NodeProcedure(this.dbDetails, proc.PROCEDURE_NAME));
  }

  private async getTriggerChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const triggers = await Driver.client.queryPromise<any>(connection, getTriggersQuery());
    return this.filterRows(triggers, "triggers", t => t.TRIGGER_NAME).map<NodeTrigger>(trigger => new NodeTrigger(trigger, this.dbDetails));
  }

  private async getGeneratorChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const generators = await Driver.client.queryPromise<any>(connection, getGeneratorsQuery());
    return this.filterRows(generators, "generators", g => g.GENERATOR_NAME).map<NodeGenerator>(gen => new NodeGenerator(gen.GENERATOR_NAME, this.dbDetails));
  }

  private async getDomainChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const domains = await Driver.client.queryPromise<any>(connection, getDomainsQuery());
    return this.filterRows(domains, "domains", d => d.DOMAIN_NAME).map<NodeDomain>(domain => new NodeDomain(domain, this.dbDetails));
  }

  private async getRoleChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const roles = await Driver.client.queryPromise<any>(connection, getRolesQuery());
    return this.filterRows(roles, "roles", r => r.ROLE_NAME).map<NodeRole>(role => new NodeRole(role.ROLE_NAME, this.dbDetails));
  }

  private async getExceptionChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const exceptions = await Driver.client.queryPromise<any>(connection, getExceptionsQuery());
    return this.filterRows(exceptions, "exceptions", e => e.EXCEPTION_NAME).map<NodeException>(exception => new NodeException(exception, this.dbDetails));
  }

  private async getSystemTableChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const tables = await Driver.client.queryPromise<any>(connection, getSystemTablesQuery());
    return this.filterRows(tables, "systemTables", t => t.TABLE_NAME).map<NodeSystemTable>(table => new NodeSystemTable(this.dbDetails, table.TABLE_NAME));
  }

  private async getUserChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const users = await Driver.client.queryPromise<any>(connection, getUsersQuery());
    return this.filterRows(users, "users", u => u.USER_NAME).map<NodeUser>(user => new NodeUser(user.USER_NAME, this.dbDetails));
  }

  //  run predefined sql query
  public async showDatabaseInfo() {
    logger.info("Custom query: Show Database Info");

    const qry = databaseInfoQry;
    Global.activeConnection = await this.resolvedDetails();

    return Driver.runQuery(qry, Global.activeConnection)
      .then(result => {
        return result;
      })
      .catch(err => {
        logger.error(err);
      });
  }

  // create new sql document and set active database
  public async newQuery(): Promise<void> {
    Driver.createSQLTextDocument()
      .then(res => {
        if (res) {
          this.setActive();
          logger.info("New Firebird SQL query");
        }
      })
      .catch(err => {
        logger.error(err);
      });
  }

  // open the Schema Designer (whole-database ER diagram, editable) for this database
  public openSchemaDesigner(schemaDesigner: SchemaDesigner): void {
    schemaDesigner.openFullSchema(this.dbDetails);
  }

  // guided CSV/TSV/JSON -> new table import wizard
  public async importFlatFile(): Promise<void> {
    return runFlatFileImportWizard(this.dbDetails);
  }

  // generate an OpenAPI REST spec (one CRUD route set per table) from the connected schema
  public async generateDataApiSpec(): Promise<void> {
    return runDataApiSpecGenerator(this.dbDetails);
  }

  // same, but scoped by a Copilot-interpreted plain-English description ("expose X and Y as read-only")
  public async generateDataApiSpecWithCopilot(): Promise<void> {
    return runDataApiSpecGeneratorWithCopilot(this.dbDetails);
  }

  // extract the connected schema into a folder of versioned .sql files (Database Projects)
  public async extractProject(): Promise<void> {
    return runExtractProject(this.dbDetails);
  }

  // fuzzy-search every table/view/procedure/trigger/generator/domain by name, then jump to it
  public async searchObjects(firebirdQueryResults: QueryResultsView): Promise<void> {
    return runObjectSearch(this.dbDetails, firebirdQueryResults);
  }

  /** Connection details with the password resolved from SecretStorage, for callers (e.g. the
   * isql terminal) that need the real value directly rather than going through Driver. */
  public async getResolvedConnectionDetails(): Promise<ConnectionOptions> {
    return this.resolvedDetails();
  }

  // tag this connection with a color (tree icon + status bar) for quick visual identification
  public async setConnectionColor(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit it there instead.");
      return;
    }

    const noneLabel = "$(circle-slash) None";
    const items = [
      { label: noneLabel, color: undefined as ConnectionColor | undefined },
      ...CONNECTION_COLORS.map(color => ({ label: `$(circle-large-filled) ${color[0].toUpperCase()}${color.slice(1)}`, color })),
    ];
    const picked = await window.showQuickPick(items, { title: "Set Connection Color" });
    if (!picked) { return; }

    await this.updateSavedConnectionField(context, "color", picked.color);
    firebirdTreeDataProvider.refresh();
  }

  // organize this connection under a named group/folder in the tree instead of by host
  public async setConnectionGroup(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit it there instead.");
      return;
    }

    const group = await window.showInputBox({
      title: "Set Connection Group",
      prompt: "Group/folder name to organize this connection under (leave empty to ungroup — falls back to grouping by host)",
      value: this.dbDetails.group ?? "",
    });
    if (group === undefined) { return; }

    await this.updateSavedConnectionField(context, "group", group || undefined);
    firebirdTreeDataProvider.refresh();
  }

  // opt this connection in/out of the firebird-mcp MCP server's list_connections/get_schema tools
  public async toggleMcpExposure(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit it there instead.");
      return;
    }

    const nowExposed = !this.dbDetails.mcpExposed;
    await this.updateSavedConnectionField(context, "mcpExposed", nowExposed);
    firebirdTreeDataProvider.refresh();
    notifyMcpExposureChanged();
    logger.showInfo(nowExposed
      ? `${getDatabaseFileName(this.dbDetails.database)} is now exposed to the Firebird MCP server (if firebird.mcp.enabled is on).`
      : `${getDatabaseFileName(this.dbDetails.database)} is no longer exposed to the Firebird MCP server.`);
  }

  /** Patches one field of this connection's saved globalState entry (color/group/mcpExposed tags — not password, which never lives there). */
  private async updateSavedConnectionField<K extends "color" | "group" | "mcpExposed">(
    context: ExtensionContext, field: K, value: ConnectionOptions[K]
  ): Promise<void> {
    const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey);
    if (!connections?.[this.dbDetails.id]) { return; }
    connections[this.dbDetails.id][field] = value;
    await context.globalState.update(Constants.ConectionsKey, connections);
    if (Global.activeConnection?.id === this.dbDetails.id) {
      Global.patchActiveConnection({ [field]: value });
    }
  }

  // delete database connection details and remove it from explorer view
  public async removeDatabase(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider) {
    logger.info("Remove database start...");

    if (this.dbDetails.workspace) {
      // Sourced from .vscode/firebird.json, not globalState — re-derived from disk on every
      // refresh, so deleting it here would just reappear (and would otherwise still wipe any
      // password already stored for it via setPassword()).
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit or remove it there instead.");
      return;
    }

    await this.removeSavedConnectionEntry(context);
    firebirdTreeDataProvider.refresh();
    logger.info("Remove database end...");
  }

  /** Permanently deletes the database itself (not just its saved connection entry) — no undo. */
  public async dropDatabase(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    logger.info("Drop database start...");
    const resolved = await this.resolvedDetails();

    try {
      await Driver.dropDatabase(resolved);
    } catch (err: any) {
      logger.error(err?.message ?? err);
      logger.showError(`Could not drop the database: ${err?.message ?? err}`);
      return;
    }

    // The database no longer exists — its saved connection entry (if any) would just fail to
    // connect from now on, so clean it up the same way removeDatabase() does.
    if (!this.dbDetails.workspace) {
      await this.removeSavedConnectionEntry(context);
    }
    firebirdTreeDataProvider.refresh();
    logger.info("Drop database end...");
    logger.showInfo(`Database ${getDatabaseFileName(this.dbDetails.database)} dropped.`);
  }

  /**
   * Renames an embedded database's file on disk and updates its saved connection entry to match.
   * Scoped to embedded connections only — a network connection's database file lives on the
   * remote server's filesystem, which this extension has no access to rename.
   */
  public async renameDatabase(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (!this.dbDetails.embedded) {
      logger.showInfo("Only embedded database connections can be renamed here — a network database's file lives on the remote server.");
      return;
    }
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit or remove it there instead.");
      return;
    }

    const currentPath = this.dbDetails.database;
    const newUri = await window.showSaveDialog({
      title: "Rename Database To",
      defaultUri: Uri.file(currentPath),
      filters: { "Firebird Database": ["fdb", "gdb"], "All files": ["*"] },
    });
    if (!newUri) {
      return;
    }
    const newPath = newUri.fsPath;
    if (newPath === currentPath) {
      return;
    }

    const answer = await window.showWarningMessage(
      `Rename ${getDatabaseFileName(currentPath)} to ${getDatabaseFileName(newPath)}? The database must not be in use by any connection.`,
      { modal: true },
      "Rename"
    );
    if (answer !== "Rename") {
      return;
    }

    try {
      const { rename } = await import("fs/promises");
      await rename(currentPath, newPath);
    } catch (err: any) {
      logger.error(err?.message ?? err);
      logger.showError(`Could not rename the database file: ${err?.message ?? err}`);
      return;
    }

    const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey);
    if (connections?.[this.dbDetails.id]) {
      connections[this.dbDetails.id].database = newPath;
      await context.globalState.update(Constants.ConectionsKey, connections);
    }
    if (Global.activeConnection?.id === this.dbDetails.id) {
      Global.patchActiveConnection({ database: newPath });
    }

    firebirdTreeDataProvider.refresh();
    logger.showInfo(`Database renamed to ${getDatabaseFileName(newPath)}.`);
  }

  /** Deletes this connection's saved entry from globalState (not the database file itself). */
  private async removeSavedConnectionEntry(context: ExtensionContext): Promise<void> {
    const connections = context.globalState.get<{[key: string]: ConnectionOptions;}>(Constants.ConectionsKey);

    if (connections) {
      delete connections[this.dbDetails.id];
      await CredentialStore.deletePassword(this.dbDetails.id);
      await CredentialStore.deleteSshPassword(this.dbDetails.id);
      await context.globalState.update(Constants.ConectionsKey, connections);
      logger.debug(`Removed connection ${this.dbDetails.id}`);
    }
  }

  // set active database
  public async setActive(): Promise<void> {
    logger.info("Set active connection");
    Global.activeConnection = await this.resolvedDetails();
  }

  /**
   * Stores/updates this connection's password in SecretStorage. The only way to set a password
   * for a workspace-declared connection (.vscode/firebird.json never contains one), but works
   * for any saved connection — there was previously no way to change one without removing and
   * re-adding the whole connection.
   */
  public async setPassword(): Promise<void> {
    const password = await window.showInputBox({
      prompt: `New password for ${getDatabaseFileName(this.dbDetails.database)}`,
      ignoreFocusOut: true,
      password: true,
      validateInput: v => v ? undefined : "Password is required"
    });
    if (password === undefined) { return; }
    await CredentialStore.storePassword(this.dbDetails.id, password);
    logger.showInfo("Password updated.");
  }

  // open the Live Profiler (polling connection/query activity) for this database
  public async monitorDatabase(profilerView: ProfilerView): Promise<void> {
    logger.info("Monitor Database: open Live Profiler");
    const resolved = await this.resolvedDetails();
    Global.activeConnection = resolved;
    profilerView.open(resolved);
  }

  // backup database using gbak
  public async backupDatabase(): Promise<void> {
    const saveUri = await window.showSaveDialog({
      title: "Backup Firebird Database",
      filters: { "Firebird Backup": ["fbk"], "All files": ["*"] },
      defaultUri: undefined
    });
    if (!saveUri) { return; }

    const backupPath = saveUri.fsPath;
    const { host, port, database, user, password } = this.dbDetails;
    const hostPort = `${host}/${port ?? 3050}:${database}`;
    const args = ["-b", "-user", user, "-password", password ?? "", hostPort, backupPath];

    logger.info(`Starting backup to ${backupPath}`);
    const statusItem = window.createStatusBarItem();
    statusItem.text = "$(loading~spin) Backing up database...";
    statusItem.show();

    const child = cp.execFile("gbak", args);
    child.stderr?.on("data", d => logger.output(`[gbak] ${d}`));
    child.on("error", err => {
      statusItem.dispose();
      logger.error(`Backup error: ${err.message}`);
      logger.showError(`Backup failed: ${err.message}`);
    });
    child.on("close", code => {
      statusItem.dispose();
      if (code === 0) {
        logger.info(`Backup completed: ${backupPath}`);
        window.showInformationMessage(`Database backed up successfully to ${backupPath}`);
      } else {
        logger.error(`Backup failed with exit code ${code}`);
        logger.showError(`Backup failed (exit code ${code}). Check the log for details.`);
      }
    });
  }

  // restore database using gbak
  public async restoreDatabase(): Promise<void> {
    const openUris = await window.showOpenDialog({
      title: "Select Firebird Backup File",
      filters: { "Firebird Backup": ["fbk"], "All files": ["*"] },
      canSelectMany: false
    });
    if (!openUris || openUris.length === 0) { return; }

    const backupPath = openUris[0].fsPath;

    const restoreUri = await window.showSaveDialog({
      title: "Restore To Database File",
      filters: { "Firebird Database": ["fdb", "gdb"], "All files": ["*"] },
      defaultUri: undefined
    });
    if (!restoreUri) { return; }

    const restorePath = restoreUri.fsPath;
    const { host, port, user, password } = this.dbDetails;
    const hostPort = `${host}/${port ?? 3050}:${restorePath}`;
    const args = ["-c", "-user", user, "-password", password ?? "", backupPath, hostPort];

    logger.info(`Starting restore from ${backupPath} to ${restorePath}`);
    const statusItem = window.createStatusBarItem();
    statusItem.text = "$(loading~spin) Restoring database...";
    statusItem.show();

    const child = cp.execFile("gbak", args);
    child.stderr?.on("data", d => logger.output(`[gbak] ${d}`));
    child.on("error", err => {
      statusItem.dispose();
      logger.error(`Restore error: ${err.message}`);
      logger.showError(`Restore failed: ${err.message}`);
    });
    child.on("close", code => {
      statusItem.dispose();
      if (code === 0) {
        logger.info(`Restore completed: ${restorePath}`);
        window.showInformationMessage(`Database restored successfully to ${restorePath}`);
      } else {
        logger.error(`Restore failed with exit code ${code}`);
        logger.showError(`Restore failed (exit code ${code}). Check the log for details.`);
      }
    });
  }
}
