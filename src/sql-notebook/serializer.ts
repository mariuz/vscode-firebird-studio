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

/** Document-level metadata — currently just the bound connection id (docs/roadmap/sql-notebooks.md phase 3). */
interface FbnbMetadata {
  connectionId?: string;
}

interface FbnbFile {
  cells: FbnbCell[];
  metadata?: FbnbMetadata;
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

    const notebook = new NotebookData(cells);
    if (parsed.metadata) {
      notebook.metadata = parsed.metadata;
    }
    return notebook;
  }

  serializeNotebook(data: NotebookData, _token: CancellationToken): Uint8Array {
    const file: FbnbFile = {
      cells: data.cells.map(cell => ({
        kind: cell.kind === NotebookCellKind.Markup ? "markup" : "code",
        value: cell.value,
        languageId: cell.languageId,
      })),
    };
    // Only round-trip the one key this extension actually writes (NotebookData.metadata is an
    // untyped bag other extensions/VS Code itself could in principle also stash things in) —
    // narrow rather than dumping the whole object back out verbatim.
    const connectionId = data.metadata?.connectionId;
    if (typeof connectionId === "string") {
      file.metadata = { connectionId };
    }
    return Buffer.from(JSON.stringify(file, null, 2), "utf8");
  }
}
