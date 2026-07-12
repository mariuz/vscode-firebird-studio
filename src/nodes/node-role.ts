import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, Uri} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {dropRoleQuery, createRoleQuery, getObjectPrivilegesQuery} from "../shared/queries";
import {Driver} from "../shared/driver";
import {Global} from "../shared/global";
import {logger} from "../logger/logger";

export class NodeRole implements FirebirdTree {
  constructor(private readonly roleName: string, private readonly dbDetails?: ConnectionOptions) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    const name = this.roleName.trim();
    return {
      label: name,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "role",
      tooltip: `[ROLE] ${name}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "role-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "role-light.svg"))
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }

  /** No password/secret involved, so this can safely go through Driver.runQuery like any other DDL. */
  public static async createRole(dbDetails: ConnectionOptions, roleName: string): Promise<void> {
    logger.info("Create Role");
    return Driver.runQuery(createRoleQuery(roleName.trim()), dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to create role: ${err}`);
      });
  }

  public async dropRole() {
    if (!this.dbDetails) { return; }
    logger.info("Drop Role");
    Driver.runQuery(dropRoleQuery(this.roleName.trim()), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to drop role: ${err}`);
      });
  }

  /** Generic "Script as Create" — a role has no other attributes to reconstruct beyond its name. */
  public async scriptAsCreate(): Promise<void> {
    await Driver.createSQLTextDocument(createRoleQuery(this.roleName.trim()));
  }

  /** Generic "Script as Drop". */
  public async scriptAsDrop(): Promise<void> {
    await Driver.createSQLTextDocument(dropRoleQuery(this.roleName.trim()));
  }

  /** Shows this role's grants (RDB$USER_PRIVILEGES) — who's a member, and what it's been granted access to — in the results grid. */
  public async showPrivileges() {
    if (!this.dbDetails) { return; }
    logger.info("Custom Query: Show Object Privileges");
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(getObjectPrivilegesQuery(this.roleName.trim()), this.dbDetails)
      .then(result => result)
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to fetch privileges: ${err}`);
      });
  }
}
