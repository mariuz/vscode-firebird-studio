import {ExtensionContext, TreeItem, TreeItemCollapsibleState, window, Uri} from "vscode";
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
import {SchemaDesigner} from "../schema-designer";
import {ProfilerView} from "../profiler";
import {runFlatFileImportWizard} from "../flat-file-import";
import {runDataApiSpecGenerator} from "../data-api-builder";
import {runExtractProject} from "../database-projects";
import * as cp from 'node:child_process';


export class NodeDatabase implements FirebirdTree {

  constructor(private readonly dbDetails: ConnectionOptions) {}

  // list databases grouped by host names
  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      label: getDatabaseFileName(this.dbDetails.database),
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "database",
      tooltip: this.dbDetails.workspace
        ? `[DATABASE] ${this.dbDetails.database}\nFrom this workspace's .vscode/firebird.json`
        : `[DATABASE] ${this.dbDetails.database}`,
      iconPath: {
        /* dark: join(__filename, "..", "..", "..", "resources", "icons", "dark", "db-dark.svg"),
        light: join(__filename, "..", "..", "..", "resources", "icons", "light", "db-light.svg") */
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

  private async getTableChildren(): Promise<FirebirdTree[]> {
    const tablesQry = getTablesQuery(getOptions().maxTablesCount);
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const tables = await Driver.client.queryPromise<any>(connection, tablesQry);
    return tables.map<NodeTable>(table => new NodeTable(this.dbDetails, table.TABLE_NAME));
  }

  private async getViewChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const views = await Driver.client.queryPromise<any>(connection, getViewsQuery());
    return views.map<NodeView>(view => new NodeView(this.dbDetails, view.VIEW_NAME));
  }

  private async getProcedureChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const procs = await Driver.client.queryPromise<any>(connection, getStoredProceduresQuery());
    return procs.map<NodeProcedure>(proc => new NodeProcedure(this.dbDetails, proc.PROCEDURE_NAME));
  }

  private async getTriggerChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const triggers = await Driver.client.queryPromise<any>(connection, getTriggersQuery());
    return triggers.map<NodeTrigger>(trigger => new NodeTrigger(trigger, this.dbDetails));
  }

  private async getGeneratorChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const generators = await Driver.client.queryPromise<any>(connection, getGeneratorsQuery());
    return generators.map<NodeGenerator>(gen => new NodeGenerator(gen.GENERATOR_NAME, this.dbDetails));
  }

  private async getDomainChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const domains = await Driver.client.queryPromise<any>(connection, getDomainsQuery());
    return domains.map<NodeDomain>(domain => new NodeDomain(domain, this.dbDetails));
  }

  private async getRoleChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const roles = await Driver.client.queryPromise<any>(connection, getRolesQuery());
    return roles.map<NodeRole>(role => new NodeRole(role.ROLE_NAME, this.dbDetails));
  }

  private async getExceptionChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const exceptions = await Driver.client.queryPromise<any>(connection, getExceptionsQuery());
    return exceptions.map<NodeException>(exception => new NodeException(exception, this.dbDetails));
  }

  private async getSystemTableChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const tables = await Driver.client.queryPromise<any>(connection, getSystemTablesQuery());
    return tables.map<NodeSystemTable>(table => new NodeSystemTable(this.dbDetails, table.TABLE_NAME));
  }

  private async getUserChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const users = await Driver.client.queryPromise<any>(connection, getUsersQuery());
    return users.map<NodeUser>(user => new NodeUser(user.USER_NAME, this.dbDetails));
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

  // extract the connected schema into a folder of versioned .sql files (Database Projects)
  public async extractProject(): Promise<void> {
    return runExtractProject(this.dbDetails);
  }

  /** Connection details with the password resolved from SecretStorage, for callers (e.g. the
   * isql terminal) that need the real value directly rather than going through Driver. */
  public async getResolvedConnectionDetails(): Promise<ConnectionOptions> {
    return this.resolvedDetails();
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

    const connections = context.globalState.get<{[key: string]: ConnectionOptions;}>(Constants.ConectionsKey);

    if (connections) {
      delete connections[this.dbDetails.id];
      await CredentialStore.deletePassword(this.dbDetails.id);
      await context.globalState.update(Constants.ConectionsKey, connections);
      logger.debug(`Removed connection ${this.dbDetails.id}`);
      firebirdTreeDataProvider.refresh();
      logger.info("Remove database end...");
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
