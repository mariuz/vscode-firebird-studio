import { firebirdReserved } from "../language-server/firebird-reserved";

/**
 * Drag Object Explorer Entity into Editor (docs/roadmap/drag-identifier-into-editor.md), phase 2
 * — Firebird's own identifier-quoting rules: an unquoted identifier is folded to uppercase and may
 * only contain `[A-Z0-9_$]`, starting with a letter. A real object name that already matches that
 * shape *and* isn't a reserved word can be referenced unquoted exactly as stored; anything else
 * (mixed/lower case, other characters, a name colliding with a reserved word) needs `"..."`
 * double-quoting to be referenced correctly, with any literal `"` in the name doubled per standard
 * SQL identifier-quoting escaping (mirrors how sql-splitter.ts handles `''` inside string
 * literals). Deliberately a separate function from sanitizeIdentifier() (flat-file-parser.ts):
 * that one *mutates* an arbitrary CSV header into a new valid identifier (replacing bad characters
 * with `_`); this one must preserve a real, already-existing object name exactly and only decide
 * whether it needs quoting to be referenced correctly.
 */
const UNQUOTED_IDENTIFIER = /^[A-Z][A-Z0-9_$]*$/;

const RESERVED_WORDS = new Set(firebirdReserved.map(w => w.label.toUpperCase()));

export function quoteIdentifierIfNeeded(name: string): string {
  if (UNQUOTED_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name)) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}
