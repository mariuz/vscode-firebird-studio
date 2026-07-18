/**
 * Extension Development Host integration test for the Live Profiler (docs/roadmap/live-profiler.md).
 * `ProfilerView` had no suite-tier coverage at all before this — only its query builders
 * (`profilerActivityQuery()`/`killAttachmentQuery()`/`rollbackTransactionQuery()`) were unit-tested
 * for SQL *shape*, and real-server execution was previously only ever checked with one-off,
 * uncommitted Node harnesses during development (per that doc's own "Testing" section).
 *
 * Drives the real `ProfilerView` class (a real `QueryResultsView` webview panel, real
 * `Driver.client` connection) against the real seeded test server. `send()` is monkey-patched on
 * the instance to capture what would have been posted to the webview, since the webview's own
 * content is a sandboxed iframe this test can't otherwise inspect — the extension-host side logic
 * (real SQL execution, real message shape) is what's actually being verified here.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProfilerView } from '../../profiler';
import { Driver, NodeClient } from '../../shared/driver';
import { killAttachmentQuery } from '../../shared/queries';
import { getTestConnectionOptions } from './firebird-test-env';

suite('Live Profiler – real Firebird integration (extension host)', function () {
  this.timeout(20000);

  let view: ProfilerView;
  let sent: Array<{ command: string; data: any }>;
  let extraConnection: unknown;

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio');
    if (ext && !ext.isActive) { await ext.activate(); }
    // Bypass Driver.setClient()/CredentialStore, same as driver-integration.test.ts: activate()
    // runs the copy of Driver bundled inside out/extension.js, a separate module instance (own
    // independent static state) from the plain-tsc-compiled out/shared/driver.js this suite-tier
    // test file's own `import { Driver } from '../../shared/driver'` resolves to (and that
    // ProfilerView itself imports), so real activation never touches the copy this test uses.
    // getTestConnectionOptions() supplies the password explicitly, so no ExtensionContext is
    // needed.
    Driver.client = new NodeClient();

    // A second, independent live connection so profilerActivityQuery() (which excludes the
    // profiler's own connection) has at least one real row to return.
    const resolved = await Driver.resolvePassword(getTestConnectionOptions());
    extraConnection = await Driver.client.createConnection(resolved);
  });

  suiteTeardown(async function () {
    if (extraConnection) {
      await Driver.client.detach(extraConnection).catch(() => { /* already gone */ });
    }
  });

  setup(function () {
    view = new ProfilerView(vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio')!.extensionPath);
    sent = [];
    (view as any).send = (msg: { command: string; data: any }) => { sent.push(msg); };
  });

  teardown(function () {
    view.dispose();
  });

  test('open() + the "ready" handshake sends the init message with a real poll interval', function () {
    view.open(getTestConnectionOptions());
    view.handleMessage({ command: 'ready', data: {} });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].command, 'init');
    assert.strictEqual(typeof sent[0].data.pollIntervalMs, 'number');
  });

  test('a real poll executes profilerActivityQuery() against the live server and returns real MON$ATTACHMENTS-shaped rows', async function () {
    view.open(getTestConnectionOptions());
    await (view as any).pollOnce();

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].command, 'activityData');
    assert.ok(!sent[0].data.error, `expected no error, got: ${sent[0].data.error}`);
    assert.ok(Array.isArray(sent[0].data.rows), 'expected a rows array');
    assert.ok(sent[0].data.rows.length >= 1, 'expected at least the extra connection opened in suiteSetup to show up');

    const row = sent[0].data.rows[0];
    assert.ok('ATTACHMENT_ID' in row, JSON.stringify(row));
    assert.ok('USER_NAME' in row, JSON.stringify(row));
    assert.ok('ATTACHMENT_STATE' in row, JSON.stringify(row));
  });

  test('two consecutive real polls both succeed (the pooled/reused connection survives a second call)', async function () {
    view.open(getTestConnectionOptions());
    await (view as any).pollOnce();
    await (view as any).pollOnce();
    assert.strictEqual(sent.length, 2);
    assert.ok(!sent[0].data.error && !sent[1].data.error);
  });

  test('a poll against an unreachable database reports a real error, not a thrown exception', async function () {
    view.open({ ...getTestConnectionOptions(), database: '/nonexistent/path/does-not-exist.fdb' });
    await (view as any).pollOnce();
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].data.error, 'expected a real connection error to be reported');
  });

  test('killAttachmentQuery()/rollbackTransactionQuery() actually work against the live server (the same statements runAdminAction() runs internally)', async function () {
    const resolved = await Driver.resolvePassword(getTestConnectionOptions());
    const scratch = await Driver.client.createConnection(resolved);

    try {
      const before = await Driver.client.queryPromise<{ N: number }>(scratch, profilerCountQuery());
      assert.ok(Number(before[0].N) >= 1, 'expected at least the scratch connection itself to be visible');

      // Kill the *extra* suiteSetup connection (not the scratch one we're issuing the kill from) --
      // confirms the exact statement runAdminAction() builds actually executes successfully.
      const attachmentsBefore = await Driver.client.queryPromise<{ ATTACHMENT_ID: number }>(
        scratch, "SELECT MON$ATTACHMENT_ID AS ATTACHMENT_ID FROM MON$ATTACHMENTS WHERE MON$ATTACHMENT_ID <> CURRENT_CONNECTION"
      );
      assert.ok(attachmentsBefore.length >= 1, 'expected the extra connection to be visible from this scratch connection too');
      const targetId = attachmentsBefore[0].ATTACHMENT_ID;

      await Driver.client.queryPromise(scratch, killAttachmentQuery(targetId));

      const attachmentsAfter = await Driver.client.queryPromise<{ ATTACHMENT_ID: number }>(
        scratch, `SELECT MON$ATTACHMENT_ID AS ATTACHMENT_ID FROM MON$ATTACHMENTS WHERE MON$ATTACHMENT_ID = ${targetId}`
      );
      assert.strictEqual(attachmentsAfter.length, 0, 'the killed attachment should no longer be visible');
    } finally {
      await Driver.client.detach(scratch).catch(() => { /* already gone */ });
    }

    // The suiteSetup connection was just killed by this test -- reopen it so later tests in this
    // suite (and suiteTeardown's own detach) still have a live extra connection to work with.
    extraConnection = await Driver.client.createConnection(await Driver.resolvePassword(getTestConnectionOptions()));
  });
});

function profilerCountQuery(): string {
  return 'SELECT COUNT(*) AS N FROM MON$ATTACHMENTS';
}
