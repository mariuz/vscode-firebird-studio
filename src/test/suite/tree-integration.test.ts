/**
 * Extension Development Host integration tests for the DB Explorer tree
 * nodes (src/nodes/*) against a real Firebird server.
 *
 * Complements driver-integration.test.ts by exercising the node hierarchy
 * (NodeDatabase -> category folders -> NodeTable -> NodeField) and the
 * table-level actions (selectAllRecords) that the tree view drives, using
 * the same seeded PRODUCTS table as src/test/e2e (see scripts/seed-test-db.js).
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { Driver, NodeClient } from '../../shared/driver';
import { NodeDatabase, NodeHost, NodeTable } from '../../nodes';
import { FirebirdTree } from '../../interfaces';
import { getTestConnectionOptions } from './firebird-test-env';

const EXTENSION_ID = 'AdrianMariusPopa.vscode-firebird-studio';

suite('Tree nodes – real Firebird integration (extension host)', function () {
  this.timeout(20000);

  let fakeContext: vscode.ExtensionContext;

  suiteSetup(function () {
    Driver.client = new NodeClient();
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension "${EXTENSION_ID}" should be installed in the test host`);
    // getTreeItem() on these node classes only reads context.extensionPath
    // (to build icon paths), so a minimal stand-in is enough here — we don't
    // need a full ExtensionContext (globalState/secrets) for these tests.
    fakeContext = { extensionPath: extension!.extensionPath } as unknown as vscode.ExtensionContext;
  });

  test('NodeHost.getChildren wraps each saved connection in a NodeDatabase', async function () {
    const host = new NodeHost('localhost', [getTestConnectionOptions()]);
    const children = await host.getChildren();
    assert.strictEqual(children.length, 1);
    assert.ok(children[0] instanceof NodeDatabase);
  });

  test('NodeDatabase.getChildren returns the six object-category folders', async function () {
    const db = new NodeDatabase(getTestConnectionOptions());
    const children = await db.getChildren();
    const labels = await Promise.all(children.map(async c => (await c.getTreeItem(fakeContext)).label));
    assert.deepStrictEqual(labels, ['Tables', 'Views', 'Stored Procedures', 'Triggers', 'Generators', 'Domains']);
  });

  test('Tables folder lists the seeded PRODUCTS table', async function () {
    const db = new NodeDatabase(getTestConnectionOptions());
    const [tablesFolder] = await db.getChildren();
    const tables = await tablesFolder.getChildren();
    const labels = await Promise.all(tables.map(async t => (await t.getTreeItem(fakeContext)).label));
    assert.ok(labels.includes('PRODUCTS'), `expected PRODUCTS in ${JSON.stringify(labels)}`);
  });

  test('NodeTable.getChildren lists PRODUCTS columns as NodeField', async function () {
    const productsTable = new NodeTable(getTestConnectionOptions(), 'PRODUCTS');
    const fields: FirebirdTree[] = await productsTable.getChildren();
    const labels = await Promise.all(fields.map(async f => (await f.getTreeItem(fakeContext)).label as string));
    assert.ok(labels.some(l => l.startsWith('ID :')), `expected an ID column in ${JSON.stringify(labels)}`);
    assert.ok(labels.some(l => l.startsWith('NAME :')));
    assert.ok(labels.some(l => l.startsWith('PRICE :')));
  });

  test('NodeTable.selectAllRecords returns the seeded rows end-to-end', async function () {
    const productsTable = new NodeTable(getTestConnectionOptions(), 'PRODUCTS');
    const rows = await productsTable.selectAllRecords();
    assert.strictEqual(rows.length, 5);
  });
});
