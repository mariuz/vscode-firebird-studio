/**
 * Splits a SQL document into individual statements for batch execution.
 *
 * Handles:
 *  - single-quoted string literals (including escaped quotes '')
 *  - line comments (--)
 *  - block comments (slash-star ... star-slash)
 *  - the semicolon statement terminator
 *  - `SET TERM <token> ;` — Firebird isql's terminator-switch directive. The
 *    extension's own snippets (CREATE PROCEDURE/TRIGGER, etc.) wrap PSQL
 *    bodies in `SET TERM ^ ; ... END^ SET TERM ; ^` so that the semicolons
 *    inside the body aren't treated as statement boundaries. SET TERM lines
 *    are consumed to switch the active terminator and are never themselves
 *    emitted as statements (they aren't valid DSQL, only an isql directive).
 *  - PSQL blocks that *don't* use SET TERM: BEGIN...END and CASE...END are
 *    tracked as a nesting depth so a bare `CREATE PROCEDURE ... AS BEGIN
 *    ...; ...; END;` (no SET TERM) is still treated as one statement. A
 *    CREATE/ALTER PROCEDURE/TRIGGER/FUNCTION/PACKAGE BODY or EXECUTE BLOCK
 *    header additionally suppresses splitting until its first BEGIN, so a
 *    `DECLARE VARIABLE ...;` declaration section ahead of BEGIN isn't cut
 *    off (this only matters for the no-SET-TERM fallback; SET TERM already
 *    protects the whole statement regardless of what's in it).
 *
 * Empty / whitespace-only statements are filtered out.
 */
const PSQL_HEADER = /^(CREATE\s+(OR\s+ALTER\s+)?|ALTER\s+|RECREATE\s+)(PROCEDURE|TRIGGER|FUNCTION|PACKAGE\s+BODY)\b|^EXECUTE\s+BLOCK\b/i;

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let terminator = ";";
  let blockDepth = 0;
  let awaitingFirstBegin = false;
  let i = 0;
  const len = sql.length;

  const isWordChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_$]/.test(ch);

  /** True if `word` (already uppercase) occurs at `pos` as a whole word, case-insensitively. */
  const matchWord = (pos: number, word: string): boolean => {
    if (sql.slice(pos, pos + word.length).toUpperCase() !== word) {
      return false;
    }
    return !isWordChar(sql[pos - 1]) && !isWordChar(sql[pos + word.length]);
  };

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) {
      statements.push(trimmed);
    }
    current = "";
    awaitingFirstBegin = false;
  };

  while (i < len) {
    const ch = sql[i];

    // Block comment
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        current += sql.slice(i);
        break;
      }
      current += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      if (end === -1) {
        current += sql.slice(i);
        break;
      }
      current += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Single-quoted string (including '' escaped quotes)
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2; // escaped quote
        } else if (sql[j] === "'") {
          j++;
          break;
        } else {
          j++;
        }
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    // SET TERM <token> <currentTerminator> — only recognised at a statement boundary
    if (blockDepth === 0 && current.trim() === "" && matchWord(i, "SET")) {
      const m = /^SET\s+TERM\s+(\S+)\s*/i.exec(sql.slice(i));
      if (m) {
        const newTerminator = m[1];
        const afterDirective = i + m[0].length;
        if (sql.slice(afterDirective, afterDirective + terminator.length) === terminator) {
          terminator = newTerminator;
          i = afterDirective + terminator.length;
          current = ""; // SET TERM is an isql directive, not a statement to execute
          continue;
        }
      }
    }

    // CREATE/ALTER/RECREATE PROCEDURE|TRIGGER|FUNCTION|PACKAGE BODY or EXECUTE
    // BLOCK: suppress splitting until the first BEGIN, so a declaration
    // section between AS and BEGIN isn't cut off when SET TERM isn't used.
    if (blockDepth === 0 && !awaitingFirstBegin && current.trim() === "" && PSQL_HEADER.test(sql.slice(i))) {
      awaitingFirstBegin = true;
    }

    // PSQL block tracking: BEGIN...END and CASE...END both close on the next
    // unmatched END, so a single depth counter covers both without conflating
    // a CASE expression's END with the enclosing block's END.
    if (matchWord(i, "BEGIN")) {
      blockDepth++;
      awaitingFirstBegin = false;
      current += sql.slice(i, i + 5);
      i += 5;
      continue;
    }
    if (matchWord(i, "CASE")) {
      blockDepth++;
      current += sql.slice(i, i + 4);
      i += 4;
      continue;
    }
    if (matchWord(i, "END")) {
      if (blockDepth > 0) {
        blockDepth--;
      }
      current += sql.slice(i, i + 3);
      i += 3;
      continue;
    }

    // Statement terminator (only ends a statement outside any BEGIN/CASE
    // block, and not while still waiting for a PSQL header's first BEGIN)
    if (blockDepth === 0 && !awaitingFirstBegin && sql.slice(i, i + terminator.length) === terminator) {
      flush();
      i += terminator.length;
      continue;
    }

    current += ch;
    i++;
  }

  flush();

  return statements;
}
