import { Disposable } from "vscode";
import { join } from "path";
import { QueryResultsView, Message } from "../result-view/queryResultsView";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { logger } from "../logger/logger";

/** A single column as loaded from an existing table, for Alter Table mode. */
export interface AlterTableColumn {
  name: string;
  type: string;
  /** Only meaningful for VARCHAR/CHAR/CSTRING — omitted for other types. */
  size?: number;
  notNull: boolean;
  pk: boolean;
  /** Bare default value expression (no leading "DEFAULT" keyword), if any. */
  dflt?: string;
}

export class TableDesigner extends QueryResultsView implements Disposable {
  private dbDetails: ConnectionOptions | undefined;
  /**
   * The webview can't reliably receive a postMessage() sent immediately after show() — its
   * script may not have run yet. It posts a "ready" message once loaded; until then, the initial
   * state to display is held here and flushed from handleMessage() on "ready".
   */
  private pendingInit: Message | undefined;

  constructor(private readonly extensionPath: string) {
    super("tabledesigner", "Firebird Table Designer");
  }

  open(dbDetails?: ConnectionOptions) {
    this.dbDetails = dbDetails;
    this.pendingInit = { command: "init", data: { mode: "create" } };
    super.show(join(this.extensionPath, "src", "table-designer", "htmlContent", "index.html"));
  }

  /** Opens the designer pre-populated with an existing table's columns, generating ALTER TABLE instead of CREATE TABLE. */
  openForAlter(
    dbDetails: ConnectionOptions,
    tableName: string,
    columns: AlterTableColumn[],
    pkConstraintName: string | null
  ) {
    this.dbDetails = dbDetails;
    this.pendingInit = {
      command: "init",
      data: { mode: "alter", tableName, columns, pkConstraintName }
    };
    super.show(join(this.extensionPath, "src", "table-designer", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    const { command, data } = message as Message & { data: { ddl?: string } };
    if (command === "ready") {
      if (this.pendingInit) {
        this.send(this.pendingInit);
        this.pendingInit = undefined;
      }
      return;
    }
    if (command === "openInEditor") {
      Driver.createSQLTextDocument(data.ddl ?? "").catch(err => logger.error(err));
    } else if (command === "executeDDL") {
      if (!this.dbDetails) {
        this.send({ command: "result", data: { text: "No active database connection." } });
        return;
      }
      Driver.runQuery(data.ddl ?? "", this.dbDetails)
        .then(result => {
          const text = (result?.[0] as any)?.message ?? "DDL executed successfully.";
          this.send({ command: "result", data: { text } });
        })
        .catch(err => {
          const text = err?.message ?? String(err);
          logger.error(text);
          this.send({ command: "result", data: { text: `Error: ${text}` } });
        });
    }
  }
}
