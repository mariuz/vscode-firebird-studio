/**
 * Pure CSV/TSV/JSON parsing and Firebird column-type sniffing for the Flat File Import Wizard.
 * No external dependency: package.json has no CSV parser today, and one file's worth of RFC 4180
 * handling (quoted fields, embedded delimiters/newlines, doubled-quote escaping) is small enough
 * to hand-roll rather than add a dependency for, matching this repo's stated preference.
 *
 * Every parse path (CSV/TSV/JSON) normalizes to the same shape — string cells, "" for null/empty —
 * so inferSchema()/inferColumnType() only ever have to sniff strings, regardless of source format.
 */

import * as Firebird from "node-firebird";

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
 * RFC 4180-ish delimited-text parser: quoted fields may contain the delimiter, newlines, and
 * doubled ("") quotes as an escaped literal quote. Handles \n and \r\n line endings.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // strip a UTF-8 BOM, if present

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") { i++; }
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Final field/row, if the text didn't end with a line break.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing fully-blank lines (common at end-of-file).
  while (rows.length > 0 && rows[rows.length - 1].every(cell => cell === "")) {
    rows.pop();
  }
  return rows;
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
