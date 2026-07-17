/**
 * Extension Development Host integration test for SQL Notebooks' phase 3 connection-binding
 * persistence (docs/roadmap/sql-notebooks.md): the connection a notebook is bound to is now
 * written into the .fbnb file's own metadata (FirebirdNotebookSerializer round-trips it, and
 * resolveNotebookConnection() checks it before ever prompting), so reopening a notebook (or a
 * VS Code restart) doesn't re-prompt for a connection the way it used to.
 *
 * Uses the real (unmocked) vscode Notebook API the Extension Development Host provides —
 * NotebookController/NotebookSerializer/NotebookCellExecution aren't mocked in
 * src/test/mocks/vscode.ts (see that roadmap doc's "Explicitly deferred" note), so this is the
 * only tier where this is meaningfully testable. Deliberately never drives window.showQuickPick
 * (it has no real UI to answer here and would hang the test) — every scenario below either
 * already has a persisted connectionId or has zero saved connections, both of which return before
 * the picker would ever open.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { FirebirdNotebookSerializer } from '../../sql-notebook/serializer';
import { FIREBIRD_NOTEBOOK_TYPE, resolveNotebookConnection } from '../../sql-notebook/controller';
import { Constants } from '../../config';
import { getTestConnectionOptions } from './firebird-test-env';

const CancellationToken = new vscode.CancellationTokenSource().token;
const EXTENSION_ID = 'AdrianMariusPopa.vscode-firebird-studio';

suite('SQL Notebooks – connection-binding persistence (extension host)', function () {
  this.timeout(10000);

  suiteSetup(async function () {
    // Registering FIREBIRD_NOTEBOOK_TYPE happens in activate() — make sure it's actually run
    // before openNotebookDocument() below relies on that contributed type existing.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (extension && !extension.isActive) {
      await extension.activate();
    }
  });

  suite('FirebirdNotebookSerializer', function () {
    const serializer = new FirebirdNotebookSerializer();

    test('round-trips a persisted connectionId through serialize -> deserialize', function () {
      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 1 FROM RDB$DATABASE', 'sql');
      const data = new vscode.NotebookData([cell]);
      data.metadata = { connectionId: 'my-saved-connection-id' };

      const bytes = serializer.serializeNotebook(data, CancellationToken);
      const onDisk = JSON.parse(Buffer.from(bytes).toString('utf8'));
      assert.strictEqual(onDisk.metadata?.connectionId, 'my-saved-connection-id', 'connectionId should be written to the on-disk JSON');

      const roundTripped = serializer.deserializeNotebook(bytes, CancellationToken);
      assert.strictEqual(roundTripped.metadata?.connectionId, 'my-saved-connection-id', 'connectionId should survive a full serialize/deserialize round trip');
    });

    test('a notebook with no bound connection serializes without a metadata.connectionId key', function () {
      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 1 FROM RDB$DATABASE', 'sql');
      const data = new vscode.NotebookData([cell]);

      const bytes = serializer.serializeNotebook(data, CancellationToken);
      const onDisk = JSON.parse(Buffer.from(bytes).toString('utf8'));
      assert.strictEqual(onDisk.metadata, undefined, 'no metadata.connectionId should mean no metadata key at all in the file');
    });

    test('an empty/new notebook still opens with one blank SQL cell (unaffected by the metadata change)', function () {
      const data = serializer.deserializeNotebook(new Uint8Array(), CancellationToken);
      assert.strictEqual(data.cells.length, 1);
      assert.strictEqual(data.cells[0].languageId, 'sql');
      assert.strictEqual(data.cells[0].value, '');
    });
  });

  suite('resolveNotebookConnection()', function () {
    test('uses the persisted connectionId without prompting, when that connection still exists', async function () {
      const connectionOptions = { ...getTestConnectionOptions(), password: 'seeded-password' };
      const store = new Map<string, unknown>();
      store.set(Constants.ConectionsKey, { [connectionOptions.id]: connectionOptions });
      const fakeContext = {
        globalState: { get: (key: string, dflt?: unknown) => store.has(key) ? store.get(key) : dflt },
      } as unknown as vscode.ExtensionContext;

      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'sql');
      const initialData = new vscode.NotebookData([cell]);
      initialData.metadata = { connectionId: connectionOptions.id };
      const notebook = await vscode.workspace.openNotebookDocument(FIREBIRD_NOTEBOOK_TYPE, initialData);

      const resolved = await resolveNotebookConnection(notebook, fakeContext);
      assert.ok(resolved, 'expected a resolved connection from the persisted id, no prompt needed');
      assert.strictEqual(resolved!.id, connectionOptions.id);
      assert.strictEqual(resolved!.password, 'seeded-password');
    });

    test('returns undefined without prompting when there is no persisted id and no saved connections at all', async function () {
      const fakeContext = {
        globalState: { get: (_key: string, dflt?: unknown) => dflt },
      } as unknown as vscode.ExtensionContext;

      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'sql');
      const notebook = await vscode.workspace.openNotebookDocument(FIREBIRD_NOTEBOOK_TYPE, new vscode.NotebookData([cell]));

      const resolved = await resolveNotebookConnection(notebook, fakeContext);
      assert.strictEqual(resolved, undefined);
    });

    test('falls through past a stale persisted id (connection since removed) to "no connections" rather than reusing a nonexistent one', async function () {
      const fakeContext = {
        globalState: { get: (_key: string, dflt?: unknown) => dflt },
      } as unknown as vscode.ExtensionContext;

      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'sql');
      const initialData = new vscode.NotebookData([cell]);
      initialData.metadata = { connectionId: 'a-connection-id-that-no-longer-exists' };
      const notebook = await vscode.workspace.openNotebookDocument(FIREBIRD_NOTEBOOK_TYPE, initialData);

      const resolved = await resolveNotebookConnection(notebook, fakeContext);
      assert.strictEqual(resolved, undefined, 'a stale id with zero saved connections should resolve to undefined, not throw or hang');
    });
  });
});
