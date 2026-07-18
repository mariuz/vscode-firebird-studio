import {ExtensionContext, TreeItem, TreeItemCollapsibleState, Uri, window, commands} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {NodeInfo} from "./node-info";
import {logger} from "../logger/logger";
import {getObjectFilter, setObjectFilter, clearObjectFilter} from "../shared/object-explorer-filter";
import {Global} from "../shared/global";

export class NodeCategoryFolder implements FirebirdTree {
  constructor(
    private readonly label: string,
    private readonly category: string,
    private readonly dbDetails: ConnectionOptions,
    private readonly childFactory: (dbDetails: ConnectionOptions) => Promise<FirebirdTree[]>
  ) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    const filter = getObjectFilter(this.dbDetails.id, this.category);
    const label = filter ? `${this.label} (filtered: "${filter}")` : this.label;
    return {
      label,
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: `folder.${this.category}`,
      tooltip: filter ? `${this.label}\nFiltered: "${filter}"` : this.label,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "folder-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "folder-light.svg"))
      }
    };
  }

  /** Prompts for a substring to narrow this folder's children by name (case-insensitive); an empty input clears the filter. */
  public async setFilter(): Promise<void> {
    const current = getObjectFilter(this.dbDetails.id, this.category) ?? "";
    const input = await window.showInputBox({
      title: `Filter ${this.label}`,
      prompt: "Show only objects whose name contains this text (case-insensitive). Leave empty to clear the filter.",
      value: current,
      ignoreFocusOut: true,
    });
    if (input === undefined) { return; }
    setObjectFilter(this.dbDetails.id, this.category, input);
    commands.executeCommand("firebird.explorer.refresh");
  }

  public async clearFilter(): Promise<void> {
    clearObjectFilter(this.dbDetails.id, this.category);
    commands.executeCommand("firebird.explorer.refresh");
  }

  public async getChildren(): Promise<FirebirdTree[]> {
    try {
      const children = await this.childFactory(this.dbDetails);
      // Connection Lost Indicator (docs/roadmap/connection-lost-indicator.md), phase 3 -- a
      // successful expand clears this database's tree-node badge (and the status bar, if it's
      // also the active connection) if a previous expand had marked it unreachable.
      Global.reportConnectionOutcome(this.dbDetails.id, undefined);
      return children;
    } catch (err) {
      logger.error(err);
      Global.reportConnectionOutcome(this.dbDetails.id, err);
      return [new NodeInfo(String(err))];
    }
  }
}
