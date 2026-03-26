import { ExtensionContext } from "vscode";
import { logger } from "../logger/logger";

/**
 * Manages secure storage of Firebird connection passwords using VS Code's SecretStorage API.
 * Passwords are stored with the key prefix `firebird.password.<connectionId>` and are
 * never written to the unencrypted globalState.
 */
export class CredentialStore {
  private static _context: ExtensionContext;
  private static readonly KEY_PREFIX = "firebird.password.";

  static setContext(context: ExtensionContext): void {
    this._context = context;
  }

  private static getContext(): ExtensionContext {
    if (!this._context) {
      throw new Error("CredentialStore: setContext() must be called before using SecretStorage.");
    }
    return this._context;
  }

  static async storePassword(connectionId: string, password: string): Promise<void> {
    await this.getContext().secrets.store(`${this.KEY_PREFIX}${connectionId}`, password);
    logger.debug(`Password stored for connection ${connectionId}`);
  }

  static async getPassword(connectionId: string): Promise<string | undefined> {
    return this.getContext().secrets.get(`${this.KEY_PREFIX}${connectionId}`);
  }

  static async deletePassword(connectionId: string): Promise<void> {
    await this.getContext().secrets.delete(`${this.KEY_PREFIX}${connectionId}`);
    logger.debug(`Password deleted for connection ${connectionId}`);
  }
}
