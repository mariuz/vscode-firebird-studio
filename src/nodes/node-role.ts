import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, Uri} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {dropRoleQuery} from "../shared/queries";
import {Driver} from "../shared/driver";
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
}
