import { Global } from '../shared/global';
import { getOptions } from '../config';
import { getTablesQuery, fieldsQuery } from '../shared/queries';
import { ConnectionOptions, Schema } from '../interfaces';
import { logger } from '../logger/logger';
import { Driver } from '../shared/driver';

type ResultSet = Array<any>;

export class KeywordsDb {
    public async getSchema(): Promise<Schema.Database> {
        try {
            if (!Global.activeConnection && !getOptions().codeCompletionDatabase) {
                return { reservedKeywords: getOptions().codeCompletionKeywords, path: "", tables: [] };
            }
            const schema = await this.build(Global.activeConnection, getOptions().codeCompletionKeywords, getOptions().maxTablesCount);
            return schema ?? { reservedKeywords: getOptions().codeCompletionKeywords, path: "", tables: [] };
        } catch (err) {
            logger.error(err);
            return { reservedKeywords: getOptions().codeCompletionKeywords, path: "", tables: [] };
        }
    }

    async build(conOptions: ConnectionOptions, codeCompletionKeywords: boolean, maxTablesCount: number): Promise<Schema.Database | undefined> {
        const schema = {
            reservedKeywords: codeCompletionKeywords,
            path: conOptions.database,
            tables: [],
        } as Schema.Database;
        const tableNames: string[] = [];

        const connection = await Driver.client.createConnection(await Driver.resolvePassword(conOptions));
        const resultSet: ResultSet = await Driver.client.queryPromise(connection, getTablesQuery(maxTablesCount));
        if (!resultSet || resultSet.length === 0) {
            return undefined;
        }

        schema.tables = resultSet.map(row => {
            tableNames.push(row.TABLE_NAME.trim());
            return {
                name: row.TABLE_NAME.trim(),
                fields: [],
            } as Schema.Table;
        });

        const fieldsResult: ResultSetFields[] = await Driver.client.queryPromise(connection, fieldsQuery(tableNames));
        if (!fieldsResult || fieldsResult.length === 0) {
            return undefined;
        }

        const groupedResult: { [key: string]: ResultSetFields[] } = {};
        fieldsResult.forEach((table) => (groupedResult[table.TBL.trim()] = [...(groupedResult[table.TBL.trim()] ?? []), table]));

        for (const schemaTable of schema.tables) {
            (groupedResult[schemaTable.name] ?? []).forEach(element => {
                let field_type = element.FIELD_TYPE.trim();
                if (field_type === 'VARCHAR') field_type = `${field_type}(${element.FIELD_LENGTH})`;
                schemaTable.fields.push({
                    name: element.FIELD.trim(),
                    type: field_type,
                } as Schema.Field);
            });
        }
        return schema;

    }
}

interface ResultSetFields {
    DFLT_VALUE: any;
    FIELD: string;
    FIELD_LENGTH: number;
    FIELD_TYPE: string;
    NOTNULL: string;
    POS: number;
    TBL: string;
}