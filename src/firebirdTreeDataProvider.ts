import { TreeDataProvider, EventEmitter, Event, ExtensionContext, TreeItem } from "vscode";
import { v1  as uuidv1 } from "uuid";
import { NodeHost } from "./nodes";
import { ConnectionOptions, FirebirdTree } from "./interfaces";
import { connectionWizard } from "./shared/connection-wizard";
import { Constants } from "./config/constants";
import { Global } from "./shared/global";
import { CredentialStore } from "./shared/credential-store";
import { loadWorkspaceConnections } from "./shared/workspace-config";
import { logger } from "./logger/logger";

export class FirebirdTreeDataProvider implements TreeDataProvider<FirebirdTree> {
  public _onDidChangeTreeData: EventEmitter<FirebirdTree | undefined> = new EventEmitter<FirebirdTree | undefined>();
  public readonly onDidChangeTreeData: Event<FirebirdTree | undefined> = this._onDidChangeTreeData.event;

  private savedConnections: { [key: string]: ConnectionOptions } = {};

  constructor(private context: ExtensionContext) {}

  public getTreeItem(element: FirebirdTree): Promise<TreeItem> | TreeItem {
    return element.getTreeItem(this.context);
  }

  public getChildren(element?: FirebirdTree): Thenable<FirebirdTree[]> | FirebirdTree[] {
    if (!element) {
      return this.getHostNodes();
    }
    return element.getChildren();
  }

  /* add new Firebird connection */
  public async addConnection() {
    logger.info("Add Connection start...");

    /* generate unique id for new connection */
    const id = uuidv1();

    /* fetch saved connections for update*/
    this.savedConnections = this.context.globalState.get<{ [key: string]: ConnectionOptions }>(
      Constants.ConectionsKey
    ) ?? {};

    logger.debug(`${Object.keys(this.savedConnections).length} saved connection(s) found...`);

    /* present connection wizard */
    await connectionWizard()
      .then(async newOptions => {
        newOptions.id = id;
        if (typeof newOptions.port === "string") {
          newOptions.port = Number.parseInt(newOptions.port);
        }

        /* store password securely and remove it from the persisted options */
        const password = newOptions.password;
        await CredentialStore.storePassword(id, password || "");
        const optionsToSave: ConnectionOptions = { ...newOptions, password: undefined };

        this.savedConnections[id] = optionsToSave;

        await this.context.globalState.update(Constants.ConectionsKey, this.savedConnections).then(
          () => {
            /* keep password in the runtime object for immediate use */
            Global.activeConnection = newOptions;
            this.refresh();
            logger.info("Add Connection end...");
            logger.debug(`Connection ID: ${this.savedConnections[id].id}`);
            logger.showInfo("New Firebird connection added successfully!");
          },
          err => {
            logger.error(err);
          }
        );
      })
      .catch(error => {
        logger.error(error);
      });
  }

  private async getHostNodes(): Promise<NodeHost[]> {
    logger.debug("Get host nodes start.");
    const connections = { ...(this.context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {}) };

    /* merge in connections declared by any open workspace folder's .vscode/firebird.json —
       re-read from disk on every refresh, never persisted into globalState */
    const workspaceConnections = await loadWorkspaceConnections();
    workspaceConnections.forEach(conn => { connections[conn.id] = conn; });

    const nodeHosts = [];
    if (Object.keys(connections).length > 0) {
      const groupedConnections = this.groupedArray(connections);

      for (const key in groupedConnections) {
        nodeHosts.push(new NodeHost(key, groupedConnections[key]));
      }
    }
    Global.initStatusBarItems();
    logger.debug("Get host nodes end.");
    return nodeHosts;
  }

  private groupedArray(connections: { [key: string]: ConnectionOptions }): { [host: string]: ConnectionOptions[] } {
    return Object.keys(connections)
      .map(id => {
        connections[id].id = id;
        return connections[id];
      })
      .reduce<{ [host: string]: ConnectionOptions[] }>((h, a) => {
        const groupKey = a.embedded ? "(embedded)" : a.host;
        return Object.assign(h, { [groupKey]: (h[groupKey] || []).concat(a) });
      }, {});
  }

  public refresh(element?: FirebirdTree): void {
    logger.debug("Refresh Firebird Explorer View");
    this._onDidChangeTreeData.fire(element);
  }
}
