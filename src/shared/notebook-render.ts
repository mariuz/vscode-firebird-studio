/**
 * Pure cell-output rendering for SQL Notebooks (Phase 1: plain markdown, no vscode dependency —
 * see docs/roadmap/sql-notebooks.md). A GitHub-flavored markdown table renders natively in VS
 * Code's built-in notebook output view (mime type "text/markdown"), so this needs no custom
 * notebook renderer yet; that's Phase 2's "swap in the custom renderer" step.
 */

/** Converts a query's result rows into a markdown table, truncated to maxRows for very large result sets. */
export function renderRowsAsMarkdown(rows: any[], maxRows = 500): string {
  if (!rows || rows.length === 0) {
    return "_0 rows returned._";
  }

  const headers = Object.keys(rows[0]);
  const escapeCell = (value: any): string => {
    if (value === null || value === undefined) {
      return "";
    }
    return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  };

  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.slice(0, maxRows).map(row => `| ${headers.map(h => escapeCell(row[h])).join(" | ")} |`);
  const truncationNote = rows.length > maxRows
    ? `\n\n_...${rows.length - maxRows} more row(s) not shown._`
    : "";

  return [headerLine, separatorLine, ...bodyLines].join("\n") + truncationNote;
}
