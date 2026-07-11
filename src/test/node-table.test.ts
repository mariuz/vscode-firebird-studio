/**
 * Regression test for "Your user name and password are not defined" when
 * expanding a table in the DB Explorer tree.
 *
 * NodeDatabase resolves the stored password (via CredentialStore) before
 * connecting to list tables, but was handing its *unresolved* dbDetails to
 * the NodeTable/NodeView/NodeProcedure children it constructs. Those classes
 * then connected directly via Driver.client.createConnection() — bypassing
 * Driver.runQuery()'s automatic password resolution — so expanding a table
 * (or view/procedure, or editing a trigger) failed with an empty password as
 * soon as the in-memory ConnectionOptions hadn't already been resolved by
 * something else. Fixed by resolving via Driver.resolvePassword() at every
 * direct-connect call site; this test reproduces the exact failure mode.
 */

import * as assert from 'assert';
import { Driver, ClientI } from '../shared/driver';
import { NodeTable } from '../nodes/node-table';
import { NodeField } from '../nodes/node-field';
import { NodeInfo } from '../nodes/node-info';
import { NodeIndexFolder } from '../nodes/node-index';
import { ConnectionOptions } from '../interfaces';
import { CredentialStore } from '../shared/credential-store';
import { createMockContext } from './mocks/vscode';

class FakeClient implements ClientI<any> {
  public connectedWith: ConnectionOptions[] = [];

  async createConnection(opts: ConnectionOptions): Promise<any> {
    this.connectedWith.push(opts);
    if (!opts.password) {
      // Mirrors node-firebird's real isc_login error when no password is present.
      throw new Error('Your user name and password are not defined. Ask your database administrator to set up a Firebird login.');
    }
    return {};
  }

  async queryPromise<T extends object>(_connection: any, _sql: string): Promise<T[]> {
    return [{ FIELD_NAME: 'ID', FIELD_TYPE: 'INTEGER', FIELD_LENGTH: 4 } as unknown as T];
  }

  async detach(_connection: any): Promise<void> {
    // no-op
  }
}

function unresolvedConnection(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    id: 'saved-conn',
    host: 'localhost',
    port: 3050,
    database: '/data/employee.fdb',
    user: 'sysdba',
    // Saved connections never carry a password — it lives only in SecretStorage.
    password: undefined,
    role: null,
    ...overrides,
  };
}

suite('NodeTable password resolution (expanding a table in the tree)', function () {
  const originalClient = Driver.client;

  setup(function () {
    CredentialStore.setContext(createMockContext() as any);
  });

  teardown(function () {
    Driver.client = originalClient;
  });

  test('getChildren() fails with the isc_login error when the connection is unresolved and nothing is stored', async function () {
    Driver.client = new FakeClient();
    const table = new NodeTable(unresolvedConnection(), 'EMPLOYEE');

    const children = await table.getChildren();

    assert.strictEqual(children.length, 1);
    assert.ok(children[0] instanceof NodeInfo, 'expected the error fallback NodeInfo, not table fields');
  });

  test('getChildren() succeeds once a password is stored for the connection id, even though dbDetails.password is empty', async function () {
    Driver.client = new FakeClient();
    await CredentialStore.storePassword('saved-conn', 'masterkey');

    const table = new NodeTable(unresolvedConnection(), 'EMPLOYEE');
    const children = await table.getChildren();

    // One NodeField per column returned by the query, plus a trailing "Indexes" folder.
    assert.strictEqual(children.length, 2);
    assert.ok(children[0] instanceof NodeField, `expected table fields, got: ${children[0]}`);
    assert.ok(children[1] instanceof NodeIndexFolder, `expected a trailing Indexes folder, got: ${children[1]}`);
  });

  test('getChildren() connects with the resolved password, not the empty one from dbDetails', async function () {
    const fake = new FakeClient();
    Driver.client = fake;
    await CredentialStore.storePassword('saved-conn', 'masterkey');

    const table = new NodeTable(unresolvedConnection(), 'EMPLOYEE');
    await table.getChildren();

    assert.strictEqual(fake.connectedWith.length, 1);
    assert.strictEqual(fake.connectedWith[0].password, 'masterkey');
  });
});
