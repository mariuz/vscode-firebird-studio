import * as net from "net";
import * as dns from "dns";
import * as fs from "fs";
import { window, workspace, commands, ProgressLocation } from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "./driver";
import { logger } from "../logger/logger";
import { getConnectionLabel } from "./utils";
import { getOptions } from "../config";

export type DiagnosticStepStatus = "ok" | "warn" | "fail" | "skipped";

export interface DiagnosticStepResult {
  step: string;
  label: string;
  status: DiagnosticStepStatus;
  durationMs: number;
  details: string;
  error?: string;
  troubleshooting?: string[];
}

export interface DiagnosticReport {
  connectionId: string;
  connectionLabel: string;
  timestamp: string;
  isEmbedded: boolean;
  totalDurationMs: number;
  success: boolean;
  hasWarnings: boolean;
  steps: DiagnosticStepResult[];
  summary: string;
  recommendations: string[];
}

export interface DiagnosticProbes {
  lookupDns?: (host: string) => Promise<{ address: string; family: number }>;
  connectTcp?: (host: string, port: number, timeoutMs: number) => Promise<{ latencyMs: number }>;
  checkFile?: (filePath: string) => Promise<{ exists: boolean; sizeBytes?: number; readable: boolean; writable: boolean; error?: string }>;
  createConnection?: (options: ConnectionOptions) => Promise<any>;
  executeQuery?: (connection: any, sql: string) => Promise<any[]>;
  detachConnection?: (connection: any) => Promise<void>;
  getEngineVersion?: (connection: any) => Promise<string | undefined>;
  now?: () => number;
}

/** Analyzes DNS errors and returns actionable troubleshooting suggestions. */
export function analyzeDnsError(err: any, host: string): string[] {
  const code = err?.code || "";
  const suggestions: string[] = [
    `Hostname "${host}" could not be resolved (${code || err?.message || "DNS error"}).`,
    `Verify the spelling of host "${host}".`,
    `If connecting to a corporate intranet or private VPC host, ensure your VPN or local DNS server is active.`,
    `Consider using the server's numeric IP address (e.g. 192.168.x.x) directly instead of the hostname.`,
  ];
  return suggestions;
}

/** Analyzes TCP socket connection errors and returns actionable troubleshooting suggestions. */
export function analyzeTcpError(err: any, host: string, port: number): string[] {
  const code = err?.code || "";
  const suggestions: string[] = [];

  if (code === "ECONNREFUSED") {
    suggestions.push(
      `Connection refused on port ${port}. The Firebird Server service is either not running on "${host}" or not listening on port ${port}.`,
      `Verify Firebird is running: check "systemctl status firebird" on Linux or the "Firebird Server" service on Windows.`,
      `Verify RemoteServiceName or RemoteServicePort in firebird.conf (default port is 3050).`,
      `Check firewall rules (e.g. ufw, iptables, Windows Defender Firewall) allowing incoming TCP traffic on port ${port}.`
    );
  } else if (code === "ETIMEDOUT") {
    suggestions.push(
      `TCP connection timed out connecting to ${host}:${port}. Packets may be dropped by a network firewall or security group.`,
      `If hosted on AWS, Azure, or GCP, ensure the Security Group or Network ACL allows inbound TCP on port ${port}.`,
      `Verify network routing or VPN connectivity between your machine and "${host}".`
    );
  } else if (code === "ENETUNREACH" || code === "EHOSTUNREACH") {
    suggestions.push(
      `Host or network unreachable for "${host}". Verify your local network connection and routing table.`
    );
  } else {
    suggestions.push(
      `Could not establish TCP connection to ${host}:${port}: ${err?.message || String(err)}.`,
      `Ensure port ${port} is open and reachable from your network.`
    );
  }

  return suggestions;
}

/** Analyzes Firebird wire protocol and authentication errors and returns troubleshooting suggestions. */
export function analyzeAuthError(err: any, options: ConnectionOptions): string[] {
  const msg = (err?.message || String(err)).toLowerCase();
  const suggestions: string[] = [];

  if (
    msg.includes("user name and password are not defined") ||
    msg.includes("password") ||
    msg.includes("authentication") ||
    msg.includes("335544721") ||
    msg.includes("login failed")
  ) {
    suggestions.push(
      `Authentication failed for user "${options.user}". Ensure the password is correct.`,
      `Use "Set Connection Password..." on the database node in Object Explorer to re-enter the password.`,
      `For Firebird 3.0+, verify user exists in the security database (securityN.fdb).`,
      `Check AuthServer and AuthClient plugins in firebird.conf (e.g. Srp256, Srp, Legacy_Auth).`
    );
  } else if (msg.includes("wire crypt") || msg.includes("encryption") || msg.includes("wirecrypt")) {
    suggestions.push(
      `Wire encryption negotiation failed. Try adjusting "Wire Encryption" to "Enabled", "Disabled", or "Required" in Connection Options.`,
      `Firebird 2.5 and legacy servers do not support wire encryption and require WireCrypt = Disabled.`
    );
  } else if (
    msg.includes("cannot attach") ||
    msg.includes("not a valid database") ||
    msg.includes("i/o error") ||
    msg.includes("createfile") ||
    msg.includes("335544344") ||
    msg.includes("operating system directive")
  ) {
    suggestions.push(
      `The Firebird server could not open database "${options.database}".`,
      `Note: For network connections, "${options.database}" must exist on the SERVER filesystem, not your local machine.`,
      `Verify the database file path is correct on the server host.`,
      `Ensure the Firebird daemon user (e.g. 'firebird') has read and write permissions on "${options.database}" and its parent directory.`
    );
  } else if (msg.includes("native driver") || msg.includes("embedded")) {
    suggestions.push(
      `Embedded database connections require the native driver. Enable "firebird.useNativeDriver" in VS Code settings.`,
      `Run command "Firebird: Build Native Driver" if native client libraries need compilation.`
    );
  } else {
    suggestions.push(
      `Attachment to Firebird failed: ${err?.message || String(err)}.`,
      `Check the server log (firebird.log) on the host machine for internal diagnostic messages.`
    );
  }

  return suggestions;
}

/** Analyzes local filesystem errors for embedded databases. */
export function analyzeFileError(err: any, filePath: string): string[] {
  const suggestions: string[] = [
    `Local database file error for path "${filePath}".`,
    `Verify the file exists. If using a relative path, ensure it is relative to the active workspace folder.`,
    `Ensure your user account has read and write permissions for the database file and directory.`,
  ];
  return suggestions;
}

/** Executes step-by-step connection diagnostics and returns a structured report. */
export async function runConnectionDiagnostics(
  options: ConnectionOptions,
  probes?: DiagnosticProbes,
  onProgress?: (message: string) => void
): Promise<DiagnosticReport> {
  const getTime = probes?.now ?? Date.now;
  const label = getConnectionLabel(options);
  const isEmbedded = Boolean(options.embedded);
  const steps: DiagnosticStepResult[] = [];
  const recommendations: string[] = [];

  const addStep = (result: DiagnosticStepResult) => {
    steps.push(result);
    if (result.troubleshooting && result.troubleshooting.length > 0) {
      for (const t of result.troubleshooting) {
        if (!recommendations.includes(t)) {
          recommendations.push(t);
        }
      }
    }
  };

  const markSkipped = (step: string, label: string, reason: string) => {
    addStep({
      step,
      label,
      status: "skipped",
      durationMs: 0,
      details: reason,
    });
  };

  // ───────────────────────────────────────────────────────────────────────────
  // EMBEDDED DATABASE PATH
  // ───────────────────────────────────────────────────────────────────────────
  if (isEmbedded) {
    // Phase 1: Database File Check
    onProgress?.("Verifying local database file accessibility...");
    const filePath = options.database;
    const fileStart = getTime();

    let fileAccessible = false;
    try {
      if (probes?.checkFile) {
        const fileCheck = await probes.checkFile(filePath);
        const fileDuration = getTime() - fileStart;
        if (!fileCheck.exists) {
          addStep({
            step: "file",
            label: "Database File Accessibility",
            status: "fail",
            durationMs: fileDuration,
            details: `Database file does not exist at "${filePath}".`,
            error: fileCheck.error || "File does not exist",
            troubleshooting: analyzeFileError(fileCheck.error, filePath),
          });
        } else if (!fileCheck.readable || !fileCheck.writable) {
          addStep({
            step: "file",
            label: "Database File Accessibility",
            status: "fail",
            durationMs: fileDuration,
            details: `Permission denied reading or writing "${filePath}".`,
            error: "Read/write permission denied",
            troubleshooting: analyzeFileError("Permission denied", filePath),
          });
        } else {
          fileAccessible = true;
          const sizeMb = fileCheck.sizeBytes ? (fileCheck.sizeBytes / (1024 * 1024)).toFixed(2) + " MB" : "accessible";
          addStep({
            step: "file",
            label: "Database File Accessibility",
            status: "ok",
            durationMs: fileDuration,
            details: `Verified database file (${sizeMb}, read/write ok) in ${fileDuration}ms.`,
          });
        }
      } else {
        if (!fs.existsSync(filePath)) {
          const fileDuration = getTime() - fileStart;
          addStep({
            step: "file",
            label: "Database File Accessibility",
            status: "fail",
            durationMs: fileDuration,
            details: `Database file does not exist at "${filePath}".`,
            error: "ENOENT: file not found",
            troubleshooting: analyzeFileError("ENOENT", filePath),
          });
        } else {
          fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
          const stat = fs.statSync(filePath);
          const fileDuration = getTime() - fileStart;
          const sizeMb = (stat.size / (1024 * 1024)).toFixed(2) + " MB";
          fileAccessible = true;
          addStep({
            step: "file",
            label: "Database File Accessibility",
            status: "ok",
            durationMs: fileDuration,
            details: `Verified database file (${sizeMb}, read/write ok) in ${fileDuration}ms.`,
          });
        }
      }
    } catch (err: any) {
      const fileDuration = getTime() - fileStart;
      addStep({
        step: "file",
        label: "Database File Accessibility",
        status: "fail",
        durationMs: fileDuration,
        details: `Cannot access database file at "${filePath}": ${err?.message || String(err)}.`,
        error: err?.message || String(err),
        troubleshooting: analyzeFileError(err, filePath),
      });
    }

    if (!fileAccessible) {
      markSkipped("native_driver", "Native Driver Verification", "Skipped due to database file check failure.");
      markSkipped("auth", "Engine Attachment", "Skipped due to database file check failure.");
      markSkipped("ping", "Query Ping (SELECT 1)", "Skipped due to database file check failure.");
      return finalizeReport(options, label, isEmbedded, steps, recommendations, getTime);
    }

    // Phase 2: Native Driver Check
    onProgress?.("Verifying native driver configuration...");
    const useNative = getOptions().useNativeDriver;
    if (!useNative && !probes?.createConnection) {
      addStep({
        step: "native_driver",
        label: "Native Driver Verification",
        status: "fail",
        durationMs: 0,
        details: `Embedded connections require the native driver, but "firebird.useNativeDriver" is disabled.`,
        error: "Native driver disabled",
        troubleshooting: [
          `Enable "firebird.useNativeDriver" in VS Code settings to connect to embedded databases.`,
          `Embedded databases require the native C client library and cannot be attached via the pure-JS wire driver.`,
        ],
      });
      markSkipped("auth", "Engine Attachment", "Skipped because native driver is disabled.");
      markSkipped("ping", "Query Ping (SELECT 1)", "Skipped because native driver is disabled.");
      return finalizeReport(options, label, isEmbedded, steps, recommendations, getTime);
    } else {
      addStep({
        step: "native_driver",
        label: "Native Driver Verification",
        status: "ok",
        durationMs: 0,
        details: "Native driver configuration enabled.",
      });
    }

    // Phase 3 & 4: Engine Attachment & Query Ping
    await runAuthAndPing(options, steps, probes, onProgress, getTime, addStep, markSkipped);
    return finalizeReport(options, label, isEmbedded, steps, recommendations, getTime);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // NETWORK DATABASE PATH
  // ───────────────────────────────────────────────────────────────────────────
  const host = options.host || "localhost";
  const port = Number(options.port) || 3050;

  // Phase 1: DNS Resolution
  onProgress?.(`Resolving host "${host}"...`);
  const dnsStart = getTime();
  let dnsOk = false;

  if (net.isIP(host)) {
    dnsOk = true;
    addStep({
      step: "dns",
      label: "DNS Resolution",
      status: "ok",
      durationMs: 0,
      details: `Host "${host}" is a numeric IP address (IPv${net.isIP(host)}), DNS lookup bypassed.`,
    });
  } else {
    try {
      const res = probes?.lookupDns ? await probes.lookupDns(host) : await dns.promises.lookup(host);
      const dnsDuration = getTime() - dnsStart;
      const isSlow = dnsDuration > 1000;
      dnsOk = true;
      addStep({
        step: "dns",
        label: "DNS Resolution",
        status: isSlow ? "warn" : "ok",
        durationMs: dnsDuration,
        details: `Resolved "${host}" to ${res.address} (IPv${res.family}) in ${dnsDuration}ms.`,
        troubleshooting: isSlow
          ? [`DNS resolution took ${dnsDuration}ms (> 1000ms). Consider verifying DNS server responsiveness or adding a hosts entry.`]
          : undefined,
      });
    } catch (err: any) {
      const dnsDuration = getTime() - dnsStart;
      addStep({
        step: "dns",
        label: "DNS Resolution",
        status: "fail",
        durationMs: dnsDuration,
        details: `Failed to resolve hostname "${host}".`,
        error: err?.message || String(err),
        troubleshooting: analyzeDnsError(err, host),
      });
    }
  }

  if (!dnsOk) {
    markSkipped("tcp", `TCP Port Check (${port})`, "Skipped due to DNS resolution failure.");
    if (options.sshTunnel) {
      markSkipped("ssh_bastion", "SSH Bastion Reachability", "Skipped due to DNS resolution failure.");
    }
    markSkipped("auth", "Wire Protocol & Authentication", "Skipped due to DNS resolution failure.");
    markSkipped("ping", "Query Ping (SELECT 1)", "Skipped due to DNS resolution failure.");
    return finalizeReport(options, label, isEmbedded, steps, recommendations, getTime);
  }

  // Phase 2: TCP Port Reachability
  onProgress?.(`Testing TCP socket connection to ${host}:${port}...`);
  const tcpStart = getTime();
  let tcpOk = false;

  try {
    let tcpDuration = 0;
    if (probes?.connectTcp) {
      const res = await probes.connectTcp(host, port, 5000);
      tcpDuration = res.latencyMs;
    } else {
      tcpDuration = await new Promise<number>((resolve, reject) => {
        const socket = new net.Socket();
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            socket.destroy();
            const err: any = new Error(`TCP connection timed out after 5000ms`);
            err.code = "ETIMEDOUT";
            reject(err);
          }
        }, 5000);

        socket.connect(port, host, () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const elapsed = getTime() - tcpStart;
            socket.end();
            resolve(elapsed);
          }
        });

        socket.on("error", (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(err);
          }
        });
      });
    }

    const isSlow = tcpDuration > 500;
    tcpOk = true;
    addStep({
      step: "tcp",
      label: `TCP Port Check (${port})`,
      status: isSlow ? "warn" : "ok",
      durationMs: tcpDuration,
      details: `Established TCP connection to ${host}:${port} in ${tcpDuration}ms.`,
      troubleshooting: isSlow
        ? [`High TCP round-trip latency (${tcpDuration}ms > 500ms). Expect slow query response times.`]
        : undefined,
    });
  } catch (err: any) {
    const tcpDuration = getTime() - tcpStart;
    addStep({
      step: "tcp",
      label: `TCP Port Check (${port})`,
      status: "fail",
      durationMs: tcpDuration,
      details: `Could not connect to TCP port ${port} on "${host}".`,
      error: err?.message || String(err),
      troubleshooting: analyzeTcpError(err, host, port),
    });
  }

  if (!tcpOk) {
    if (options.sshTunnel) {
      markSkipped("ssh_bastion", "SSH Bastion Reachability", "Skipped due to direct TCP connectivity failure.");
    }
    markSkipped("auth", "Wire Protocol & Authentication", `Skipped due to TCP connectivity failure on port ${port}.`);
    markSkipped("ping", "Query Ping (SELECT 1)", `Skipped due to TCP connectivity failure on port ${port}.`);
    return finalizeReport(options, label, isEmbedded, steps, recommendations, getTime);
  }

  // Phase 2b: SSH Bastion Reachability (if configured)
  if (options.sshTunnel) {
    const sshHost = options.sshTunnel.host;
    const sshPort = options.sshTunnel.port || 22;
    onProgress?.(`Testing SSH bastion reachability to ${sshHost}:${sshPort}...`);
    const sshStart = getTime();

    try {
      let sshDuration = 0;
      if (probes?.connectTcp) {
        const res = await probes.connectTcp(sshHost, sshPort, 5000);
        sshDuration = res.latencyMs;
      } else {
        sshDuration = await new Promise<number>((resolve, reject) => {
          const socket = new net.Socket();
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              socket.destroy();
              const err: any = new Error(`SSH connection timed out after 5000ms`);
              err.code = "ETIMEDOUT";
              reject(err);
            }
          }, 5000);

          socket.connect(sshPort, sshHost, () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              const elapsed = getTime() - sshStart;
              socket.end();
              resolve(elapsed);
            }
          });

          socket.on("error", (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              socket.destroy();
              reject(err);
            }
          });
        });
      }

      addStep({
        step: "ssh_bastion",
        label: `SSH Bastion Reachability (${sshHost}:${sshPort})`,
        status: "ok",
        durationMs: sshDuration,
        details: `SSH bastion reachable on port ${sshPort} in ${sshDuration}ms.`,
      });
    } catch (err: any) {
      const sshDuration = getTime() - sshStart;
      addStep({
        step: "ssh_bastion",
        label: `SSH Bastion Reachability (${sshHost}:${sshPort})`,
        status: "fail",
        durationMs: sshDuration,
        details: `Failed to connect to SSH bastion ${sshHost}:${sshPort}.`,
        error: err?.message || String(err),
        troubleshooting: [
          `Could not connect to SSH bastion host "${sshHost}" on port ${sshPort}.`,
          `Verify bastion hostname and SSH port configuration.`,
          `Ensure firewall rules permit outbound SSH connections on port ${sshPort}.`,
        ],
      });
      markSkipped("auth", "Wire Protocol & Authentication", "Skipped due to SSH bastion connectivity failure.");
      markSkipped("ping", "Query Ping (SELECT 1)", "Skipped due to SSH bastion connectivity failure.");
      return finalizeReport(options, label, isEmbedded, steps, recommendations, getTime);
    }
  }

  // Phase 3 & 4: Wire Protocol & Authentication Handshake + Query Ping
  await runAuthAndPing(options, steps, probes, onProgress, getTime, addStep, markSkipped);
  return finalizeReport(options, label, isEmbedded, steps, recommendations, getTime);
}

/** Helper running attachment and ping query steps. */
async function runAuthAndPing(
  options: ConnectionOptions,
  steps: DiagnosticStepResult[],
  probes: DiagnosticProbes | undefined,
  onProgress: ((msg: string) => void) | undefined,
  getTime: () => number,
  addStep: (s: DiagnosticStepResult) => void,
  markSkipped: (step: string, label: string, reason: string) => void
): Promise<void> {
  onProgress?.("Performing Firebird wire authentication handshake...");
  const authStart = getTime();
  let conn: any;

  try {
    conn = probes?.createConnection
      ? await probes.createConnection(options)
      : await Driver.client.createConnection(options);
    const authDuration = getTime() - authStart;
    const isSlow = authDuration > 1500;

    addStep({
      step: "auth",
      label: options.embedded ? "Engine Attachment" : "Wire Protocol & Authentication",
      status: isSlow ? "warn" : "ok",
      durationMs: authDuration,
      details: `Successfully attached to database as user "${options.user || "SYSDBA"}" in ${authDuration}ms.`,
      troubleshooting: isSlow
        ? [`Authentication handshake took ${authDuration}ms (> 1500ms). Server may be under load or negotiating multiple auth plugins.`]
        : undefined,
    });
  } catch (err: any) {
    const authDuration = getTime() - authStart;
    addStep({
      step: "auth",
      label: options.embedded ? "Engine Attachment" : "Wire Protocol & Authentication",
      status: "fail",
      durationMs: authDuration,
      details: `Attachment to Firebird failed.`,
      error: err?.message || String(err),
      troubleshooting: analyzeAuthError(err, options),
    });
    markSkipped("ping", "Query Ping (SELECT 1)", "Skipped due to attachment failure.");
    return;
  }

  // Phase: Query Ping
  onProgress?.("Sending query ping (SELECT 1 FROM RDB$DATABASE)...");
  const pingStart = getTime();
  try {
    const pingSql = "SELECT 1 FROM RDB$DATABASE";
    if (probes?.executeQuery) {
      await probes.executeQuery(conn, pingSql);
    } else {
      await Driver.client.queryPromise(conn, pingSql);
    }

    let engineVersion: string | undefined;
    if (probes?.getEngineVersion) {
      engineVersion = await probes.getEngineVersion(conn).catch(() => undefined);
    } else {
      try {
        const verRows = await Driver.client.queryPromise<any>(
          conn,
          "SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS VER FROM RDB$DATABASE"
        );
        if (verRows && verRows.length > 0 && verRows[0]?.VER) {
          engineVersion = String(verRows[0].VER).trim();
        }
      } catch {
        // RDB$GET_CONTEXT engine version not available on older Firebird; safe to ignore
      }
    }

    const pingDuration = getTime() - pingStart;
    const isSlow = pingDuration > 500;
    const verDetail = engineVersion ? ` (Engine version: Firebird ${engineVersion})` : "";

    addStep({
      step: "ping",
      label: "Query Ping (SELECT 1)",
      status: isSlow ? "warn" : "ok",
      durationMs: pingDuration,
      details: `Executed ping query "SELECT 1 FROM RDB$DATABASE" in ${pingDuration}ms${verDetail}.`,
      troubleshooting: isSlow
        ? [`Query ping latency is elevated (${pingDuration}ms > 500ms).`]
        : undefined,
    });
  } catch (err: any) {
    const pingDuration = getTime() - pingStart;
    addStep({
      step: "ping",
      label: "Query Ping (SELECT 1)",
      status: "fail",
      durationMs: pingDuration,
      details: `Query ping failed: ${err?.message || String(err)}.`,
      error: err?.message || String(err),
      troubleshooting: [
        `Connection was established, but query ping failed: ${err?.message || String(err)}.`,
        `Check if transaction or query permissions are restricted.`,
      ],
    });
  } finally {
    try {
      if (probes?.detachConnection) {
        await probes.detachConnection(conn);
      } else if (conn) {
        await Driver.client.detach(conn);
      }
    } catch (detachErr) {
      logger.debug("Error detaching diagnostic connection: " + detachErr);
    }
  }
}

/** Assembles and finalizes the diagnostic report. */
function finalizeReport(
  options: ConnectionOptions,
  label: string,
  isEmbedded: boolean,
  steps: DiagnosticStepResult[],
  recommendations: string[],
  getTime: () => number
): DiagnosticReport {
  const totalDurationMs = steps.reduce((sum, s) => sum + (s.status !== "skipped" ? s.durationMs : 0), 0);
  const hasFailures = steps.some((s) => s.status === "fail");
  const hasWarnings = steps.some((s) => s.status === "warn");
  const success = !hasFailures;

  let summary = "";
  if (success) {
    const passedCount = steps.filter((s) => s.status === "ok" || s.status === "warn").length;
    if (hasWarnings) {
      summary = `Connection succeeded with latency warnings: ${passedCount}/${steps.length} checks passed (${totalDurationMs}ms total latency).`;
    } else {
      summary = `All ${passedCount} connectivity checks passed successfully (${totalDurationMs}ms total latency).`;
    }
  } else {
    const failedStep = steps.find((s) => s.status === "fail");
    summary = `Connection failed at "${failedStep?.label || "probe"}": ${failedStep?.error || "error"}.`;
  }

  const d = new Date(getTime());
  const timestamp = d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

  return {
    connectionId: options.id,
    connectionLabel: label,
    timestamp,
    isEmbedded,
    totalDurationMs,
    success,
    hasWarnings,
    steps,
    summary,
    recommendations,
  };
}

/** Formats duration into a readable string (e.g. "12ms" or "1.2s"). */
function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${ms}ms`;
}

/** Renders a full GitHub-flavored Markdown report from the diagnostic results. */
export function renderDiagnosticsMarkdown(report: DiagnosticReport): string {
  const lines: string[] = [];

  const statusBadge = report.success
    ? report.hasWarnings
      ? "⚠️ **Warning** (High Latency Detected)"
      : "✅ **Healthy** (All Checks Passed)"
    : "❌ **Failed** (Connection Issue)";

  lines.push("# 🩺 Firebird Connection Diagnostics");
  lines.push("");
  lines.push(`**Target Connection:** \`${report.connectionLabel}\``);
  lines.push(`**Connection Type:** \`${report.isEmbedded ? "Embedded (Local File)" : "Network (TCP Wire Protocol)"}\``);
  lines.push(`**Report Timestamp:** \`${report.timestamp}\``);
  lines.push(`**Overall Status:** ${statusBadge}`);
  lines.push(`**Total Latency:** \`${formatDuration(report.totalDurationMs)}\``);
  lines.push("");

  if (report.success && !report.hasWarnings) {
    lines.push("> [!NOTE]");
    lines.push(`> ✅ **Connection is fully operational.** Firebird server is responsive and all diagnostic phases passed without errors (${formatDuration(report.totalDurationMs)} total latency).`);
  } else if (report.success && report.hasWarnings) {
    lines.push("> [!WARNING]");
    lines.push(`> ⚠️ **Connection succeeded, but elevated latency was detected.** Review the latency breakdown below to identify potential network or server bottlenecks.`);
  } else {
    lines.push("> [!CAUTION]");
    lines.push(`> ❌ **Connection check failed.** One or more essential phases could not complete. See the troubleshooting guidance below to resolve the issue.`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Latency Breakdown Table ────────────────────────────────────────────────
  lines.push("## ⏱️ Latency & Phase Breakdown");
  lines.push("");
  lines.push("| Phase | Status | Latency | Share | Details |");
  lines.push("| :--- | :---: | :---: | :---: | :--- |");

  for (const s of report.steps) {
    let icon = "⚪";
    let statusText = "Skipped";
    if (s.status === "ok") {
      icon = "✅";
      statusText = "Passed";
    } else if (s.status === "warn") {
      icon = "⚠️";
      statusText = "Warning";
    } else if (s.status === "fail") {
      icon = "❌";
      statusText = "Failed";
    }

    const share =
      report.totalDurationMs > 0 && s.status !== "skipped"
        ? `${Math.round((s.durationMs / report.totalDurationMs) * 100)}%`
        : "-";

    const latencyText = s.status === "skipped" ? "-" : formatDuration(s.durationMs);
    lines.push(`| **${s.label}** | ${icon} ${statusText} | ${latencyText} | ${share} | ${s.details} |`);
  }
  lines.push("");

  // Latency text visual bar
  const activeSteps = report.steps.filter((s) => s.status !== "skipped" && s.durationMs > 0);
  if (activeSteps.length > 0) {
    const barParts = activeSteps.map((s) => {
      const pct = report.totalDurationMs > 0 ? Math.round((s.durationMs / report.totalDurationMs) * 100) : 0;
      return `${s.label.split(" ")[0]}: ${formatDuration(s.durationMs)} (${pct}%)`;
    });
    lines.push("```");
    lines.push(barParts.join("  |  "));
    lines.push(`Total Measured Latency: ${formatDuration(report.totalDurationMs)}`);
    lines.push("```");
    lines.push("");
  }

  // ── Phase Details ──────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 🔍 Detailed Diagnostic Findings");
  lines.push("");

  report.steps.forEach((s, idx) => {
    lines.push(`### ${idx + 1}. ${s.label}`);
    lines.push(`- **Status:** \`${s.status.toUpperCase()}\``);
    if (s.status !== "skipped") {
      lines.push(`- **Duration:** \`${formatDuration(s.durationMs)}\``);
    }
    lines.push(`- **Details:** ${s.details}`);
    if (s.error) {
      lines.push(`- **Error Message:** \`${s.error}\``);
    }
    lines.push("");
  });

  // ── Recommendations & Troubleshooting ──────────────────────────────────────
  if (report.recommendations.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## 🛠️ Actionable Recommendations & Troubleshooting");
    lines.push("");
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by Firebird Studio for VS Code — Connection Diagnostics Tool*");
  lines.push("");

  return lines.join("\n");
}

/**
 * Interactive command runner that probes the connection with user-facing progress
 * notifications and opens the generated Markdown report upon completion.
 */
export async function showConnectionDiagnostics(
  options: ConnectionOptions,
  probes?: DiagnosticProbes
): Promise<DiagnosticReport> {
  const label = getConnectionLabel(options);

  return await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: `Diagnosing connection to ${label}...`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Starting connection diagnostics..." });

      const report = await runConnectionDiagnostics(options, probes, (msg) => {
        progress.report({ message: msg });
      });

      const totalMs = report.totalDurationMs;
      const passedCount = report.steps.filter((s) => s.status === "ok" || s.status === "warn").length;
      const totalCount = report.steps.filter((s) => s.status !== "skipped").length;

      let action: string | undefined;
      if (report.success) {
        const warnText = report.hasWarnings ? " (with latency warnings)" : "";
        action = await window.showInformationMessage(
          `Connection diagnostics succeeded${warnText}: ${passedCount}/${totalCount} checks passed (${formatDuration(totalMs)} total latency).`,
          "View Full Report"
        );
      } else {
        const failedStep = report.steps.find((s) => s.status === "fail");
        action = await window.showErrorMessage(
          `Connection diagnostics failed at "${failedStep?.label || "probe"}": ${failedStep?.error || "connection error"}.`,
          "View Diagnostic Report"
        );
      }

      if (action === "View Full Report" || action === "View Diagnostic Report") {
        const markdown = renderDiagnosticsMarkdown(report);
        const doc = await workspace.openTextDocument({
          content: markdown,
          language: "markdown",
        });
        try {
          await commands.executeCommand("markdown.showPreviewToSide", doc.uri);
        } catch {
          await window.showTextDocument(doc);
        }
      }

      return report;
    }
  );
}
