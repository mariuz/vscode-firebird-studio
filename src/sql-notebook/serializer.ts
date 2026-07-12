import { CancellationToken, NotebookData, NotebookCellData, NotebookCellKind, NotebookSerializer } from "vscode";

/**
 * On-disk .fbnb format: a small custom JSON shape (not Jupyter's .ipynb nbformat — this is a
 * single-kernel, SQL-only notebook, so nbformat's cross-kernel metadata would be unused ceremony).
 */
interface FbnbCell {
  kind: "markup" | "code";
  value: string;
  languageId: string;
}

interface FbnbFile {
  cells: FbnbCell[];
}

export class FirebirdNotebookSerializer implements NotebookSerializer {
  deserializeNotebook(content: Uint8Array, _token: CancellationToken): NotebookData {
    const text = Buffer.from(content).toString("utf8").trim();
    const parsed: FbnbFile = text ? JSON.parse(text) : { cells: [] };

    const cells = (parsed.cells ?? []).map(cell => new NotebookCellData(
      cell.kind === "markup" ? NotebookCellKind.Markup : NotebookCellKind.Code,
      cell.value,
      cell.languageId || (cell.kind === "markup" ? "markdown" : "sql")
    ));

    // A brand-new/empty notebook should still open with one blank SQL cell to run.
    if (cells.length === 0) {
      cells.push(new NotebookCellData(NotebookCellKind.Code, "", "sql"));
    }

    return new NotebookData(cells);
  }

  serializeNotebook(data: NotebookData, _token: CancellationToken): Uint8Array {
    const file: FbnbFile = {
      cells: data.cells.map(cell => ({
        kind: cell.kind === NotebookCellKind.Markup ? "markup" : "code",
        value: cell.value,
        languageId: cell.languageId,
      })),
    };
    return Buffer.from(JSON.stringify(file, null, 2), "utf8");
  }
}
