export interface Options {
  mockarooApiKey: string | null;
  maxTablesCount: number;
  codeCompletionKeywords: boolean;
  codeCompletionDatabase: boolean;
  logLevel: string;
  recordsPerPage: string;
  useNativeDriver: boolean;
}
