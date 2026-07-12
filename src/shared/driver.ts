import {TextEditor, workspace, window, ViewColumn, ExtensionContext, commands} from "vscode";
import * as Firebird from "node-firebird";
import {Global} from "./global";
import {ConnectionOptions, Options} from "../interfaces";
import {logger} from "../logger/logger";
import type { Attachment, Client, ResultSet} from 'node-firebird-driver-native';
import { TransactionIsolation, TransactionOptions as NativeTransactionOptions } from 'node-firebird-driver';
import {simpleCallbackToPromise, getConnectionLabel} from './utils';
import {CredentialStore} from './credential-store';
import {splitStatements} from './sql-splitter';
import {PooledClient, ConnectionPoolOptions} from './connection-pool';
import {getOptions} from '../config';
import * as fs from 'fs';
import path = require('path');

/**
 * Driver-agnostic transaction request, built once per runQuery()/runBatch() call from the
 * firebird.transaction.* settings and passed down to whichever client is active. Only the fields
 * actually overridden by settings are populated, so an unset field falls through to the
 * underlying driver's own default rather than this module hard-coding one.
 */
export type TransactionIsolationLevel = Exclude<Options["transactionIsolationLevel"], "">;

export interface TransactionRequestOptions {
  isolation?: TransactionIsolationLevel;
  readOnly?: boolean;
  wait?: boolean;
  /** Lock wait timeout in seconds. Only honored by NodeClient — see toNativeTransactionOptions(). */
  lockTimeoutSec?: number;
}

/** Builds a TransactionRequestOptions from the firebird.transaction.* settings. Exported for unit testing. */
export function buildTransactionOptions(options: Pick<Options,
  "transactionIsolationLevel" | "transactionLockTimeoutSec" | "transactionReadOnly" | "transactionWaitMode"
>): TransactionRequestOptions {
  const txOptions: TransactionRequestOptions = {};
  if (options.transactionIsolationLevel) {
    txOptions.isolation = options.transactionIsolationLevel;
  }
  if (options.transactionReadOnly) {
    txOptions.readOnly = true;
  }
  if (options.transactionWaitMode) {
    txOptions.wait = options.transactionWaitMode === "WAIT";
  }
  if (options.transactionLockTimeoutSec) {
    txOptions.lockTimeoutSec = options.transactionLockTimeoutSec;
  }
  return txOptions;
}

/**
 * Maps our driver-agnostic isolation name to node-firebird's own TPB constants. node-firebird
 * names these confusingly: ISOLATION_READ_UNCOMMITTED is NOT a dirty-read isolation (Firebird has
 * no such thing) — it's read_committed+rec_version, i.e. real "Read Committed (Record Version)".
 * We expose the correct Firebird terminology in settings and translate it here instead.
 */
const NODE_FIREBIRD_ISOLATION_MAP: Record<string, Firebird.Isolation> = {
  READ_COMMITTED_RECORD_VERSION: Firebird.ISOLATION_READ_UNCOMMITTED,
  READ_COMMITTED_NO_RECORD_VERSION: Firebird.ISOLATION_READ_COMMITTED,
  SNAPSHOT: Firebird.ISOLATION_REPEATABLE_READ,
  SNAPSHOT_TABLE_STABILITY: Firebird.ISOLATION_SERIALIZABLE,
};

/** Exported for unit testing. */
export function toNodeFirebirdTransactionOptions(txOptions?: TransactionRequestOptions): Firebird.TransactionOptions {
  if (!txOptions) {
    return {};
  }
  const opts: Firebird.TransactionOptions = {};
  if (txOptions.isolation) {
    opts.isolation = NODE_FIREBIRD_ISOLATION_MAP[txOptions.isolation];
  }
  if (txOptions.readOnly !== undefined) {
    opts.readOnly = txOptions.readOnly;
  }
  if (txOptions.wait !== undefined) {
    opts.wait = txOptions.wait;
  }
  if (txOptions.lockTimeoutSec !== undefined) {
    opts.waitTimeout = txOptions.lockTimeoutSec;
  }
  return opts;
}

const NATIVE_ISOLATION_MAP: Record<string, TransactionIsolation> = {
  READ_COMMITTED_RECORD_VERSION: TransactionIsolation.READ_COMMITTED,
  READ_COMMITTED_NO_RECORD_VERSION: TransactionIsolation.READ_COMMITTED,
  SNAPSHOT: TransactionIsolation.SNAPSHOT,
  SNAPSHOT_TABLE_STABILITY: TransactionIsolation.CONSISTENCY,
};

/**
 * Exported for unit testing. lockTimeoutSec has no equivalent in node-firebird-driver's
 * TransactionOptions (no numeric lock-timeout TPB item, only a wait/no-wait toggle) — it is
 * silently not applied here; only NodeClient can honor it.
 */
export function toNativeTransactionOptions(txOptions?: TransactionRequestOptions): NativeTransactionOptions {
  if (!txOptions) {
    return {};
  }
  const opts: NativeTransactionOptions = {};
  if (txOptions.isolation) {
    opts.isolation = NATIVE_ISOLATION_MAP[txOptions.isolation];
    if (txOptions.isolation === "READ_COMMITTED_RECORD_VERSION") {
      opts.readCommittedMode = "RECORD_VERSION";
    } else if (txOptions.isolation === "READ_COMMITTED_NO_RECORD_VERSION") {
      opts.readCommittedMode = "NO_RECORD_VERSION";
    }
  }
  if (txOptions.readOnly !== undefined) {
    opts.accessMode = txOptions.readOnly ? "READ_ONLY" : "READ_WRITE";
  }
  if (txOptions.wait !== undefined) {
    opts.waitMode = txOptions.wait ? "WAIT" : "NO_WAIT";
  }
  return opts;
}

/** Result of a single SQL statement within a batch run. */
export interface BatchResult {
  /** The SQL statement that was executed. */
  sql: string;
  /** Row data (for SELECT-like statements), or undefined for DDL/DML. */
  rows?: any[];
  /** Human-readable outcome message for DDL/DML statements. */
  message?: string;
  /** Error message, present when the statement failed. */
  error?: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
}

/** A single query execution recorded for the session query history. */
export interface HistoryLogEntry {
  sql: string;
  connectionId?: string;
  connectionLabel?: string;
  rowCount?: number;
  durationMs: number;
  error?: string;
}

export class Driver {

  static async setClient(
    useNativeDriver: boolean,
    context: ExtensionContext,
    pooling?: ConnectionPoolOptions
  ): Promise<void> {
    CredentialStore.setContext(context);
    if (this.client instanceof PooledClient) {
      await this.client.shutdown();
    }
    const rawClient: ClientI<any> = useNativeDriver ? new NativeClient(context.extensionUri.fsPath) : new NodeClient();
    this.client = pooling ? new PooledClient(rawClient, pooling) : rawClient;
  }

  /** Closes any pooled idle connections. Call on extension deactivation. */
  static async shutdown(): Promise<void> {
    if (this.client instanceof PooledClient) {
      await this.client.shutdown();
    }
  }

  static client: ClientI<any>;

  /** Optional sink for automatic query history logging; wired up once in extension.ts#activate(). */
  static historyLogger?: (entry: HistoryLogEntry) => void;

  public static setHistoryLogger(historyLogger: (entry: HistoryLogEntry) => void): void {
    this.historyLogger = historyLogger;
  }

  /**
   * Records a single executed statement to the session query history (if a logger is
   * registered). Every query run through runQuery()/runBatch() — i.e. every query the user
   * explicitly executes, whether typed or triggered from a tree context-menu action — passes
   * through here. Internal schema-introspection queries (tree population, autocomplete) go
   * through Driver.client directly and are intentionally not logged.
   */
  private static logHistory(
    sql: string,
    connectionOptions: ConnectionOptions | undefined,
    durationMs: number,
    rowCount?: number,
    error?: string
  ): void {
    if (!this.historyLogger) {
      return;
    }
    this.historyLogger({
      sql,
      connectionId: connectionOptions?.id,
      connectionLabel: connectionOptions ? getConnectionLabel(connectionOptions) : undefined,
      rowCount,
      durationMs,
      error,
    });
  }

  public static async createSQLTextDocument(sql?: string): Promise<TextEditor> {
    const textDocument = await workspace.openTextDocument({content: sql, language: "sql"});
    return window.showTextDocument(textDocument, ViewColumn.One);
  }

  public static constructResponse(sql: string): string | null {
    const string = sql.toLowerCase();
    if (string.indexOf("create") > -1) {
      return "Create";
    } else if (string.indexOf("insert") > -1) {
      return "Insert";
    } else if (string.indexOf("alter") > -1) {
      return "Alter";
    } else if (string.indexOf("drop") > -1) {
      return "Drop";
    } else if (string.indexOf("delete") > -1) {
      return "Delete";
    }
    return null;
  }

  /**
   * Resolves the password for a connection, fetching from SecretStorage if not already set.
   * Public because runQuery()/runBatch() call it automatically, but any code that connects via
   * Driver.client.createConnection() directly (bypassing those) must call it explicitly first —
   * saved connections never carry a password (see FirebirdTreeDataProvider#addConnection), so
   * skipping this fails with "Your user name and password are not defined".
   */
  public static async resolvePassword(connectionOptions: ConnectionOptions): Promise<ConnectionOptions> {
    if (connectionOptions.password) {
      return connectionOptions;
    }
    const stored = await CredentialStore.getPassword(connectionOptions.id);
    return { ...connectionOptions, password: stored ?? "" };
  }

  public static async runQuery(sql?: string, connectionOptions?: ConnectionOptions): Promise<any> {
    logger.debug("Run Query start...");

    if (!sql && !window.activeTextEditor) {
      return Promise.reject({
        notify: true,
        message: "No SQL document opened!",
        options: ["Cancel", "New SQL Document"]
      });
    }
    if (!sql && window.activeTextEditor) {
      if (window.activeTextEditor.document.languageId !== "sql") {
        return Promise.reject({
          notify: true,
          message: "No SQL document opened!",
          options: ["Cancel", "New SQL Document"]
        });
      }
    }
    if (!connectionOptions) {
      if (!Global.activeConnection) {
        return Promise.reject({
          notify: true,
          message: "No Firebird database selected!",
          options: ["Cancel", "Set Active Database"]
        });
      }
    }

    // finally check if empty sql document
    if (!sql) {
      const activeTextEditor = window.activeTextEditor;
      const selection = activeTextEditor!.selection;
      if (selection.isEmpty) {
        sql = activeTextEditor!.document.getText();
      } else {
        sql = activeTextEditor!.document.getText(selection);
      }
      if (!sql) {
        return Promise.reject({notify: false, message: "No valid SQL commands found!"});
      }
    }

    connectionOptions = connectionOptions ? connectionOptions : Global.activeConnection;
    connectionOptions = await this.resolvePassword(connectionOptions);

    logger.info("Executing Firebird query...");

    const start = Date.now();
    const connection = await this.client.createConnection(connectionOptions);
    const txOptions = buildTransactionOptions(getOptions());
    try {
      const result = await this.client.queryPromise(connection, sql, undefined, txOptions);
      const durationMs = Date.now() - start;

      if (result !== undefined) {
        //convert blob
        result.forEach(resultRow => {
          const row = resultRow as Record<string, any>;
          Object.keys(row).forEach(field => {
            if (row[field] instanceof Function) {
              row[field]((_err: any, _name: any, e: any) => {
                e.on("data", (chunk: any) => {
                  row[field] = chunk;
                });
              });
            }
          });
        });
        logger.info("Finished Firebird query, displaying results... ");
        this.logHistory(sql, connectionOptions, durationMs, result.length);
        return result;
      } else {
        // because node-firebird plugin doesn't have callback on successfull ddl statements (test further)
        logger.info("Finished Firebird query.");
        const ddl = this.constructResponse(sql);
        this.logHistory(sql, connectionOptions, durationMs);
        return ([{message: `${ddl} command executed successfully!`}]);
      }
    } catch (err: any) {
      this.logHistory(sql, connectionOptions, Date.now() - start, undefined, err?.message ?? String(err));
      throw err;
    } finally {
      this.client.detach(connection);
    }
  }

  /**
   * Resolves SQL text from the active editor (or the provided string), validates the active
   * connection, and returns `{ sql, connectionOptions }` ready for execution.
   */
  private static async resolveSqlAndConnection(
    sql?: string,
    connectionOptions?: ConnectionOptions
  ): Promise<{ sql: string; connectionOptions: ConnectionOptions }> {
    if (!sql && !window.activeTextEditor) {
      throw { notify: true, message: "No SQL document opened!", options: ["Cancel", "New SQL Document"] };
    }
    if (!sql && window.activeTextEditor && window.activeTextEditor.document.languageId !== "sql") {
      throw { notify: true, message: "No SQL document opened!", options: ["Cancel", "New SQL Document"] };
    }
    if (!connectionOptions && !Global.activeConnection) {
      throw { notify: true, message: "No Firebird database selected!", options: ["Cancel", "Set Active Database"] };
    }
    if (!sql) {
      const editor = window.activeTextEditor!;
      const selection = editor.selection;
      sql = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
      if (!sql) {
        throw { notify: false, message: "No valid SQL commands found!" };
      }
    }
    connectionOptions = connectionOptions ?? Global.activeConnection;
    connectionOptions = await this.resolvePassword(connectionOptions);
    return { sql, connectionOptions };
  }

  /**
   * Executes all semicolon-separated statements in the given SQL text and returns an array of
   * `BatchResult` objects — one per statement.
   */
  public static async runBatch(
    sql?: string,
    connectionOptions?: ConnectionOptions
  ): Promise<BatchResult[]> {
    logger.debug("runBatch start...");

    const resolved = await this.resolveSqlAndConnection(sql, connectionOptions);
    const statements = splitStatements(resolved.sql);

    if (statements.length === 0) {
      throw { notify: false, message: "No valid SQL commands found!" };
    }

    logger.info(`Batch: executing ${statements.length} statement(s)...`);

    const connection = await this.client.createConnection(resolved.connectionOptions);
    const txOptions = buildTransactionOptions(getOptions());
    const results: BatchResult[] = [];

    try {
      for (const stmt of statements) {
        const start = Date.now();
        try {
          const rows = await this.client.queryPromise(connection, stmt, undefined, txOptions);
          const durationMs = Date.now() - start;

          if (rows !== undefined) {
            // Convert blobs
            rows.forEach(row => {
              const r = row as Record<string, any>;
              Object.keys(r).forEach(field => {
                if (r[field] instanceof Function) {
                  r[field]((_err: any, _name: any, e: any) => {
                    e.on("data", (chunk: any) => { r[field] = chunk; });
                  });
                }
              });
            });
            results.push({ sql: stmt, rows, durationMs });
            this.logHistory(stmt, resolved.connectionOptions, durationMs, rows.length);
          } else {
            const ddl = this.constructResponse(stmt);
            results.push({
              sql: stmt,
              message: `${ddl ?? "Statement"} executed successfully.`,
              durationMs,
            });
            this.logHistory(stmt, resolved.connectionOptions, durationMs);
          }
        } catch (err: any) {
          const durationMs = Date.now() - start;
          results.push({ sql: stmt, error: err?.message ?? String(err), durationMs });
          logger.error(`Batch statement failed: ${err?.message ?? err}`);
          this.logHistory(stmt, resolved.connectionOptions, durationMs, undefined, err?.message ?? String(err));
        }
      }
    } finally {
      this.client.detach(connection);
    }

    logger.info(`Batch completed. ${results.length} result(s) ready.`);
    return results;
  }

  /**
   * Returns the Firebird query execution plan for the given SELECT statement.
   *
   * - NativeClient: uses `Attachment.prepare()` + `Statement.getPlan()`.
   * - NodeClient:   falls back to querying index metadata from system tables.
   */
  public static async getQueryPlan(
    sql?: string,
    connectionOptions?: ConnectionOptions
  ): Promise<string> {
    const resolved = await this.resolveSqlAndConnection(sql, connectionOptions);
    const stmt = resolved.sql;

    if (this.client instanceof NativeClient) {
      return (this.client as NativeClient).getQueryPlan(resolved.connectionOptions, stmt);
    }

    // NodeClient fallback: extract table names and show index metadata
    const tables = extractTableNames(stmt);
    if (tables.length === 0) {
      return `-- PLAN not available via node-firebird driver.\n-- Use the native driver (firebird.useNativeDriver) for execution plans.\n-- Query:\n${stmt}`;
    }

    const placeholders = tables.map(() => "?").join(", ");
    const metaSql = `SELECT TRIM(i.RDB$RELATION_NAME) AS TABLE_NAME,
       TRIM(i.RDB$INDEX_NAME)    AS INDEX_NAME,
       TRIM(s.RDB$FIELD_NAME)    AS FIELD_NAME,
       i.RDB$UNIQUE_FLAG         AS IS_UNIQUE
  FROM RDB$INDICES i
  JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = i.RDB$INDEX_NAME
 WHERE TRIM(i.RDB$RELATION_NAME) IN (${placeholders})
 ORDER BY 1, 2, s.RDB$FIELD_POSITION`;

    const connection = await this.client.createConnection(resolved.connectionOptions);
    try {
      const rows: any[] = await (this.client as NodeClient).queryPromise(connection, metaSql, tables);
      if (!rows || rows.length === 0) {
        return `-- No index information found for table(s): ${tables.join(", ")}\n-- Query:\n${stmt}`;
      }
      let plan = `-- Firebird Index Metadata (node-firebird fallback plan)\n-- Use native driver for real PLAN output.\n--\n-- Query:\n`;
      stmt.split("\n").forEach(l => (plan += `--   ${l}\n`));
      plan += "\n";
      let lastTable = "";
      rows.forEach((r: any) => {
        const tbl = (r.TABLE_NAME ?? "").trim();
        if (tbl !== lastTable) {
          plan += `\nTABLE ${tbl}\n`;
          lastTable = tbl;
        }
        const uniq = r.IS_UNIQUE ? " (UNIQUE)" : "";
        plan += `  INDEX ${(r.INDEX_NAME ?? "").trim()}${uniq} — field: ${(r.FIELD_NAME ?? "").trim()}\n`;
      });
      return plan;
    } finally {
      this.client.detach(connection);
    }
  }

}

export interface ClientI<K extends Firebird.Database | Attachment> {
  queryPromise<T extends object>(connection: K, sql: string, args?: any[], txOptions?: TransactionRequestOptions): Promise<T[]>;
  createConnection(connectionOptions: ConnectionOptions): Promise<K>;
  detach(connection: K): Promise<void>;
}

/**
 * Maps our ConnectionOptions to a node-firebird Options object, handling embedded and
 * Firebird 4.x/5.x fields. Exported for unit testing.
 */
export function toNodeFirebirdOptions(connectionOptions: ConnectionOptions): Firebird.Options {
  const opts: Firebird.Options = {
    database: connectionOptions.database,
    user: connectionOptions.user,
    password: connectionOptions.password ?? "",
    role: connectionOptions.role ?? undefined
  };

  if (!connectionOptions.embedded) {
    opts.host = connectionOptions.host;
    opts.port = connectionOptions.port ?? 3050;
  }

  if (connectionOptions.wireCrypt) {
    // node-firebird's Options.wireCrypt is the numeric WIRE_CRYPT_DISABLE/WIRE_CRYPT_ENABLE
    // constant (written directly into the wire protocol handshake), not our UI-facing
    // 'Required' | 'Enabled' | 'Disabled' string — node-firebird has no separate
    // "required" wire value, so anything but 'Disabled' maps to WIRE_CRYPT_ENABLE.
    opts.wireCrypt = connectionOptions.wireCrypt === 'Disabled' ? Firebird.WIRE_CRYPT_DISABLE : Firebird.WIRE_CRYPT_ENABLE;
  }
  if (connectionOptions.authPlugin) {
    (opts as any).authPlugin = connectionOptions.authPlugin;
  }

  return opts;
}

export class NodeClient implements ClientI<Firebird.Database> {
  /**
   * Runs `sql` in its own transaction, built manually (rather than the simpler `connection.query()`)
   * so firebird.transaction.* settings can be applied — `Database.query()`/`execute()` always call
   * `startTransaction()` with no options, hard-coding the driver's defaults.
   */
  public queryPromise<T>(connection: Firebird.Database, sql: string, args: any[] = [], txOptions?: TransactionRequestOptions): Promise<T[]> {
    return new Promise((resolve, reject) => {
      connection.transaction(toNodeFirebirdTransactionOptions(txOptions), (txErr: any, transaction: Firebird.Transaction) => {
        if (txErr) {
          reject("Error queryPromise: " + txErr.message);
          return;
        }
        transaction.query(sql, args, (err: any, rows: any) => {
          if (err) {
            transaction.rollback(() => reject("Error queryPromise: " + err.message));
            return;
          }
          transaction.commit((commitErr: any) => {
            if (commitErr) {
              reject("Error queryPromise: " + commitErr.message);
              return;
            }
            resolve(rows);
          });
        });
      });
    });
  }

  public async createConnection(connectionOptions: ConnectionOptions): Promise<Firebird.Database> {
    if (connectionOptions.embedded) {
      // node-firebird only ever speaks the wire protocol over TCP — it has no embedded-engine
      // support, so without host/port it would silently fall back to 127.0.0.1:3050 instead of
      // opening the local file directly. Fail loudly rather than connecting to the wrong thing.
      throw new Error(
        "Embedded database connections require the native driver. Enable \"firebird.useNativeDriver\" in settings to connect to this database."
      );
    }
    const opts = toNodeFirebirdOptions(connectionOptions);
    return await new Promise<Firebird.Database>((resolve, reject) => {
      Firebird.attach(opts, (err, db) => {
        if (err) {
          logger.error(err.message);
          reject(err);
        }

        resolve(db);
      });
    });
  }

  public async detach(connection: Firebird.Database) {
    if (connection) {
      await simpleCallbackToPromise((callback) => connection.detach(callback));
    }
  }
}

export class NativeClient implements ClientI<Attachment> {

  constructor(pathExt: string) {
    if (!fs.existsSync(path.join(pathExt, 'node_modules/node-firebird-native-api/build/Release'))) {
      commands.executeCommand("firebird.buildNative");
    }
  }

  public async queryPromise<T extends object>(connection: Attachment, sql: string, _args?: any[], txOptions?: TransactionRequestOptions): Promise<T[]> {
    if (!connection?.isValid) {
      throw new Error("Invalid Connection");
    }
    const trans = await connection.startTransaction(toNativeTransactionOptions(txOptions));
    let res: ResultSet | undefined;
    try {
      res = await connection.executeQuery(trans, sql);
      const result = await res.fetchAsObject<T>();
      await res.close();
      await trans.commit();
      return result;  
    } catch (err) {
      if (res?.isValid) {
        await res.close();
      }
      if (trans.isValid) {
        await trans.rollback();
      }
      throw err;
    }
  }

  public async createConnection(connectionOptions: ConnectionOptions): Promise<Attachment> {
    const connectionStr = connectionOptions.embedded
      ? connectionOptions.database
      : `${connectionOptions.host}/${connectionOptions.port ?? '3050'}:${connectionOptions.database}`;

    let client: Client;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {createNativeClient, getDefaultLibraryFilename} = await import('node-firebird-driver-native');
      client = createNativeClient(getDefaultLibraryFilename());  
    } catch (e) {
      throw new Error("Unable to initialize native driver: " + ((e as any)?.message ?? e));
    }

    return await client.connect(connectionStr, {
      username: connectionOptions.user,
      password: connectionOptions.password ?? "",
      role: connectionOptions.role ?? undefined
    });

  }

  public async detach(connection: Attachment) {
    if (connection.isValid) {
      await connection.disconnect();
    } else {
      logger.debug("Called detach on an invalid connection");
    }
  }

  /**
   * Returns the Firebird execution plan for a single SELECT statement using the native driver's
   * `prepare()` + `Statement.getPlan()` API.
   */
  public async getQueryPlan(connectionOptions: ConnectionOptions, sql: string): Promise<string> {
    const connection = await this.createConnection(connectionOptions);
    try {
      const trans = await connection.startTransaction();
      try {
        const stmt = await connection.prepare(trans, sql) as any;
        const plan = await stmt.getPlan(false);
        await stmt.free();
        await trans.rollback();
        return plan ?? `-- No plan returned by Firebird for:\n${sql}`;
      } catch (err: any) {
        await trans.rollback().catch(() => {});
        throw err;
      }
    } finally {
      if (connection.isValid) {
        await connection.disconnect();
      }
    }
  }
}

/**
 * Extracts unqualified table/view names from a SQL SELECT statement's FROM and JOIN clauses.
 * This is a best-effort heuristic for the node-firebird explain-plan fallback.
 * Exported for unit testing.
 */
export function extractTableNames(sql: string): string[] {
  const names = new Set<string>();
  // Match: FROM <name>, JOIN <name>  — stop at whitespace, comma, or paren
  const re = /\b(?:FROM|JOIN)\s+([A-Z_$][A-Z0-9_$]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    names.add(m[1].toUpperCase());
  }
  return Array.from(names);
}