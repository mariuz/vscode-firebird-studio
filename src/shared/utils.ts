import {SimpleCallback} from 'node-firebird';
import {ConnectionOptions} from '../interfaces';
import {MAX_SOURCE_CAST_LENGTH} from './queries';

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

/**
 * Prepends a warning comment to `text` when the raw DDL source it was built from (a
 * procedure/trigger/view body fetched via CAST(... AS VARCHAR(MAX_SOURCE_CAST_LENGTH))) reached
 * that limit and may have been cut off.
 */
export function withTruncationWarning(rawSource: string, text: string): string {
    if (rawSource.length < MAX_SOURCE_CAST_LENGTH) {
        return text;
    }
    return `/* WARNING: source may be truncated — it reached the ${MAX_SOURCE_CAST_LENGTH}-character fetch limit. Verify against the database if this looks incomplete. */\n${text}`;
}