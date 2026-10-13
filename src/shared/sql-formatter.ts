/**
 * Simple SQL formatter for Firebird SQL.
 * Uppercases keywords and places major clauses on new lines with indentation.
 */

/** SQL keywords that should start a new line (top-level clauses) */
const NEWLINE_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'GROUP BY', 'HAVING',
  'INNER JOIN', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
  'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN',
  'ON', 'UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'CREATE TABLE', 'CREATE VIEW', 'CREATE PROCEDURE', 'CREATE TRIGGER',
  'ALTER TABLE', 'DROP TABLE',
];

/** All SQL keywords that should be uppercased */
const ALL_KEYWORDS = [
  ...NEWLINE_KEYWORDS,
  'AS', 'IN', 'NOT IN', 'NOT', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
  'EXISTS', 'DISTINCT', 'ALL', 'ANY', 'SOME',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXECUTE', 'PROCEDURE',
  'FIRST', 'SKIP', 'ROWS', 'TO', 'WITH', 'INTO', 'OF',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'UNIQUE', 'NOT NULL', 'DEFAULT',
  'COALESCE', 'NULLIF', 'CAST', 'EXTRACT', 'TRIM', 'SUBSTRING', 'UPPER', 'LOWER',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER',
  'TABLE', 'VIEW', 'TRIGGER', 'GENERATOR', 'SEQUENCE', 'INDEX',
  'ASCENDING', 'DESCENDING', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
];

/** Sort longer phrases first to avoid partial matches (e.g. "LEFT OUTER JOIN" before "LEFT JOIN") */
const SORTED_KEYWORDS = [...new Set([...ALL_KEYWORDS])].sort((a, b) => b.length - a.length);

/** How keywords are cased. `preserve` leaves whatever the author typed alone. */
export type KeywordCase = "upper" | "lower" | "preserve";

/** Where commas are placed in multi-line column lists. */
export type CommaPlacement = "trailing" | "leading";

/** How subordinate clauses (JOIN, ON, AND, OR) are indented. */
export type ClauseIndentation = "none" | "subclauses";

export interface FormatOptions {
  /** Default `upper`, which is what this formatter has always done. */
  keywordCase?: KeywordCase;
  /**
   * One indent level, as the literal string to emit — spaces or a tab. Taken from the editor's
   * own `FormattingOptions` by the formatting provider, so a file formats to the indentation the
   * editor is already showing rather than to a second, private setting. Defaults to the four
   * spaces this formatter hardcoded before it took options at all.
   */
  indent?: string;
  /**
   * Where commas are placed in multi-line column lists.
   * - `trailing` (default): at the end of each column line (`col1,\n    col2`)
   * - `leading`: at the start of subsequent column lines (`col1\n    , col2`)
   */
  commaPlacement?: CommaPlacement;
  /**
   * How subordinate clauses (JOIN, ON, AND, OR) are indented.
   * - `none` (default): all clauses start at the margin.
   * - `subclauses`: subordinate clauses are indented under their parent clause.
   */
  clauseIndentation?: ClauseIndentation;
}

const DEFAULT_OPTIONS: Required<FormatOptions> = {
  keywordCase: "upper",
  indent: "    ",
  commaPlacement: "trailing",
  clauseIndentation: "none",
};

/** Applies the configured casing to a keyword this formatter recognises. */
function caseKeyword(keyword: string, keywordCase: KeywordCase): string {
  if (keywordCase === "lower") { return keyword.toLowerCase(); }
  if (keywordCase === "upper") { return keyword.toUpperCase(); }
  return keyword;
}

/** Splits a comma-separated list of columns, respecting parenthesis depth. */
function splitColumnList(cols: string): string[] {
  const result: string[] = [];
  let current = '';
  let parenDepth = 0;

  for (let i = 0; i < cols.length; i++) {
    const char = cols[i];
    if (char === '(') {
      parenDepth++;
      current += char;
    } else if (char === ')') {
      if (parenDepth > 0) { parenDepth--; }
      current += char;
    } else if (char === ',' && parenDepth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    result.push(current.trim());
  }
  return result;
}

/** Formats columns with either trailing or leading comma placement. */
function formatColumnList(columns: string[], indent: string, commaPlacement: CommaPlacement): string {
  if (columns.length === 0) {
    return '';
  }
  if (commaPlacement === 'leading') {
    return columns.map((col, idx) => {
      if (idx === 0) {
        return `${indent}${col}`;
      }
      return `${indent}, ${col}`;
    }).join('\n');
  }
  return columns.map((col, idx) => {
    if (idx === columns.length - 1) {
      return `${indent}${col}`;
    }
    return `${indent}${col},`;
  }).join('\n');
}

/** Computes subordinate clause indentation for NEWLINE_KEYWORDS. */
function getClauseIndent(kw: string, clauseIndentation: ClauseIndentation, indent: string): string {
  if (clauseIndentation === "none") {
    return "";
  }
  const upper = kw.toUpperCase();
  if (upper === "ON") {
    return `${indent}${indent}`;
  }
  if (upper === "AND" || upper === "OR" || upper.endsWith("JOIN")) {
    return indent;
  }
  return "";
}

/**
 * Formats a SQL string:
 * - Cases SQL keywords per `options.keywordCase`
 * - Places major clauses on new lines
 * - Indents column lists after SELECT by `options.indent` with `options.commaPlacement`
 * - Optionally indents subordinate clauses with `options.clauseIndentation`
 *
 * Called with no options it behaves exactly as it always has, which is what keeps the
 * `firebird.formatSql` command and every existing test unchanged.
 */
export function formatSQL(sql: string, options: FormatOptions = {}): string {
  const { keywordCase, indent, commaPlacement, clauseIndentation } = { ...DEFAULT_OPTIONS, ...options };
  if (!sql || !sql.trim()) {
    return sql;
  }

  // Preserve string literals and comments so we don't modify them
  const placeholders: string[] = [];
  let processed = sql;

  // Replace single-quoted string literals with placeholders
  processed = processed.replace(/'(?:[^'\\]|\\.)*'/g, match => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\x00STR${idx}\x00`;
  });

  // Replace line comments (-- ...) with placeholders
  processed = processed.replace(/--[^\n]*/g, match => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\x00CMT${idx}\x00`;
  });

  // Replace block comments (/* ... */) with placeholders
  processed = processed.replace(/\/\*[\s\S]*?\*\//g, match => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\x00BLK${idx}\x00`;
  });

  // Case all SQL keywords (case-insensitive match). `preserve` skips the pass entirely rather
  // than rewriting each keyword to what it already was.
  if (keywordCase !== "preserve") {
    for (const kw of SORTED_KEYWORDS) {
      const pattern = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'gi');
      processed = processed.replace(pattern, caseKeyword(kw, keywordCase));
    }
  }

  // Insert newlines before major clauses
  for (const kw of NEWLINE_KEYWORDS) {
    const pattern = new RegExp(`(?<![\\x00])(\\s*)\\b(${kw.replace(/\s+/g, '\\s+')})\\b`, 'gi');
    processed = processed.replace(pattern, (_match, _space, keyword) => {
      const pfx = getClauseIndent(kw, clauseIndentation, indent);
      return `\n${pfx}${caseKeyword(keyword, keywordCase)}`;
    });
  }

  // Indent SELECT column list: columns separated by commas on their own lines
  // Both keywords are captured rather than re-emitted from a literal: under `preserve` the
  // author's own spelling has to survive this rewrite too.
  processed = processed.replace(/\b(SELECT)\b([\s\S]*?)\b(FROM)\b/gi, (_match, selectKw, cols, fromKw) => {
    const trimmed = cols.trim();
    const SELECT = caseKeyword(selectKw, keywordCase);
    const FROM = caseKeyword(fromKw, keywordCase);
    if (!trimmed || trimmed === '*') {
      return `${SELECT} ${trimmed}\n${FROM}`;
    }
    const columns = splitColumnList(trimmed);
    const formattedCols = formatColumnList(columns, indent, commaPlacement);
    return `${SELECT}\n${formattedCols}\n${FROM}`;
  });

  // Clean up excessive blank lines and normalize line endings
  processed = processed
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Restore placeholders
  processed = processed.replace(/\x00(STR|CMT|BLK)(\d+)\x00/g, (_m, _type, idx) => placeholders[Number(idx)]);

  return processed;
}
