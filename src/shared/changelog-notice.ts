/**
 * Pure text extraction for the "What's New" notification shown after an
 * extension update. No vscode dependency, so it's unit-testable like
 * sql-formatter.ts/sql-linter.ts — extension.ts owns reading CHANGELOG.md
 * from disk and deciding whether to show anything.
 */

/** Returns the markdown body between a `## <version> - <date>` heading and the next `## ` heading, or undefined if that version isn't present. */
export function extractChangelogEntry(changelog: string, version: string): string | undefined {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s+${escapedVersion}\\b.*$`, "m");
  const match = heading.exec(changelog);
  if (!match) { return undefined; }

  const rest = changelog.slice(match.index + match[0].length);
  const nextHeading = /^##\s+/m.exec(rest);
  const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return body.trim();
}

/** Flattens a changelog entry's bullet points into a single-line, markdown-free summary for a plain-text notification. */
export function summarizeChangelogEntry(entry: string, maxLength = 220): string {
  const bullets = entry
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- "))
    .map(line => line.slice(2).replace(/\*\*/g, ""));

  const joined = bullets.join(" · ");
  if (joined.length <= maxLength) { return joined; }
  return joined.slice(0, maxLength - 1).trimEnd() + "…";
}
