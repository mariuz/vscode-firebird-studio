import { ExtensionContext, TreeItem, TreeItemCollapsibleState } from "vscode";
import { join } from "path";
import { Constants } from "../config/constants";
import { FirebirdTreeDataProvider } from "../firebirdTreeDataProvider";
import { NodeDatabase } from "./";
import { ConnectionOptions, FirebirdTree } from "../interfaces";
import { CredentialStore } from "../shared/credential-store";
import { logger } from "../logger/logger";

export class NodeHost implements FirebirdTree {
  constructor(private readonly host: string, private readonly dbList: Array<any>) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    const isEmbedded = this.host === "(embedded)";
    return {
      label: isEmbedded ? "Embedded" : this.host,
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "host",
      tooltip: isEmbedded ? "[EMBEDDED] Local Firebird databases" : `[HOST] ${this.host}`,
      iconPath: {
        dark: join(context.extensionPath, "resources", "icons", "dark", isEmbedded ? "db-dark.svg" : "host-dark.svg"),
        light: join(context.extensionPath, "resources", "icons", "light", isEmbedded ? "db-light.svg" : "host-light.svg")
      }
    };
  }

  public async getChildren(): Promise<FirebirdTree[]> {
    return this.dbList.map<NodeDatabase>(db => {
      return new NodeDatabase(db);
    });
  }

  /* remove all databases on selected host and refresh explorer view */
  public async removeHost(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider) {
    logger.info("Remove server start...");
    const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) || {};
    for (const db of this.dbList) {
      if (Object.keys(connections).indexOf(db.id) > -1) {
        delete connections[db.id];
        await CredentialStore.deletePassword(db.id);
        logger.debug(`Removed connection ${db.id}`);
      }
    }
    await context.globalState.update(Constants.ConectionsKey, connections);
    logger.info("Remove server end.");
    firebirdTreeDataProvider.refresh();
  }
}
