import {
  ExtensionContext, ViewColumn, WebviewPanel, window, Uri, commands, workspace, env
} from "vscode";
import * as path from "path";
import { v1 as uuidv1 } from "uuid";
import { ConnectionOptions } from "../interfaces";
import { Constants, getOptions } from "../config";
import { Global } from "../shared/global";
import { CredentialStore } from "../shared/credential-store";
import { getConnectionLabel, getDatabaseFileName } from "../shared/utils";
import { loadWorkspaceConnections } from "../shared/workspace-config";
import { attemptConnection } from "../shared/connection-wizard";
import { probeDocker } from "../shared/executable-probe";
import { logger } from "../logger/logger";

export interface GettingStartedConnection {
  id: string;
  label: string;
  host: string;
  database: string;
  user: string;
  embedded: boolean;
  isActive: boolean;
}

export interface GettingStartedState {
  version: string;
  dockerAvailable: boolean;
  connections: GettingStartedConnection[];
  activeConnectionId?: string;
  mcpSnippet: string;
}

export interface SampleQuery {
  title: string;
  description: string;
  sql: string;
}

export const SAMPLE_EMPLOYEE_QUERIES: SampleQuery[] = [
  {
    title: "Department Budgets & Headcounts",
    description: "Aggregates total headcounts and budgets grouped by department, sorted by budget.",
    sql: "SELECT d.DEPARTMENT, d.BUDGET, COUNT(e.EMP_NO) AS TOTAL_EMPLOYEES\nFROM DEPARTMENT d\nLEFT JOIN EMPLOYEE e ON d.DEPT_NO = e.DEPT_NO\nGROUP BY d.DEPARTMENT, d.BUDGET\nORDER BY d.BUDGET DESC;"
  },
  {
    title: "Top 10 Salaries & Hire Dates",
    description: "Finds the ten highest compensated employees across all branches.",
    sql: "SELECT FIRST 10 FIRST_NAME, LAST_NAME, SALARY, HIRE_DATE\nFROM EMPLOYEE\nORDER BY SALARY DESC;"
  },
  {
    title: "Recent Customer Sales Orders",
    description: "Joins sales orders with customer names and purchase order amounts.",
    sql: "SELECT FIRST 15 c.CUSTOMER, s.PO_NUMBER, s.TOTAL_VALUE, s.ORDER_STATUS, s.ORDER_DATE\nFROM SALES s\nJOIN CUSTOMER c ON s.CUST_NO = c.CUST_NO\nORDER BY s.ORDER_DATE DESC;"
  },
  {
    title: "Active Projects & Team Leaders",
    description: "Lists active company projects, product assignments, and lead names.",
    sql: "SELECT p.PROJ_NAME, p.PROJ_DESC, p.PRODUCT, e.FIRST_NAME || ' ' || e.LAST_NAME AS TEAM_LEAD\nFROM PROJECT p\nLEFT JOIN EMPLOYEE e ON p.TEAM_LEADER = e.EMP_NO\nORDER BY p.PROJ_NAME;"
  }
];

export function buildMcpConfigSnippet(serverJsPath: string): string {
  const normalizedPath = serverJsPath.replace(/\\/g, "/");
  return JSON.stringify(
    {
      mcpServers: {
        firebird: {
          command: "node",
          args: [normalizedPath]
        }
      }
    },
    null,
    2
  );
}

export async function fetchGettingStartedState(context: ExtensionContext): Promise<GettingStartedState> {
  const saved = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
  const workspaceConns = await loadWorkspaceConnections();

  const activeId = Global.activeConnection?.id;
  const connections: GettingStartedConnection[] = [];

  for (const [id, conn] of Object.entries(saved)) {
    connections.push({
      id,
      label: getConnectionLabel(conn),
      host: conn.host,
      database: conn.database,
      user: conn.user,
      embedded: !!conn.embedded,
      isActive: id === activeId
    });
  }

  for (const conn of workspaceConns) {
    if (!connections.some(c => c.id === conn.id)) {
      connections.push({
        id: conn.id,
        label: getConnectionLabel(conn),
        host: conn.host,
        database: conn.database,
        user: conn.user,
        embedded: !!conn.embedded,
        isActive: conn.id === activeId
      });
    }
  }

  let dockerAvailable = false;
  try {
    const dockerPath = getOptions().dockerPath || "docker";
    dockerAvailable = await probeDocker(dockerPath);
  } catch {
    dockerAvailable = false;
  }

  const serverJsPath = path.join(context.extensionPath, "out", "mcp-server", "server.js");
  const mcpSnippet = buildMcpConfigSnippet(serverJsPath);

  return {
    version: Constants.Version,
    dockerAvailable,
    connections,
    activeConnectionId: activeId,
    mcpSnippet
  };
}

export async function addSampleEmployeeConnection(context: ExtensionContext): Promise<ConnectionOptions> {
  const id = uuidv1();
  const conn: ConnectionOptions = {
    id,
    group: "Employee Sample",
    host: "localhost",
    port: 3050,
    database: "employee",
    user: "SYSDBA",
    password: "masterkey",
    role: null,
    embedded: false
  };

  await CredentialStore.storePassword(id, "masterkey");
  const saved = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
  saved[id] = { ...conn, password: undefined };
  await context.globalState.update(Constants.ConectionsKey, saved);

  Global.activeConnection = conn;
  commands.executeCommand("firebird.explorer.refresh");
  return conn;
}

export async function testConnectionPing(
  conn: ConnectionOptions
): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const error = await attemptConnection(conn);
    const latencyMs = Date.now() - start;
    if (error) {
      return { success: false, latencyMs, error };
    }
    return { success: true, latencyMs };
  } catch (err: any) {
    return { success: false, latencyMs: Date.now() - start, error: err?.message ?? String(err) };
  }
}

export function buildGettingStartedHtml(state: GettingStartedState, cspSource = ""): string {
  const jsonState = JSON.stringify(state).replace(/</g, "\\u003c");
  const sampleQueriesJson = JSON.stringify(SAMPLE_EMPLOYEE_QUERIES).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${cspSource ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline'; img-src ${cspSource} data:;">` : ""}
  <title>Firebird Studio – Getting Started Hub</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --border: var(--vscode-panel-border, #333333);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-sec-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --success: #89d185;
      --error: #f48771;
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      --code-font: var(--vscode-editor-font-family, Menlo, Monaco, "Courier New", monospace);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.5;
      padding: 24px 32px 48px 32px;
      max-width: 1040px;
      margin: 0 auto;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
      margin-bottom: 24px;
    }
    .header-brand {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .brand-icon {
      font-size: 32px;
      line-height: 1;
    }
    .brand-titles h1 {
      font-size: 22px;
      font-weight: 600;
      color: var(--fg);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .version-tag {
      font-size: 11px;
      background: var(--badge-bg);
      color: var(--badge-fg);
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 500;
    }
    .brand-titles p {
      font-size: 13px;
      opacity: 0.8;
      margin-top: 2px;
    }
    .header-links {
      display: flex;
      gap: 12px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 4px;
      border: none;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      background: var(--accent);
      color: var(--btn-fg);
      transition: background 0.1s ease;
      text-decoration: none;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn-secondary {
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
    }
    .btn-secondary:hover { opacity: 0.9; }
    .btn-sm { padding: 4px 8px; font-size: 11px; }

    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }
    .action-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      cursor: pointer;
      transition: border-color 0.15s ease, transform 0.1s ease;
    }
    .action-card:hover {
      border-color: var(--accent);
      transform: translateY(-1px);
    }
    .card-icon { font-size: 20px; }
    .card-title { font-weight: 600; font-size: 14px; }
    .card-desc { font-size: 12px; opacity: 0.8; flex-grow: 1; }

    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .panel-block {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 18px;
      margin-bottom: 28px;
    }

    /* Connections Table */
    .conn-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 10px;
    }
    .conn-table th, .conn-table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .conn-table th {
      font-weight: 600;
      opacity: 0.85;
      background: rgba(255, 255, 255, 0.03);
    }
    .badge-active {
      display: inline-block;
      padding: 2px 6px;
      background: rgba(137, 209, 133, 0.2);
      color: var(--success);
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .test-result-badge {
      font-size: 11px;
      font-weight: 500;
    }
    .test-result-badge.success { color: var(--success); }
    .test-result-badge.error { color: var(--error); }

    /* Queries List */
    .query-item {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .query-item:last-child { border-bottom: none; }
    .query-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .query-title { font-weight: 600; font-size: 13px; }
    .query-desc { font-size: 12px; opacity: 0.8; }
    pre.code-block {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 12px;
      font-family: var(--code-font);
      font-size: 11px;
      overflow-x: auto;
      white-space: pre-wrap;
      color: var(--fg);
    }

    .docker-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
      padding: 4px 8px;
      border-radius: 4px;
      margin-bottom: 12px;
    }
    .docker-detected {
      background: rgba(137, 209, 133, 0.15);
      color: var(--success);
    }
    .docker-missing {
      background: rgba(244, 135, 113, 0.15);
      color: var(--error);
    }
  </style>
</head>
<body>
  <header>
    <div class="header-brand">
      <div class="brand-icon">🔥</div>
      <div class="brand-titles">
        <h1>Firebird Studio <span class="version-tag">v${state.version}</span></h1>
        <p>Interactive Hub – Connections, Docker Provisioning, Sample Database & MCP AI</p>
      </div>
    </div>
    <div class="header-links">
      <button class="btn btn-secondary" onclick="postAction('openWalkthrough')">📖 Walkthrough</button>
      <button class="btn btn-secondary" onclick="postAction('openDocumentation')">🌐 Official Docs</button>
    </div>
  </header>

  <!-- Quick Start Cards -->
  <div class="grid-2">
    <div class="action-card" onclick="postAction('addConnection')">
      <div class="card-icon">➕</div>
      <div class="card-title">Add Connection</div>
      <div class="card-desc">Connect to a local Firebird server, remote instance, or embedded .fdb/.gdb file.</div>
      <div><span class="btn btn-sm">Launch Wizard</span></div>
    </div>
    <div class="action-card" onclick="postAction('newSqlDocument')">
      <div class="card-icon">📝</div>
      <div class="card-title">New SQL Document</div>
      <div class="card-desc">Write and run Firebird queries with full IntelliSense, plan visualization, and table formatting.</div>
      <div><span class="btn btn-sm">Open Editor</span></div>
    </div>
    <div class="action-card" onclick="postAction('openSchemaDesigner')">
      <div class="card-icon">🗺️</div>
      <div class="card-title">Visual Schema Designer</div>
      <div class="card-desc">Interactive ER diagram visualizer with real-time foreign key graphs and DDL diffing.</div>
      <div><span class="btn btn-sm">View Diagram</span></div>
    </div>
    <div class="action-card" onclick="postAction('openNotebook')">
      <div class="card-icon">📓</div>
      <div class="card-title">SQL Notebook</div>
      <div class="card-desc">Execute multi-cell interactive notebooks with rich Markdown notes, charts, and exports.</div>
      <div><span class="btn btn-sm">New Notebook</span></div>
    </div>
  </div>

  <!-- Connection Manager & One-Click Ping -->
  <div class="panel-block">
    <div class="section-title">
      <span>Configured Connections &amp; Health Check</span>
      <button class="btn btn-sm btn-secondary" onclick="postAction('refresh')">🔄 Refresh</button>
    </div>
    <div id="connections-container">
      ${renderConnectionsTable(state.connections)}
    </div>
  </div>

  <!-- Docker Container Provisioning -->
  <div class="panel-block">
    <div class="section-title">Local Database Provisioning (Docker)</div>
    <div class="docker-status-badge ${state.dockerAvailable ? "docker-detected" : "docker-missing"}">
      ${state.dockerAvailable ? "✓ Docker detected on system" : "⚠️ Docker CLI not detected in system PATH"}
    </div>
    <p style="margin-bottom: 14px; font-size: 12px; opacity: 0.85;">
      Instantly provision an isolated, ephemeral or volume-backed Firebird server container directly from VS Code.
    </p>
    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
      <button class="btn" onclick="postAction('createContainer')">🐳 Provision Container Wizard...</button>
      <button class="btn btn-secondary" onclick="postAction('addSampleConnection')">📦 Quick Connect employee.fdb (localhost:3050)</button>
    </div>
  </div>

  <!-- Sample Database Exploration -->
  <div class="panel-block">
    <div class="section-title">
      <span>Sample Database: employee.fdb</span>
      <span style="font-size: 11px; opacity: 0.7; font-weight: normal;">Canonical Firebird Demo Database</span>
    </div>
    <p style="margin-bottom: 14px; font-size: 12px; opacity: 0.85;">
      <code>employee.fdb</code> is the official reference database bundled with Firebird, demonstrating relational constraints, triggers, procedures, generators, and departmental hierarchies. Click any query below to run it immediately:
    </p>
    <div style="border: 1px solid var(--border); border-radius: 4px;">
      ${renderSampleQueries()}
    </div>
  </div>

  <!-- AI & MCP Server Integration -->
  <div class="panel-block">
    <div class="section-title">AI Tooling &amp; Model Context Protocol (MCP)</div>
    <p style="margin-bottom: 12px; font-size: 12px; opacity: 0.85;">
      Firebird Studio contributes a dedicated MCP server enabling Claude Desktop, Cursor, and Cline to safely inspect schemas, list connections, and execute authorized SQL queries.
    </p>
    <pre class="code-block" id="mcp-config-code">${escapeHtml(state.mcpSnippet)}</pre>
    <div style="margin-top: 10px; display: flex; gap: 10px;">
      <button class="btn btn-sm btn-secondary" onclick="copyMcpConfig()">📋 Copy MCP Configuration</button>
      <button class="btn btn-sm btn-secondary" onclick="postAction('openCopilotInstructions')">🤖 Copilot Integration Guide</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let state = ${jsonState};
    const sampleQueries = ${sampleQueriesJson};

    function postAction(command, data) {
      vscode.postMessage({ command, ...data });
    }

    function testConnection(connectionId) {
      const statusEl = document.getElementById("status-" + connectionId);
      if (statusEl) {
        statusEl.innerHTML = '<span style="opacity: 0.7;">Testing...</span>';
      }
      vscode.postMessage({ command: "testConnection", connectionId });
    }

    function setActive(connectionId) {
      vscode.postMessage({ command: "setActiveConnection", connectionId });
    }

    function openQueryForConnection(connectionId) {
      vscode.postMessage({ command: "openQuery", connectionId });
    }

    function runSampleQuery(index) {
      const q = sampleQueries[index];
      if (q) {
        vscode.postMessage({ command: "openQuery", sql: q.sql });
      }
    }

    function copySampleQuery(index) {
      const q = sampleQueries[index];
      if (q) {
        vscode.postMessage({ command: "copyText", text: q.sql });
      }
    }

    function copyMcpConfig() {
      vscode.postMessage({ command: "copyText", text: state.mcpSnippet });
    }

    window.addEventListener("message", event => {
      const msg = event.data;
      if (msg.command === "testResult") {
        const statusEl = document.getElementById("status-" + msg.connectionId);
        if (statusEl) {
          if (msg.result.success) {
            statusEl.innerHTML = '<span class="test-result-badge success">✓ Connected (' + msg.result.latencyMs + 'ms)</span>';
          } else {
            statusEl.innerHTML = '<span class="test-result-badge error">✗ ' + (msg.result.error || "Failed") + '</span>';
          }
        }
      } else if (msg.command === "connectionActivated") {
        document.querySelectorAll(".badge-active").forEach(el => el.remove());
        const row = document.getElementById("row-" + msg.connectionId);
        if (row) {
          const nameCell = row.querySelector(".conn-name-cell");
          if (nameCell) {
            const badge = document.createElement("span");
            badge.className = "badge-active";
            badge.textContent = "ACTIVE";
            nameCell.appendChild(badge);
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

function renderConnectionsTable(connections: GettingStartedConnection[]): string {
  if (connections.length === 0) {
    return `
      <div style="padding: 16px; text-align: center; opacity: 0.8; font-size: 12px;">
        No connections configured yet. Click <strong>Add Connection</strong> or <strong>Quick Connect employee.fdb</strong> above to get started.
      </div>
    `;
  }

  const rows = connections.map(c => `
    <tr id="row-${c.id}">
      <td class="conn-name-cell" style="display: flex; align-items: center; gap: 8px;">
        <span>${escapeHtml(c.label)}</span>
        ${c.isActive ? '<span class="badge-active">ACTIVE</span>' : ""}
      </td>
      <td><code>${escapeHtml(c.database)}</code></td>
      <td>${c.embedded ? "<em>embedded</em>" : escapeHtml(c.host || "localhost")}</td>
      <td>
        <div id="status-${c.id}" style="min-width: 110px;">
          <button class="btn btn-sm btn-secondary" onclick="testConnection('${c.id}')">⚡ Test Ping</button>
        </div>
      </td>
      <td style="text-align: right; display: flex; gap: 6px; justify-content: flex-end;">
        <button class="btn btn-sm btn-secondary" onclick="setActive('${c.id}')">Set Active</button>
        <button class="btn btn-sm" onclick="openQueryForConnection('${c.id}')">New Query</button>
      </td>
    </tr>
  `).join("");

  return `
    <table class="conn-table">
      <thead>
        <tr>
          <th>Connection</th>
          <th>Database</th>
          <th>Host</th>
          <th>Health</th>
          <th style="text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function renderSampleQueries(): string {
  return SAMPLE_EMPLOYEE_QUERIES.map((q, idx) => `
    <div class="query-item">
      <div class="query-header">
        <div>
          <span class="query-title">${escapeHtml(q.title)}</span>
          <span class="query-desc"> — ${escapeHtml(q.description)}</span>
        </div>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-sm btn-secondary" onclick="copySampleQuery(${idx})">📋 Copy</button>
          <button class="btn btn-sm" onclick="runSampleQuery(${idx})">▶ Run Query</button>
        </div>
      </div>
      <pre class="code-block">${escapeHtml(q.sql)}</pre>
    </div>
  `).join("");
}

function escapeHtml(text: string): string {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let activeHubPanel: WebviewPanel | undefined;

export async function showGettingStartedHub(context: ExtensionContext): Promise<WebviewPanel> {
  if (activeHubPanel) {
    activeHubPanel.reveal(ViewColumn.Active);
    return activeHubPanel;
  }

  const panel = window.createWebviewPanel(
    "firebirdGettingStartedHub",
    "Firebird Studio: Getting Started",
    ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [Uri.file(path.join(context.extensionPath, "resources"))]
    }
  );

  activeHubPanel = panel;
  panel.onDidDispose(() => {
    activeHubPanel = undefined;
  });

  const state = await fetchGettingStartedState(context);
  panel.webview.html = buildGettingStartedHtml(state, panel.webview.cspSource);

  panel.webview.onDidReceiveMessage(async (msg: any) => {
    try {
      switch (msg.command) {
        case "refresh": {
          const refreshed = await fetchGettingStartedState(context);
          panel.webview.html = buildGettingStartedHtml(refreshed, panel.webview.cspSource);
          break;
        }
        case "addConnection": {
          await commands.executeCommand("firebird.explorer.addConnection");
          const refreshed = await fetchGettingStartedState(context);
          panel.webview.html = buildGettingStartedHtml(refreshed, panel.webview.cspSource);
          break;
        }
        case "newSqlDocument": {
          await commands.executeCommand("firebird.explorer.newSqlDocument");
          break;
        }
        case "openNotebook": {
          const doc = await workspace.openNotebookDocument("firebird-notebook", {
            cells: [{ kind: 2, value: "-- Firebird Notebook\nSELECT * FROM RDB$DATABASE;", languageId: "firebird" }]
          });
          await window.showNotebookDocument(doc);
          break;
        }
        case "openSchemaDesigner": {
          await commands.executeCommand("firebird.schemaVisualizer.open");
          break;
        }
        case "openWalkthrough": {
          await commands.executeCommand("workbench.action.openWalkthrough", "AdrianMariusPopa.vscode-firebird-studio#firebirdGettingStarted");
          break;
        }
        case "openDocumentation": {
          await env.openExternal(Uri.parse("https://firebirdsql.org/en/documentation/"));
          break;
        }
        case "openCopilotInstructions": {
          await commands.executeCommand("workbench.action.quickOpen", "@firebird");
          break;
        }
        case "createContainer": {
          await commands.executeCommand("firebird.explorer.createContainer");
          const refreshed = await fetchGettingStartedState(context);
          panel.webview.html = buildGettingStartedHtml(refreshed, panel.webview.cspSource);
          break;
        }
        case "addSampleConnection": {
          await addSampleEmployeeConnection(context);
          window.showInformationMessage("Added Employee sample database connection (localhost:3050/employee).");
          const refreshed = await fetchGettingStartedState(context);
          panel.webview.html = buildGettingStartedHtml(refreshed, panel.webview.cspSource);
          break;
        }
        case "copyText": {
          if (typeof msg.text === "string") {
            await env.clipboard.writeText(msg.text);
            window.showInformationMessage("Copied to clipboard.");
          }
          break;
        }
        case "testConnection": {
          const id = msg.connectionId;
          const conn = await Global.getConnectionById(id);
          if (!conn) {
            panel.webview.postMessage({
              command: "testResult",
              connectionId: id,
              result: { success: false, error: "Connection not found" }
            });
            return;
          }
          const result = await testConnectionPing(conn);
          panel.webview.postMessage({
            command: "testResult",
            connectionId: id,
            result
          });
          break;
        }
        case "setActiveConnection": {
          const id = msg.connectionId;
          await Global.setActiveConnectionById(context, id);
          panel.webview.postMessage({
            command: "connectionActivated",
            connectionId: id
          });
          break;
        }
        case "openQuery": {
          const doc = await workspace.openTextDocument({
            language: "sql",
            content: msg.sql ?? "-- Write Firebird SQL here\n"
          });
          if (msg.connectionId) {
            const conn = await Global.getConnectionById(msg.connectionId);
            if (conn) {
              Global.setEditorConnection(doc.uri.toString(), conn);
            }
          }
          await window.showTextDocument(doc);
          break;
        }
      }
    } catch (err: any) {
      logger.error(`GettingStartedHub message handling failed: ${err?.message ?? err}`);
    }
  });

  return panel;
}
