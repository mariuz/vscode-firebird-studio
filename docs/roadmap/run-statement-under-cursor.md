# Run Statement Under Cursor

**Inspired by**: [vscode-pgsql](https://github.com/microsoft/vscode-pgsql) (1.9.0) — "Keybinding for 'Run Current Statement' in the Query Editor (default: `Ctrl+Shift+Enter`) executes the statement under the cursor without requiring a selection."

## Current state in Firebird Studio

**Not started.** `Driver.runQuery()` (`src/shared/driver.ts`) only ever has two modes when no explicit `sql` is passed: the *entire* active document's text (no selection), or the *exact* current selection — confirmed directly in its source (`selection.isEmpty ? activeTextEditor.document.getText() : activeTextEditor.document.getText(selection)`). There's no third mode that finds and runs just the one statement the cursor happens to be positioned inside, out of a multi-statement file, without the user manually selecting it first. `src/shared/sql-splitter.ts`'s `splitStatements(sql): string[]` already does the hard part of correctly finding statement boundaries (string literals, comments, `SET TERM`-delimited procedure/trigger bodies) for `Driver.runBatch()` — but it returns plain strings, not the source offsets a cursor-position lookup would need to match against.

## Proposed feature

- Extend (or add a sibling to) `splitStatements()` returning each statement's start/end offset in the original source alongside its text — reusing its existing boundary-detection logic (the genuinely hard part: quoted strings, comments, `SET TERM`) rather than re-implementing statement-splitting a second time just to get positions.
- A new `firebird.runCurrentStatement` command: finds the statement whose `[start, end)` range contains the cursor's document offset, and runs just that one statement through the existing `Driver.runQuery(sql, ...)` path — no changes needed to execution itself, only to *what SQL text gets selected* before the existing call.
- Default keybinding, matching pgsql's own choice for muscle-memory-consistency with a Postgres background: `ctrl+shift+enter` (`cmd+shift+enter` on macOS) — needs to be scoped to `editorTextFocus && resourceLangId == sql` in `package.json`'s `contributes.keybindings` so it doesn't shadow an unrelated global keybinding elsewhere.
- Cursor between statements (in whitespace, or a comment before/after any statement) — fall back to the existing "no selection → whole document" behavior rather than erroring, since the ambiguity has an obvious existing answer already.

## Suggested phases

1. Offset-tracking variant of `splitStatements()` (or a new `splitStatementsWithOffsets()`), unit-testable in isolation the same way `sql-splitter.test.ts` already tests the existing function — the genuinely new logic here, everything else below is just wiring.
2. `firebird.runCurrentStatement` command finding the statement at the cursor and running it through the existing `Driver.runQuery()` path.
3. Default keybinding in `contributes.keybindings`, scoped to SQL editors only.
