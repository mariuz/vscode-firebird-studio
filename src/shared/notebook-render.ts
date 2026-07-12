/**
 * Pure cell-output rendering for SQL Notebooks (Phase 1: plain markdown, no vscode dependency —
 * see docs/roadmap/sql-notebooks.md). A GitHub-flavored markdown table renders natively in VS
 * Code's built-in notebook output view (mime type "text/markdown"), so this needs no custom
 * notebook renderer yet; that's Phase 2's "swap in the custom renderer" step.
 */

function escapeMarkdownCell(value: any): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Converts a query's result rows into a markdown table, truncated to maxRows for very large result sets. */
export function renderRowsAsMarkdown(rows: any[], maxRows = 500): string {
  if (!rows || rows.length === 0) {
    return "_0 rows returned._";
  }

  const headers = Object.keys(rows[0]);
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.slice(0, maxRows).map(row => `| ${headers.map(h => escapeMarkdownCell(row[h])).join(" | ")} |`);
  const truncationNote = rows.length > maxRows
    ? `\n\n_...${rows.length - maxRows} more row(s) not shown._`
    : "";

  return [headerLine, separatorLine, ...bodyLines].join("\n") + truncationNote;
}

/**
 * Same rendering as renderRowsAsMarkdown(), but for data that's already shaped as a header list +
 * array-of-string-arrays rather than an array of field->value objects — the shape the results
 * webview already has in hand (src/result-view/htmlContent/js/app.js's tableHeader/tableBody),
 * used by the "AI analysis of query results" action so it doesn't need a second round trip to the
 * database to re-fetch what's already rendered on screen.
 */
export function renderTableAsMarkdown(headers: string[], rows: string[][], maxRows = 50): string {
  if (!rows || rows.length === 0) {
    return "_0 rows returned._";
  }

  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.slice(0, maxRows).map(row => `| ${row.map(escapeMarkdownCell).join(" | ")} |`);
  const truncationNote = rows.length > maxRows
    ? `\n\n_...${rows.length - maxRows} more row(s) not shown._`
    : "";

  return [headerLine, separatorLine, ...bodyLines].join("\n") + truncationNote;
}
