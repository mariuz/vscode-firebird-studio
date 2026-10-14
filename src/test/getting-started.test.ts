import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  buildMcpConfigSnippet,
  buildGettingStartedHtml,
  SAMPLE_EMPLOYEE_QUERIES,
  GettingStartedState,
  fetchGettingStartedState,
  addSampleEmployeeConnection,
  testConnectionPing,
  showGettingStartedHub
} from '../getting-started';
import { Constants } from '../config';
import { Global } from '../shared/global';
import { CredentialStore } from '../shared/credential-store';
import { ConnectionOptions } from '../interfaces';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json');

suite('Interactive Getting Started Hub', () => {
  suite('package.json contribution declarations', () => {
    test('declares firebird.gettingStarted command', () => {
      const cmds = pkg.contributes.commands;
      const cmd = cmds.find((c: any) => c.command === 'firebird.gettingStarted');
      assert.ok(cmd, 'firebird.gettingStarted must be declared in contributes.commands');
      assert.strictEqual(cmd.title, 'Getting Started Hub');
      assert.strictEqual(cmd.category, 'Firebird');
      assert.strictEqual(cmd.icon, '$(rocket)');
    });

    test('contributes firebird.gettingStarted to DB Explorer view/title', () => {
      const viewTitleMenus = pkg.contributes.menus['view/title'];
      const menu = viewTitleMenus.find(
        (m: any) => m.command === 'firebird.gettingStarted' && m.when === 'view == firebird-explorer'
      );
      assert.ok(menu, 'firebird.gettingStarted must be contributed to DB Explorer title menu');
      assert.strictEqual(menu.group, 'navigation@0');
    });
  });

  suite('Pure helpers and sample definitions', () => {
    test('buildMcpConfigSnippet formats valid JSON with normalized path', () => {
      const snippet = buildMcpConfigSnippet('C:\\Users\\User\\out\\mcp-server\\server.js');
      const parsed = JSON.parse(snippet);
      assert.ok(parsed.mcpServers?.firebird);
      assert.strictEqual(parsed.mcpServers.firebird.command, 'node');
      assert.strictEqual(parsed.mcpServers.firebird.args[0], 'C:/Users/User/out/mcp-server/server.js');
    });

    test('SAMPLE_EMPLOYEE_QUERIES has all canonical demo queries with valid SQL', () => {
      assert.ok(SAMPLE_EMPLOYEE_QUERIES.length >= 4);
      for (const query of SAMPLE_EMPLOYEE_QUERIES) {
        assert.ok(query.title.length > 0);
        assert.ok(query.description.length > 0);
        assert.ok(query.sql.includes('SELECT'), `Query "${query.title}" should include SELECT`);
      }
    });

    test('buildGettingStartedHtml renders complete dashboard markup', () => {
      const mockState: GettingStartedState = {
        version: '0.3.0',
        dockerAvailable: true,
        connections: [
          {
            id: 'conn-1',
            label: 'Local Dev (localhost:3050)',
            host: 'localhost',
            database: 'employee',
            user: 'SYSDBA',
            embedded: false,
            isActive: true
          }
        ],
        activeConnectionId: 'conn-1',
        mcpSnippet: '{"mcpServers":{}}'
      };

      const html = buildGettingStartedHtml(mockState, 'vscode-webview:');
      assert.ok(html.includes('Firebird Studio'), 'should contain title');
      assert.ok(html.includes('v0.3.0'), 'should render version tag');
      assert.ok(html.includes('Local Dev (localhost:3050)'), 'should render connection label');
      assert.ok(html.includes('ACTIVE'), 'should display active badge');
      assert.ok(html.includes('Docker detected on system'), 'should show docker detected badge');
      assert.ok(html.includes('employee.fdb'), 'should describe sample database');
      assert.ok(html.includes('Content-Security-Policy'), 'should include CSP meta tag');
    });
  });

  suite('State fetching & sample connection creation', () => {
    let mockGlobalState: Record<string, any>;
    let mockContext: vscode.ExtensionContext;

    setup(() => {
      mockGlobalState = {};
      mockContext = {
        extensionPath: '/mock/path',
        globalState: {
          get: (key: string, def?: any) => (key in mockGlobalState ? mockGlobalState[key] : def),
          update: (key: string, val: any) => { mockGlobalState[key] = val; return Promise.resolve(); }
        }
      } as any;
      Global.context = mockContext;
    });

    test('fetchGettingStartedState returns configured connections and environment state', async () => {
      mockGlobalState[Constants.ConectionsKey] = {
        'test-id-1': {
          id: 'test-id-1',
          name: 'Main DB',
          host: 'db.corp.net',
          database: '/data/prod.fdb',
          user: 'SYSDBA'
        }
      };

      const state = await fetchGettingStartedState(mockContext);
      assert.strictEqual(state.version, Constants.Version);
      assert.strictEqual(typeof state.dockerAvailable, 'boolean');
      assert.strictEqual(state.connections.length, 1);
      assert.strictEqual(state.connections[0].id, 'test-id-1');
      assert.strictEqual(state.connections[0].host, 'db.corp.net');
    });

    test('addSampleEmployeeConnection creates and activates localhost:3050/employee', async () => {
      let storedPasswordId = '';
      let storedPasswordVal = '';
      const origStore = CredentialStore.storePassword;
      CredentialStore.storePassword = (id: string, pw: string) => {
        storedPasswordId = id;
        storedPasswordVal = pw;
        return Promise.resolve();
      };

      try {
        const conn = await addSampleEmployeeConnection(mockContext);
        assert.ok(conn.id);
        assert.strictEqual(conn.host, 'localhost');
        assert.strictEqual(conn.port, 3050);
        assert.strictEqual(conn.database, 'employee');
        assert.strictEqual(conn.user, 'SYSDBA');
        assert.strictEqual(storedPasswordId, conn.id);
        assert.strictEqual(storedPasswordVal, 'masterkey');

        const savedConns = mockGlobalState[Constants.ConectionsKey];
        assert.ok(savedConns[conn.id]);
        assert.strictEqual(savedConns[conn.id].database, 'employee');
        assert.strictEqual(Global.activeConnection?.id, conn.id);
      } finally {
        CredentialStore.storePassword = origStore;
      }
    });
  });

  suite('testConnectionPing()', () => {
    test('measures latency and returns success on clean connection', async () => {
      const mockConn: ConnectionOptions = {
        host: 'localhost',
        database: 'employee',
        user: 'SYSDBA'
      };

      // Mock attemptConnection in driver / connection-wizard
      const cw = require('../shared/connection-wizard');
      const origAttempt = cw.attemptConnection;
      try {
        cw.attemptConnection = () => Promise.resolve(undefined);
        const result = await testConnectionPing(mockConn);
        assert.strictEqual(result.success, true);
        assert.strictEqual(typeof result.latencyMs, 'number');
        assert.strictEqual(result.error, undefined);
      } finally {
        cw.attemptConnection = origAttempt;
      }
    });

    test('returns failure and error message on failed connection', async () => {
      const mockConn: ConnectionOptions = {
        host: 'invalid.host',
        database: 'employee',
        user: 'SYSDBA'
      };

      const cw = require('../shared/connection-wizard');
      const origAttempt = cw.attemptConnection;
      try {
        cw.attemptConnection = () => Promise.resolve('Connection refused at port 3050');
        const result = await testConnectionPing(mockConn);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'Connection refused at port 3050');
        assert.strictEqual(typeof result.latencyMs, 'number');
      } finally {
        cw.attemptConnection = origAttempt;
      }
    });
  });

  suite('showGettingStartedHub() panel lifecycle', () => {
    let mockContext: vscode.ExtensionContext;
    let mockGlobalState: Record<string, any>;

    setup(() => {
      mockGlobalState = {};
      mockContext = {
        extensionPath: __dirname,
        globalState: {
          get: (key: string, def?: any) => (key in mockGlobalState ? mockGlobalState[key] : def),
          update: (key: string, val: any) => { mockGlobalState[key] = val; return Promise.resolve(); }
        }
      } as any;
      Global.context = mockContext;
    });

    test('creates and returns a webview panel, revealing existing one on second call', async () => {
      const panel1 = await showGettingStartedHub(mockContext);
      assert.ok(panel1);
      assert.strictEqual(panel1.title, 'Firebird Studio: Getting Started');

      let revealed = false;
      panel1.reveal = () => { revealed = true; };

      const panel2 = await showGettingStartedHub(mockContext);
      assert.strictEqual(panel1, panel2, 'should reuse existing panel');
      assert.strictEqual(revealed, true, 'should reveal existing panel');

      panel1.dispose();
    });
  });
});
