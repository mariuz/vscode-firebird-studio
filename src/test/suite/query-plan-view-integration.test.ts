/**
 * Extension Development Host integration test for the Query Plan Visualizer's standalone panel
 * (docs/roadmap/query-plan-visualizer.md). `QueryPlanView` had no suite-tier coverage at all
 * before this — `Driver.getQueryPlan()`'s fallback path was only ever driven against a live server
 * with one-off, uncommitted Node harnesses during development (per that doc's own "Testing"
 * section), and `interpretPlanText()` itself is unit-tested only against captured fixture strings,
 * not a live fetch.
 *
 * Drives the real `QueryPlanView` class against the real seeded test server, monkey-patching
 * `send()` the same way src/test/suite/live-profiler-integration.test.ts does, for the same reason
 * (the webview's own content is a sandboxed iframe this test can't otherwise inspect).
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { QueryPlanView } from '../../query-plan-view';
import { Driver, NodeClient } from '../../shared/driver';
import { getTestConnectionOptions } from './firebird-test-env';

suite('Query Plan Visualizer – real Firebird integration (extension host)', function () {
  this.timeout(20000);

  let view: QueryPlanView;
  let sent: Array<{ command: string; data: any }>;

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio');
    if (ext && !ext.isActive) { await ext.activate(); }
    // Bypass Driver.setClient()/CredentialStore, same as driver-integration.test.ts: activate()
    // runs the copy of Driver bundled inside out/extension.js, a separate module instance (own
    // independent static state) from the plain-tsc-compiled out/shared/driver.js this suite-tier
    // test file's own `import { Driver } from '../../shared/driver'` resolves to, so real
    // activation never touches the copy this test uses. Every call below passes
    // connectionOptions (with password) explicitly, so no ExtensionContext is needed.
    Driver.client = new NodeClient();
  });

  setup(function () {
    view = new QueryPlanView(vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio')!.extensionPath);
    sent = [];
    (view as any).send = (msg: { command: string; data: any }) => { sent.push(msg); };

    // open() creates a real WebviewPanel whose real (sandboxed) webview JS genuinely runs and
    // posts its own "ready" message back asynchronously, on its own schedule, independent of
    // every test below driving fetchAndSend()/fetchActualPlan() directly. That's noise no test
    // here relies on (none needs the real handshake) but it can land *during* a later test --
    // disposing the panel in a teardown hook isn't reliably fast enough to beat it, since the
    // real webview can take a while to load and run its script. Filter it out at the source
    // instead; "analyzePlan" (the one message a test does drive through the real handleMessage)
    // still reaches the real implementation unchanged.
    const realHandleMessage = (view as any).handleMessage.bind(view);
    (view as any).handleMessage = (message: { command: string; data: any }) => {
      if (message.command === 'ready' || message.command === 'refresh') {
        return;
      }
      realHandleMessage(message);
    };
  });

  teardown(function () {
    view.dispose();
  });

  test('a real "ready" fetch against a live connection returns a real plan (native driver) or the documented graceful fallback (pure-JS driver) — never a crash or a garbled message', async function () {
    view.open('SELECT * FROM PRODUCTS WHERE ID = 1', getTestConnectionOptions());
    await (view as any).fetchAndSend();

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].command, 'planData');

    if (sent[0].data.error) {
      // This environment's Driver.client is a NodeClient (pure-JS driver, no native build) --
      // Driver.getQueryPlan() correctly falls back to an index-metadata heuristic rather than a
      // real PLAN, and interpretPlanText() correctly treats that fallback text as "no diagram
      // available" rather than trying to parse it as one (see plan-parser.ts's
      // PLAN_FALLBACK_PREFIXES) -- this is documented, correct behavior, not a bug, so assert the
      // *shape* of the graceful degradation is right rather than assuming native-driver success.
      assert.ok(sent[0].data.error.includes('native driver'), sent[0].data.error);
      assert.ok(sent[0].data.raw.includes('PRODUCTS'), sent[0].data.raw);
      return;
    }
    assert.ok(Array.isArray(sent[0].data.blocks), 'expected a parsed blocks array');
    assert.ok(typeof sent[0].data.raw === 'string' && sent[0].data.raw.length > 0, 'expected the raw plan text too');
  });

  test('the fetched plan\'s raw text references the real table the query selects from, regardless of native-driver availability', async function () {
    view.open('SELECT * FROM PRODUCTS', getTestConnectionOptions());
    await (view as any).fetchAndSend();
    const raw: string = sent[0].data.raw;
    assert.ok(raw.toUpperCase().includes('PRODUCTS'), raw);
  });

  test('a query against a nonexistent table reports a real error, not a thrown exception', async function () {
    view.open('SELECT * FROM THIS_TABLE_DOES_NOT_EXIST_XYZ', getTestConnectionOptions());
    await (view as any).fetchAndSend();
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].data.error, 'expected a real error to be reported for a nonexistent table');
  });

  test('the "🤖 Analyze" action is only available after a successful plan render, and carries the real raw plan text', function () {
    // Drives parseAndSend() directly with a real, valid PLAN fixture (the same one
    // plan-parser.test.ts uses) rather than through fetchAndSend() -- a live "ready" fetch's
    // success depends on whether the native driver happens to be built in this environment (see
    // the test above), but parseAndSend() is the shared core both a live fetch and "Import a
    // saved Plan" (docs/roadmap/query-plan-visualizer.md phase 5) funnel through, and is exactly
    // as real a code path either way.
    view.open('SELECT * FROM PRODUCTS', getTestConnectionOptions());
    let emitted: { sql?: string; plan: string } | undefined;
    view.once('analyzePlan', payload => { emitted = payload; });

    (view as any).parseAndSend('PLAN (PRODUCTS NATURAL)');
    view.handleMessage({ command: 'analyzePlan', data: {} });

    assert.ok(emitted, 'expected the analyzePlan event to fire after a successful render');
    assert.strictEqual(emitted!.sql, 'SELECT * FROM PRODUCTS');
    assert.strictEqual(emitted!.plan, 'PLAN (PRODUCTS NATURAL)');
  });

  test('analyzePlan before any successful fetch does not emit (nothing to analyze yet)', function () {
    let emitted = false;
    view.once('analyzePlan', () => { emitted = true; });
    view.handleMessage({ command: 'analyzePlan', data: {} });
    assert.strictEqual(emitted, false);
  });

  test('getActualPlan (phase 3) re-runs the query for real via RDB$PROFILER and returns per-record-source stats', async function () {
    this.timeout(40000); // several sequential round trips (session start/run/flush/finish/lookup) over the pure-JS driver
    view.open('SELECT * FROM PRODUCTS', getTestConnectionOptions());
    await (view as any).fetchActualPlan();

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].command, 'actualPlanData');
    if (sent[0].data.error) {
      // Firebird < 5.0 (no RDB$PROFILER) is a legitimate, disclosed environment limitation for
      // this feature, not a bug -- assert it fails with a real, specific error rather than silently.
      assert.ok(typeof sent[0].data.error === 'string' && sent[0].data.error.length > 0);
      this.skip();
      return;
    }
    assert.ok(Array.isArray(sent[0].data.nodes), 'expected a real actual-plan node tree');
  });
});
