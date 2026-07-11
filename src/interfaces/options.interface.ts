export interface Options {
  mockarooApiKey: string | null;
  maxTablesCount: number;
  codeCompletionKeywords: boolean;
  codeCompletionDatabase: boolean;
  logLevel: string;
  recordsPerPage: string;
  useNativeDriver: boolean;
  /** Explicit path to the isql/isql-fb executable; empty string means "search PATH". */
  isqlPath: string;
  /** Show a "System Tables" folder listing Firebird's built-in RDB$ system/metadata tables. */
  showSystemObjects: boolean;
  /** Explicit path to the docker executable; empty string means "search PATH". */
  dockerPath: string;
}
