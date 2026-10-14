import * as vscode from 'vscode';

export const SCHEMA_DIFF_SCHEME = 'firebird-schema';

/**
 * TextDocumentContentProvider that serves normalized Firebird DDL documents
 * for side-by-side visual schema comparisons using VS Code's native diff editor.
 */
export class SchemaDiffDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private static instance: SchemaDiffDocumentProvider | undefined;
  private documents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event;

  public static getInstance(): SchemaDiffDocumentProvider {
    if (!SchemaDiffDocumentProvider.instance) {
      SchemaDiffDocumentProvider.instance = new SchemaDiffDocumentProvider();
    }
    return SchemaDiffDocumentProvider.instance;
  }

  public setDocument(uri: vscode.Uri, content: string): void {
    this.documents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? '-- Content not available or expired\n';
  }

  public clear(): void {
    this.documents.clear();
  }

  public dispose(): void {
    this.documents.clear();
    this._onDidChange.dispose();
    SchemaDiffDocumentProvider.instance = undefined;
  }
}
