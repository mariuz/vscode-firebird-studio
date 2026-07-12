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
  /** When true, idle connections are kept alive and reused instead of reconnecting per query. */
  enableConnectionPooling: boolean;
  /** Max idle connections retained per saved connection when pooling is enabled. */
  connectionPoolMaxSize: number;
  /** How long (ms) an idle pooled connection is kept before being closed. */
  connectionPoolIdleTimeoutMs: number;
  /** How often (ms) the Live Profiler polls MON$ activity while its panel is visible. */
  profilerPollIntervalMs: number;
  /** Query-results webview key combos (event name -> combo string), overriding `DEFAULT_SHORTCUTS`. */
  shortcuts: Record<string, string>;
}
