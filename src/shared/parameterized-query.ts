/**
 * Pure parsing/rewriting for named `:paramName` placeholders — the "Parameterized query
 * execution" feature. Firebird's wire protocol only understands positional `?` placeholders
 * (bound via node-firebird's/node-firebird-driver-native's own `args`/`parameters` array — see
 * Driver.runQuery()/NodeClient.queryPromise()/NativeClient.queryPromise() in driver.ts), so a
 * query written with named placeholders is rewritten to positional ones before execution, with a
 * parallel list of names recording which value goes where (in order, including repeats if the
 * same name is used more than once).
 *
 * Skips single-quoted string literals (with '' escaped quotes) and comments (-- line, block) the
 * same way sql-splitter.ts's statement splitter does, so a colon inside a string/comment (e.g. a
 * '12:30 PM' literal) is never mistaken for a placeholder.
 */

interface Placeholder {
  name: string;
  start: number;
  end: number; // exclusive
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/** Finds every `:identifier` placeholder outside string literals/comments, in source order. */
function findPlaceholders(sql: string): Placeholder[] {
  const placeholders: Placeholder[] = [];
  const len = sql.length;
  let i = 0;

  while (i < len) {
    const ch = sql[i];

    // Block comment
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }

    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    // Single-quoted string (including '' escaped quotes)
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
        } else if (sql[j] === "'") {
          j++;
          break;
        } else {
          j++;
        }
      }
      i = j;
      continue;
    }

    // A `:` immediately followed by an identifier start is a named placeholder.
    if (ch === ":" && IDENTIFIER_START.test(sql[i + 1] ?? "")) {
      let j = i + 1;
      while (j < len && IDENTIFIER_CHAR.test(sql[j])) {
        j++;
      }
      placeholders.push({ name: sql.slice(i + 1, j), start: i, end: j });
      i = j;
      continue;
    }

    i++;
  }

  return placeholders;
}

/** Distinct parameter names, in first-occurrence order — used to prompt for each value once. */
export function extractNamedParameters(sql: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of findPlaceholders(sql)) {
    if (!seen.has(p.name)) {
      seen.add(p.name);
      names.push(p.name);
    }
  }
  return names;
}

export interface RewrittenQuery {
  sql: string;
  /** One entry per `?` placeholder, in positional order — a name repeats if it was used more than once. */
  paramNames: string[];
}

/** Replaces every `:identifier` placeholder with `?`, in source order. A no-op (paramNames: []) when there are none. */
export function rewriteNamedParametersToPositional(sql: string): RewrittenQuery {
  const placeholders = findPlaceholders(sql);
  if (placeholders.length === 0) {
    return { sql, paramNames: [] };
  }

  let result = "";
  let cursor = 0;
  const paramNames: string[] = [];
  for (const p of placeholders) {
    result += sql.slice(cursor, p.start) + "?";
    paramNames.push(p.name);
    cursor = p.end;
  }
  result += sql.slice(cursor);

  return { sql: result, paramNames };
}

export type ParamType = "string" | "integer" | "float" | "date" | "boolean" | "null";

/** Converts a form value (a plain string from an input box, or undefined for NULL) into the JS value to bind. */
export function coerceParamValue(type: ParamType, raw: string | undefined): any {
  if (type === "null") {
    return null;
  }
  const value = raw ?? "";
  switch (type) {
    case "integer": {
      const n = parseInt(value, 10);
      if (isNaN(n)) { throw new Error(`"${value}" is not a valid integer.`); }
      return n;
    }
    case "float": {
      const n = parseFloat(value);
      if (isNaN(n)) { throw new Error(`"${value}" is not a valid number.`); }
      return n;
    }
    case "boolean":
      return value.trim().toLowerCase() === "true" || value.trim() === "1";
    case "date": {
      const d = new Date(value);
      if (isNaN(d.getTime())) { throw new Error(`"${value}" is not a valid date/timestamp.`); }
      return d;
    }
    case "string":
    default:
      return value;
  }
}
