import { ExtensionContext, TreeItem } from "vscode";
import { FirebirdTree } from "../interfaces";

export class NodeInfo implements FirebirdTree {
  constructor(public label?: string) {}

  public getTreeItem(_context: ExtensionContext): TreeItem {
    return {};
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }
}
