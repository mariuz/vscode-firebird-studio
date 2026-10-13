import {ExtensionContext, TreeItem, TreeItemCollapsibleState, Uri, window, commands} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {NodeInfo} from "./node-info";
import {logger} from "../logger/logger";
import {getObjectFilter, setObjectFilter, clearObjectFilter, showFilterPicker, promptSaveFilterPreset, promptManageFilterPresets, getAllFilterPresets} from "../shared/object-explorer-filter";
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
    let tooltip = this.label;
    if (filter) {
      const matchingPreset = getAllFilterPresets(this.category, this.dbDetails.id).find(
        p => p.filter.toLowerCase() === filter.toLowerCase()
      );
      tooltip = matchingPreset
        ? `${this.label}\nFiltered: "${filter}" (preset: ${matchingPreset.name})`
        : `${this.label}\nFiltered: "${filter}"`;
    }
    return {
      label,
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: `folder.${this.category}`,
      tooltip,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "folder-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "folder-light.svg"))
      }
    };
  }

  /**
   * Prompts to select a saved preset, enter a custom filter substring, clear the filter,
   * or save/manage filter presets.
   */
  public async setFilter(): Promise<void> {
    await showFilterPicker(this.dbDetails.id, this.category, this.label);
  }

  public async savePreset(): Promise<void> {
    const current = getObjectFilter(this.dbDetails.id, this.category);
    await promptSaveFilterPreset(current, this.category, this.dbDetails.id);
  }

  public async managePresets(): Promise<void> {
    await promptManageFilterPresets(this.category, this.dbDetails.id);
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
