/**
 * CSV/TSV/JSON parsing and Firebird column-type sniffing for the Flat File Import Wizard. No
 * external dependency: package.json has no CSV parser today, and one file's worth of RFC 4180
 * handling (quoted fields, embedded delimiters/newlines, doubled-quote escaping) is small enough
 * to hand-roll rather than add a dependency for, matching this repo's stated preference.
 *
 * Every parse path (CSV/TSV/JSON) normalizes to the same shape — string cells, "" for null/empty —
 * so inferSchema()/inferColumnType() only ever have to sniff strings, regardless of source format.
 *
 * Mostly pure string-in/data-out functions with no vscode dependency (same "pure module" boundary
 * as sql-formatter.ts/sql-linter.ts), plus a handful of real (but still vscode-free, plain Node
 * fs/stream) file-reading helpers at the bottom for the large-file streaming path — kept in this
 * module rather than the wizard's own src/flat-file-import/index.ts specifically so they stay
 * unit-testable against real temp files, the same boundary workspace-config.ts already draws
 * between its pure parseWorkspaceConfig() and its impure (but still vscode-free) file-reading
 * loadWorkspaceConnections().
 */

import * as Firebird from "node-firebird";
import { createReadStream } from "fs";
import { open } from "fs/promises";

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

export interface ColumnInference {
  name: string;
  sqlType: string;
  nullable: boolean;
}

/** Firebird ≤3.0's identifier length limit — the safe common denominator across the FB3/4/5/6 CI matrix this repo targets (FB4+ raised it to 63). */
export const MAX_IDENTIFIER_LENGTH = 31;

// ── Format/delimiter detection ──────────────────────────────────────────────

export function detectFormat(fileName: string): "csv" | "tsv" | "json" {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (ext === "json") { return "json"; }
  if (ext === "tsv") { return "tsv"; }
  return "csv";
}

/** Picks whichever of , / ; / tab appears most often in the sample line; defaults to comma. */
export function detectDelimiter(sampleLine: string): string {
  const candidates = [",", "\t", ";"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = sampleLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : ",";
}

// ── Delimited (CSV/TSV) parsing ──────────────────────────────────────────────

/**
 * Resumable RFC 4180-ish delimited-text row parser — the state machine parseDelimited() and
 * streamDelimitedRows() both build on, the latter feeding it successive chunks from a Node stream
 * (e.g. fs.createReadStream()) rather than one whole in-memory string, for the Flat File Import
 * Wizard's large-file path (docs/roadmap/flat-file-import-wizard.md's "Large-file streaming" item).
 *
 * Two decisions are genuinely ambiguous right at a chunk boundary and can't be resolved until the
 * *next* chunk (or end-of-input) is seen, so both are deferred via a one-bit "pending" flag rather
 * than guessed: a `"` as a chunk's very last character while inside a quoted field (doubled-quote
 * escape vs. the field's real closing quote), and a bare `\r` as a chunk's very last character
 * (part of a `\r\n` pair vs. a lone old-Mac-style line ending). feed() resolves whichever is
 * pending at the very start of the next call by looking at that chunk's first character; flush()
 * resolves a still-pending quote as a real close (there's no more input left to be a doubled `""`).
 */
class DelimitedRowStreamParser {
  private row: string[] = [];
  private field = "";
  private inQuotes = false;
  private sawAnyInput = false;
  private pendingCr = false;
  private pendingQuoteInField = false;

  constructor(private readonly delimiter: string) {}

  /** Feeds one chunk of text, returning every row completed within it — a row may still span into a later feed() call if this chunk ended mid-field or mid-quote. */
  feed(chunkIn: string): string[][] {
    let text = chunkIn;
    if (!this.sawAnyInput) {
      if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); } // strip a UTF-8 BOM, if present, only at the very start of the stream
      this.sawAnyInput = true;
    }
    if (text.length === 0) {
      return []; // don't resolve either pending ambiguity on an empty chunk -- wait for real content
    }

    let i = 0;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (text[0] === "\n") { i = 1; } // the line break itself was already emitted at the end of the previous feed()
    }
    if (this.pendingQuoteInField) {
      this.pendingQuoteInField = false;
      if (text[i] === '"') {
        this.field += '"';
        i++;
      } else {
        this.inQuotes = false; // it was the field's real closing quote, not a doubled-quote escape
      }
    }

    const rows: string[][] = [];
    for (; i < text.length; i++) {
      const c = text[i];

      if (this.inQuotes) {
        if (c === '"') {
          if (i + 1 < text.length) {
            if (text[i + 1] === '"') { this.field += '"'; i++; } else { this.inQuotes = false; }
          } else {
            this.pendingQuoteInField = true; // ambiguous -- resolved at the start of the next feed()/by flush()
          }
        } else {
          this.field += c;
        }
        continue;
      }

      if (c === '"') {
        this.inQuotes = true;
      } else if (c === this.delimiter) {
        this.row.push(this.field);
        this.field = "";
      } else if (c === "\n") {
        this.row.push(this.field);
        this.field = "";
        rows.push(this.row);
        this.row = [];
      } else if (c === "\r") {
        if (i + 1 < text.length) {
          if (text[i + 1] === "\n") { i++; }
        } else {
          this.pendingCr = true; // ambiguous -- resolved at the start of the next feed()
        }
        this.row.push(this.field);
        this.field = "";
        rows.push(this.row);
        this.row = [];
      } else {
        this.field += c;
      }
    }
    return rows;
  }

  /** Call once after the final feed() to flush a trailing field/row not terminated by a line break. */
  flush(): string[][] {
    if (this.pendingQuoteInField) {
      // No more input can arrive to make this a doubled-quote escape -- it was a real close.
      this.inQuotes = false;
      this.pendingQuoteInField = false;
    }
    if (this.field.length === 0 && this.row.length === 0) {
      return [];
    }
    this.row.push(this.field);
    const rows = [this.row];
    this.row = [];
    this.field = "";
    return rows;
  }
}

/**
 * RFC 4180-ish delimited-text parser: quoted fields may contain the delimiter, newlines, and
 * doubled ("") quotes as an escaped literal quote. Handles \n and \r\n line endings.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const parser = new DelimitedRowStreamParser(delimiter);
  const rows = [...parser.feed(text), ...parser.flush()];

  // Drop trailing fully-blank lines (common at end-of-file).
  while (rows.length > 0 && rows[rows.length - 1].every(cell => cell === "")) {
    rows.pop();
  }
  return rows;
}

/**
 * Streams delimiter-parsed rows from a Node Readable (e.g. fs.createReadStream()) without ever
 * holding the whole file in memory — the large-file counterpart to parseCsv() above, used for the
 * Flat File Import Wizard's actual bulk-insert pass once a file has more rows than fit in a bounded
 * preview sample. The first yielded row is the header row, exactly like parseCsv()'s headers/rows
 * split — a caller that only wants the header can destroy the stream right after the first yield
 * instead of reading the rest of a huge file.
 *
 * A genuinely blank physical line (no delimiter characters at all — e.g. an extra trailing newline
 * some exporters add) parses to a single empty-string cell and is silently skipped, rather than
 * inserted as a spurious all-NULL row — the same practical outcome parseDelimited()'s whole-file
 * "drop trailing blank lines" pass gives for the common case, without needing to buffer a row's
 * worth of lookahead to tell "trailing" from "not trailing" in a live stream (an already-yielded
 * row can't be un-yielded once the caller has started inserting it). The one disclosed, narrow
 * difference from parseDelimited(): a legitimately blank value in the *middle* of a genuinely
 * single-column file is indistinguishable from a blank line and is skipped too, rather than
 * inserted as one all-NULL row — a narrow edge case, and not silent corruption of any value that's
 * actually present in the file.
 */
export async function* streamDelimitedRows(stream: NodeJS.ReadableStream, delimiter: string): AsyncGenerator<string[]> {
  const parser = new DelimitedRowStreamParser(delimiter);
  stream.setEncoding("utf8");
  for await (const chunk of stream as AsyncIterable<string>) {
    for (const row of parser.feed(chunk)) {
      if (!(row.length === 1 && row[0] === "")) { yield row; }
    }
  }
  for (const row of parser.flush()) {
    if (!(row.length === 1 && row[0] === "")) { yield row; }
  }
}

// ── File-reading helpers for the large-file streaming path ──────────────────────
//
// Real (impure) I/O, but still vscode-free — see this file's module doc comment for why these
// live here rather than in the wizard module.

/** Reads just enough of a delimited file's start to sniff its delimiter, without loading the whole thing — a real-world header line is virtually always well under this. */
export async function detectDelimiterFromFile(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.toString("utf8", 0, bytesRead);
    const firstLine = text.split(/\r\n|\r|\n/, 1)[0] || "";
    return detectDelimiter(firstLine);
  } finally {
    await handle.close();
  }
}

/**
 * Streams a delimited file's header plus up to `sampleSize` data rows, then stops reading —
 * `truncated` tells the caller whether there's more data beyond what's returned (the stream was
 * still going when the cap was hit) or the file was actually fully read (fewer rows than the cap).
 */
export async function readDelimitedPreview(
  filePath: string, delimiter: string, sampleSize: number
): Promise<{ headers: string[]; rows: string[][]; truncated: boolean }> {
  const stream = createReadStream(filePath);
  const headers: string[] = [];
  const rows: string[][] = [];
  let truncated = false;
  try {
    let isHeader = true;
    for await (const row of streamDelimitedRows(stream, delimiter)) {
      if (isHeader) {
        headers.push(...row);
        isHeader = false;
        continue;
      }
      if (rows.length >= sampleSize) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
  } finally {
    stream.destroy();
  }
  return { headers, rows, truncated };
}

/** The data-row counterpart to readDelimitedPreview() above, for the actual import pass — walks every data row in the file (skipping the header) without ever materializing the full set at once. */
export async function* streamDataRows(filePath: string, delimiter: string): AsyncGenerator<string[]> {
  const stream = createReadStream(filePath);
  try {
    let isHeader = true;
    for await (const row of streamDelimitedRows(stream, delimiter)) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      yield row;
    }
  } finally {
    stream.destroy();
  }
}

/** Parses CSV/TSV text into headers + data rows, assuming the first row is a header. */
export function parseCsv(text: string, delimiter?: string): ParsedTable {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] || "";
  const resolvedDelimiter = delimiter ?? detectDelimiter(firstLine);
  const allRows = parseDelimited(text, resolvedDelimiter);
  if (allRows.length === 0) {
    return { headers: [], rows: [] };
  }
  return { headers: allRows[0], rows: allRows.slice(1) };
}

// ── JSON (array of objects) parsing ──────────────────────────────────────────

function jsonCellToString(value: any): string {
  if (value === null || value === undefined) { return ""; }
  if (typeof value === "object") { return JSON.stringify(value); }
  return String(value);
}

/** Parses a JSON array-of-objects payload. Column headers are taken from the first object's keys — a uniform shape is assumed, matching a typical flat-file export. */
export function parseJsonRows(text: string): ParsedTable {
  const data = JSON.parse(text);
  if (!Array.isArray(data) || data.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = Object.keys(data[0]);
  const rows = data.map(record => headers.map(h => jsonCellToString(record?.[h])));
  return { headers, rows };
}

/** Dispatches to the right parser based on the file's extension (see detectFormat()). */
export function parseFlatFile(fileName: string, text: string): ParsedTable {
  const format = detectFormat(fileName);
  if (format === "json") { return parseJsonRows(text); }
  if (format === "tsv") { return parseCsv(text, "\t"); }
  return parseCsv(text);
}

// ── Column type sniffing ─────────────────────────────────────────────────────

const INTEGER_RE = /^[+-]?\d+$/;
const DECIMAL_RE = /^[+-]?\d+\.\d+$/;
const BOOLEAN_RE = /^(true|false)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Infers a Firebird column type from a column's non-empty sample values. Defaults to VARCHAR(255) when there is no data to sniff. */
export function inferColumnType(values: string[]): string {
  const samples = values.filter(v => v !== "");
  if (samples.length === 0) {
    return "VARCHAR(255)";
  }

  if (samples.every(v => INTEGER_RE.test(v))) {
    const allFitInt32 = samples.every(v => {
      const n = Number(v);
      return n >= INT32_MIN && n <= INT32_MAX;
    });
    return allFitInt32 ? "INTEGER" : "BIGINT";
  }

  if (samples.every(v => DECIMAL_RE.test(v))) {
    let maxIntDigits = 1;
    let maxScale = 1;
    samples.forEach(v => {
      const [intPart, fracPart] = v.replace(/^[+-]/, "").split(".");
      maxIntDigits = Math.max(maxIntDigits, intPart.length);
      maxScale = Math.max(maxScale, fracPart.length);
    });
    // NUMERIC(precision, scale); Firebird's practical max precision here is 18 (BIGINT-backed).
    const precision = Math.min(18, maxIntDigits + maxScale);
    const scale = Math.min(maxScale, precision);
    return `NUMERIC(${precision},${scale})`;
  }

  if (samples.every(v => BOOLEAN_RE.test(v))) {
    return "BOOLEAN";
  }

  if (samples.every(v => DATE_RE.test(v))) {
    return "DATE";
  }

  if (samples.every(v => TIMESTAMP_RE.test(v))) {
    return "TIMESTAMP";
  }

  const maxLen = Math.max(...samples.map(v => v.length));
  const length = Math.min(8000, Math.max(10, Math.ceil(maxLen * 1.2)));
  return `VARCHAR(${length})`;
}

/** Uppercases, strips characters Firebird can't have in an unquoted identifier, and truncates to MAX_IDENTIFIER_LENGTH. */
export function sanitizeIdentifier(name: string, fallback = "COLUMN"): string {
  let id = name.toUpperCase().replace(/[^A-Z0-9_$]/g, "_");
  if (id === "" || /^[0-9]/.test(id)) {
    id = `COL_${id}`;
  }
  id = id.slice(0, MAX_IDENTIFIER_LENGTH);
  return id || fallback;
}

/** Infers a column definition (sanitized name, sniffed type, nullability) per header/column. */
export function inferSchema(headers: string[], rows: string[][], sampleSize = 200): ColumnInference[] {
  const sample = rows.slice(0, sampleSize);
  const usedNames = new Set<string>();

  return headers.map((header, colIndex) => {
    const values = sample.map(row => row[colIndex] ?? "");
    let name = sanitizeIdentifier(header || `COLUMN_${colIndex + 1}`);
    // Disambiguate collisions from sanitization (e.g. two headers that both strip down to "ID").
    let suffix = 2;
    const base = name;
    while (usedNames.has(name)) {
      name = `${base.slice(0, MAX_IDENTIFIER_LENGTH - String(suffix).length - 1)}_${suffix}`;
      suffix++;
    }
    usedNames.add(name);

    return {
      name,
      sqlType: inferColumnType(values),
      nullable: values.some(v => v === ""),
    };
  });
}

// ── DDL generation ───────────────────────────────────────────────────────────

/** Builds a CREATE TABLE statement from inferred columns, for the user to review before running. */
export function buildCreateTableDDL(tableName: string, columns: ColumnInference[]): string {
  const columnLines = columns.map(col => `  ${col.name} ${col.sqlType}${col.nullable ? "" : " NOT NULL"}`);
  return `CREATE TABLE ${tableName} (\n${columnLines.join(",\n")}\n);`;
}

// ── INSERT generation ─────────────────────────────────────────────────────────

/**
 * Converts one raw string cell to a SQL literal for its column's inferred type: numeric/boolean
 * columns get an unquoted literal (via Firebird.escape() on an actual JS number/boolean, so it
 * follows the same quoting rules the rest of the extension already relies on), everything else
 * (VARCHAR/DATE/TIMESTAMP, or a value that doesn't actually match its column's type — e.g. a row
 * beyond inferSchema()'s sample) gets a quoted, escaped string literal for Firebird to implicitly
 * CAST, or to surface as a clear per-statement conversion error from Driver.runBatch().
 */
export function cellToSqlLiteral(rawValue: string, sqlType: string): string {
  if (rawValue === "") {
    return "NULL";
  }
  if (sqlType === "INTEGER" || sqlType === "BIGINT" || sqlType === "DOUBLE PRECISION" || sqlType.startsWith("NUMERIC")) {
    const n = Number(rawValue);
    if (Number.isFinite(n)) {
      return Firebird.escape(n);
    }
  } else if (sqlType === "BOOLEAN") {
    if (/^true$/i.test(rawValue)) { return Firebird.escape(true); }
    if (/^false$/i.test(rawValue)) { return Firebird.escape(false); }
  }
  return Firebird.escape(rawValue);
}

/** Builds one parameterless INSERT statement for a single row — Firebird has no multi-row VALUES list. */
export function buildInsertStatement(tableName: string, columns: ColumnInference[], row: string[]): string {
  const columnNames = columns.map(c => c.name).join(", ");
  const values = columns.map((c, i) => cellToSqlLiteral(row[i] ?? "", c.sqlType)).join(", ");
  return `INSERT INTO ${tableName} (${columnNames}) VALUES (${values});`;
}

// ── "Map onto an existing table" mode (phase 3) ──────────────────────────────
//
// Reuses cellToSqlLiteral() above unchanged — the only difference from "create a new table" mode
// is where the sqlType per column comes from: an existing table's actual RDB$FIELD_TYPE (via
// mapFirebirdFieldToSqlType(), fed by tableInfoQuery()'s row shape) instead of inferColumnType()'s
// sniff of the file's own sample values.

/** The subset of tableInfoQuery()'s (src/shared/queries.ts) row shape mapFirebirdFieldToSqlType() needs. */
export interface FirebirdColumnMeta {
  FIELD_NAME: string;
  FIELD_TYPE: string;
  FIELD_SUB_TYPE: number | null;
  FIELD_PRECISION: number | null;
  FIELD_SCALE: number | null;
}

/**
 * Converts one existing table column's metadata (as tableInfoQuery() returns it) into the same
 * sqlType vocabulary inferColumnType()/cellToSqlLiteral() already use, so buildInsertStatementForMapping()
 * below can reuse cellToSqlLiteral() verbatim. Firebird stores NUMERIC/DECIMAL as an INTEGER/INT64/
 * SMALLINT column with FIELD_SUB_TYPE 1 or 2 and a negative FIELD_SCALE (e.g. -2 for 2 decimal
 * places) rather than as its own distinct storage type, so that combination is checked first.
 *
 * FIELD_TYPE arrives space-padded: tableInfoQuery()'s CASE has string-literal branches of
 * different lengths ('BLOB' vs 'TIMESTAMP', etc.), which Firebird types as a single fixed-width
 * CHAR sized to the longest branch, blank-padding every shorter result to match — confirmed
 * against a real server (every branch but the single longest one came back padded, so only that
 * one branch matched an un-trimmed switch/case here). node-field.ts's tree display already trims
 * this same column for the same reason; do the same before switching on it.
 */
export function mapFirebirdFieldToSqlType(field: FirebirdColumnMeta): string {
  const isExactNumeric = (field.FIELD_SUB_TYPE === 1 || field.FIELD_SUB_TYPE === 2) && (field.FIELD_SCALE ?? 0) < 0;

  switch (field.FIELD_TYPE.trim()) {
    case "SMALLINT":
    case "INTEGER":
      return isExactNumeric ? `NUMERIC(${field.FIELD_PRECISION ?? 9},${-(field.FIELD_SCALE ?? 0)})` : "INTEGER";
    case "INT64":
      return isExactNumeric ? `NUMERIC(${field.FIELD_PRECISION ?? 18},${-(field.FIELD_SCALE ?? 0)})` : "BIGINT";
    case "DOUBLE":
    case "FLOAT":
    case "D_FLOAT":
      return "DOUBLE PRECISION";
    case "BOOLEAN":
      return "BOOLEAN";
    case "DATE":
      return "DATE";
    case "TIMESTAMP":
      return "TIMESTAMP";
    default:
      // TIME, CHAR, VARCHAR, CSTRING, BLOB, QUAD, UNKNOWN — all safe as a quoted string literal for
      // Firebird to implicitly CAST/accept, or to surface a clear per-row conversion error.
      return "VARCHAR";
  }
}

export interface ColumnMapping {
  /** The existing table's column name, exactly as tableInfoQuery() returned it. */
  targetColumn: string;
  /** This target column's actual type, from mapFirebirdFieldToSqlType() — not the file's inferred type. */
  sqlType: string;
  /** Index into a parsed row's cells, or null when this target column isn't mapped to any file column (left out of the generated INSERT, so the table's own default/nullability rules apply). */
  sourceIndex: number | null;
}

/**
 * Proposes a mapping by matching each existing column's name against the file's headers
 * (case-insensitive, after the same sanitizeIdentifier() normalization column names already go
 * through) — the common case where a CSV's headers already match the target table's column names.
 * Each header can satisfy at most one target column. Callers (the wizard) show this as an editable
 * default rather than applying it silently, since a name collision after sanitization (e.g. two
 * headers that both become "ID") could still match the wrong one.
 */
export function autoMapColumns(headers: string[], targetColumns: FirebirdColumnMeta[]): ColumnMapping[] {
  const sanitizedHeaders = headers.map(h => sanitizeIdentifier(h));
  const usedHeaderIndexes = new Set<number>();

  return targetColumns.map(col => {
    const targetName = col.FIELD_NAME.trim().toUpperCase();
    const matchIndex = sanitizedHeaders.findIndex((h, i) => h === targetName && !usedHeaderIndexes.has(i));
    if (matchIndex !== -1) {
      usedHeaderIndexes.add(matchIndex);
    }
    return {
      targetColumn: col.FIELD_NAME.trim(),
      sqlType: mapFirebirdFieldToSqlType(col),
      sourceIndex: matchIndex === -1 ? null : matchIndex,
    };
  });
}

/** Builds one INSERT statement for a single row from an explicit column mapping — unlike buildInsertStatement(), an unmapped target column (sourceIndex: null) is left out of the statement entirely rather than forced to NULL, so the table's own default/nullability rules apply. */
export function buildInsertStatementForMapping(tableName: string, mapping: ColumnMapping[], row: string[]): string {
  const mapped = mapping.filter((m): m is ColumnMapping & { sourceIndex: number } => m.sourceIndex !== null);
  const columnNames = mapped.map(m => m.targetColumn).join(", ");
  const values = mapped.map(m => cellToSqlLiteral(row[m.sourceIndex] ?? "", m.sqlType)).join(", ");
  return `INSERT INTO ${tableName} (${columnNames}) VALUES (${values});`;
}
