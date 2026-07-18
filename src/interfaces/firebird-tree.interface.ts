import { ExtensionContext, TreeItem } from "vscode";
/**
 * Explorer view
 */
export interface FirebirdTree {
  getTreeItem(context: ExtensionContext): TreeItem | Promise<TreeItem>;
  getChildren(): FirebirdTree[] | Promise<FirebirdTree[]>;
  /**
   * Drag Object Explorer Entity into Editor (docs/roadmap/drag-identifier-into-editor.md) — the
   * real, unquoted object name for a node that represents one single droppable SQL identifier
   * (table, view, column, procedure, generator, domain, ...). Omitted entirely on node types with
   * no single-identifier meaning (a host, a database, a category folder) — FirebirdTreeDataProvider's
   * drag handler treats its absence as "not draggable", not an error.
   */
  getDragIdentifier?(): string;
}
