import {SimpleCallback} from 'node-firebird';
import {ConnectionOptions} from '../interfaces';

export const simpleCallbackToPromise = (callbackFunction: ((arg0: SimpleCallback) => any)): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        callbackFunction((err) => {
            if (err) {
                reject(err);
            }
            resolve();
        });
    });
};

/** Extracts the trailing filename from a database path, whether it uses Windows or POSIX separators. */
export function getDatabaseFileName(databasePath: string): string {
    return (databasePath.split('\\').pop() ?? databasePath).split('/').pop() ?? databasePath;
}

/** Builds a short human-readable label for a connection, e.g. "localhost:test.fdb" or "[embedded] test.fdb". */
export function getConnectionLabel(conn: ConnectionOptions): string {
    const dbName = getDatabaseFileName(conn.database);
    return conn.embedded ? `[embedded] ${dbName}` : `${conn.host}:${dbName}`;
}