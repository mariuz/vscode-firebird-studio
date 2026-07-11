import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, Uri} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {getIndexesQuery, createIndexQuery, dropIndexQuery} from "../shared/queries";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";
import {NodeInfo} from "./node-info";

/**
 * A table's "Indexes" folder — parallel to NodeCategoryFolder, but scoped to one table rather
 * than a whole database, so "Create Index" commands know which table to target.
 */
export class NodeIndexFolder implements FirebirdTree {
  constructor(private readonly dbDetails: ConnectionOptions, private readonly table: string) {}

  public getTableName(): string {
    return this.table.trim();
  }

  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      label: "Indexes",
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "folder.indexes",
      tooltip: "Indexes",
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "folder-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "folder-light.svg"))
      }
    };
  }

  public async getChildren(): Promise<FirebirdTree[]> {
    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const indexes = await Driver.client.queryPromise<any>(connection, getIndexesQuery(this.table.trim()));
      return indexes.map<NodeIndex>(index => new NodeIndex(index, this.dbDetails, this.table));
    } catch (err) {
      logger.error(err);
      return [new NodeInfo(String(err))];
    }
  }
}

export class NodeIndex implements FirebirdTree {
  constructor(private readonly index: any, private readonly dbDetails: ConnectionOptions, private readonly table: string) {}

  private getIndexName(): string {
    return this.index.INDEX_NAME ? String(this.index.INDEX_NAME).trim() : "";
  }

  public getTreeItem(context: ExtensionContext): TreeItem {
    const name = this.getIndexName();
    const columns = this.index.COLUMNS ? String(this.index.COLUMNS).trim() : "";
    const unique = this.index.IS_UNIQUE ? "UNIQUE " : "";
    const inactive = this.index.IS_ACTIVE ? "" : " (inactive)";
    return {
      label: `${name} (${columns})${inactive}`,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "index",
      tooltip: `[${unique}INDEX] ${name}\nTable: ${this.table.trim()}\nColumns: ${columns}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "index-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "index-light.svg"))
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }

  public static async createIndex(
    dbDetails: ConnectionOptions,
    tableName: string,
    indexName: string,
    columns: string[],
    unique: boolean
  ): Promise<void> {
    logger.info("Create Index");
    return Driver.runQuery(createIndexQuery(indexName, tableName, columns, unique), dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to create index: ${err}`);
      });
  }

  public async dropIndex() {
    logger.info("Drop Index");
    Driver.runQuery(dropIndexQuery(this.getIndexName()), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to drop index: ${err}`);
      });
  }
}
