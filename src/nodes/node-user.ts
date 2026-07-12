import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, Uri} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {dropUserQuery, alterUserPasswordQuery, createUserQuery} from "../shared/queries";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";
import {buildUserCreatePlaceholderDDL} from "../script-as/ddl-builders";

export class NodeUser implements FirebirdTree {
  constructor(private readonly userName: string, private readonly dbDetails?: ConnectionOptions) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    const name = this.userName.trim();
    return {
      label: name,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "user",
      tooltip: `[USER] ${name}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "user-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "user-light.svg"))
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }

  /**
   * Connects directly (not via Driver.runQuery) so the plaintext password never lands in session
   * query history or the output channel log — both record the exact SQL text of every query run
   * through runQuery()/runBatch().
   */
  public static async createUser(dbDetails: ConnectionOptions, userName: string, password: string): Promise<void> {
    logger.info("Create User");
    const connection = await Driver.client.createConnection(await Driver.resolvePassword(dbDetails));
    try {
      await Driver.client.queryPromise(connection, createUserQuery(userName.trim(), password));
      logger.info(`User ${userName.trim()} created.`);
      logger.showInfo(`User ${userName.trim()} created.`);
      commands.executeCommand("firebird.explorer.refresh");
    } catch (err) {
      logger.error(err);
      logger.showError(`Failed to create user: ${err}`);
    } finally {
      await Driver.client.detach(connection);
    }
  }

  public async dropUser() {
    if (!this.dbDetails) { return; }
    logger.info("Drop User");
    Driver.runQuery(dropUserQuery(this.userName.trim()), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to drop user: ${err}`);
      });
  }

  /**
   * Changes the user's password directly (not via Driver.runQuery), so the plaintext password
   * never lands in session query history or the output channel log — both of which record the
   * exact SQL text of every query run through runQuery()/runBatch().
   */
  public async changePassword(newPassword: string) {
    if (!this.dbDetails) { return; }
    logger.info("Change User Password");
    const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
    try {
      await Driver.client.queryPromise(connection, alterUserPasswordQuery(this.userName.trim(), newPassword));
      logger.info(`Password updated for user ${this.userName.trim()}.`);
      logger.showInfo(`Password updated for user ${this.userName.trim()}.`);
    } catch (err) {
      logger.error(err);
      logger.showError(`Failed to change password: ${err}`);
    } finally {
      await Driver.client.detach(connection);
    }
  }

  /**
   * Generic "Script as Create" — unlike every other object type, this can't be a genuine
   * reconstruction: Firebird never exposes an existing user's password via SQL, and this
   * extension never stores one in plaintext either. Opens a clearly-marked placeholder instead.
   */
  public async scriptAsCreate(): Promise<void> {
    await Driver.createSQLTextDocument(buildUserCreatePlaceholderDDL(this.userName.trim()));
  }

  /** Generic "Script as Drop". */
  public async scriptAsDrop(): Promise<void> {
    await Driver.createSQLTextDocument(dropUserQuery(this.userName.trim()));
  }
}
