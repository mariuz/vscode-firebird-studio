import * as assert from "assert";
import {
  runConnectionDiagnostics,
  renderDiagnosticsMarkdown,
  showConnectionDiagnostics,
  analyzeDnsError,
  analyzeTcpError,
  analyzeAuthError,
  analyzeFileError,
  DiagnosticReport,
  DiagnosticProbes,
} from "../shared/connection-diagnostics";
import { ConnectionOptions } from "../interfaces";

function createTestConn(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    id: "test-conn-1",
    host: "db.example.com",
    port: 3050,
    database: "/var/lib/firebird/data/test.fdb",
    user: "SYSDBA",
    role: null,
    ...overrides,
  };
}

suite("Connection Diagnostics – runConnectionDiagnostics", function () {
  test("successful network connection runs all 4 phases and returns healthy report", async function () {
    const conn = createTestConn();
    let detached = false;

    const probes: DiagnosticProbes = {
      lookupDns: async (host) => {
        assert.strictEqual(host, "db.example.com");
        return { address: "192.168.1.50", family: 4 };
      },
      connectTcp: async (host, port) => {
        assert.strictEqual(host, "db.example.com");
        assert.strictEqual(port, 3050);
        return { latencyMs: 20 };
      },
      createConnection: async (_opts) => {
        return { isFakeDb: true };
      },
      executeQuery: async (_conn, sql) => {
        assert.strictEqual(sql, "SELECT 1 FROM RDB$DATABASE");
        return [{ 1: 1 }];
      },
      getEngineVersion: async () => "5.0.1",
      detachConnection: async () => {
        detached = true;
      },
      now: (() => {
        let t = 1000;
        return () => {
          t += 10;
          return t;
        };
      })(),
    };

    const progressMessages: string[] = [];
    const report = await runConnectionDiagnostics(conn, probes, (msg) => progressMessages.push(msg));

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.hasWarnings, false);
    assert.strictEqual(report.connectionId, "test-conn-1");
    assert.strictEqual(report.isEmbedded, false);
    assert.strictEqual(detached, true, "Connection must be detached cleanly");

    // 4 phases for standard network connection: dns, tcp, auth, ping
    assert.strictEqual(report.steps.length, 4);
    assert.strictEqual(report.steps[0].step, "dns");
    assert.strictEqual(report.steps[0].status, "ok");
    assert.strictEqual(report.steps[1].step, "tcp");
    assert.strictEqual(report.steps[1].status, "ok");
    assert.strictEqual(report.steps[2].step, "auth");
    assert.strictEqual(report.steps[2].status, "ok");
    assert.strictEqual(report.steps[3].step, "ping");
    assert.strictEqual(report.steps[3].status, "ok");
    assert.ok(report.steps[3].details.includes("Firebird 5.0.1"));

    assert.ok(report.summary.includes("All 4 connectivity checks passed"));
    assert.ok(progressMessages.length >= 4);
  });

  test("numeric IP address bypasses DNS lookup cleanly", async function () {
    const conn = createTestConn({ host: "127.0.0.1" });
    let dnsCalled = false;

    const probes: DiagnosticProbes = {
      lookupDns: async () => {
        dnsCalled = true;
        return { address: "127.0.0.1", family: 4 };
      },
      connectTcp: async () => ({ latencyMs: 5 }),
      createConnection: async () => ({}),
      executeQuery: async () => [{ 1: 1 }],
      detachConnection: async () => {},
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(dnsCalled, false, "DNS lookup must be bypassed for numeric IP");
    assert.strictEqual(report.steps[0].step, "dns");
    assert.strictEqual(report.steps[0].status, "ok");
    assert.strictEqual(report.steps[0].durationMs, 0);
    assert.ok(report.steps[0].details.includes("numeric IP"));
  });

  test("DNS resolution failure skips downstream steps and flags failure with guidance", async function () {
    const conn = createTestConn({ host: "invalid.nonexistent.domain" });

    const probes: DiagnosticProbes = {
      lookupDns: async (host) => {
        const err: any = new Error(`getaddrinfo ENOTFOUND ${host}`);
        err.code = "ENOTFOUND";
        throw err;
      },
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.steps[0].step, "dns");
    assert.strictEqual(report.steps[0].status, "fail");
    assert.ok(report.steps[0].error?.includes("ENOTFOUND"));

    // Subsequent steps must be skipped
    const skipped = report.steps.filter((s) => s.status === "skipped");
    assert.strictEqual(skipped.length, 3);
    assert.ok(skipped.map((s) => s.step).includes("tcp"));
    assert.ok(skipped.map((s) => s.step).includes("auth"));
    assert.ok(skipped.map((s) => s.step).includes("ping"));

    assert.ok(report.recommendations.length > 0);
    assert.ok(report.recommendations.some((r) => r.includes("Verify the spelling")));
  });

  test("TCP port reachability failure (ECONNREFUSED) provides Firebird server guidance", async function () {
    const conn = createTestConn({ port: 3050 });

    const probes: DiagnosticProbes = {
      lookupDns: async () => ({ address: "192.168.1.10", family: 4 }),
      connectTcp: async (host, port) => {
        const err: any = new Error(`connect ECONNREFUSED ${host}:${port}`);
        err.code = "ECONNREFUSED";
        throw err;
      },
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.steps[1].step, "tcp");
    assert.strictEqual(report.steps[1].status, "fail");

    assert.ok(report.recommendations.some((r) => r.includes("systemctl status firebird") || r.includes("Firebird Server")));
    assert.ok(report.recommendations.some((r) => r.includes("firebird.conf")));

    // auth and ping skipped
    assert.strictEqual(report.steps[2].status, "skipped");
    assert.strictEqual(report.steps[3].status, "skipped");
  });

  test("TCP timeout (ETIMEDOUT) provides firewall and security group recommendations", async function () {
    const conn = createTestConn();

    const probes: DiagnosticProbes = {
      lookupDns: async () => ({ address: "10.0.0.5", family: 4 }),
      connectTcp: async () => {
        const err: any = new Error("Connection timed out after 5000ms");
        err.code = "ETIMEDOUT";
        throw err;
      },
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.steps[1].status, "fail");
    assert.ok(report.recommendations.some((r) => r.includes("Security Group") || r.includes("firewall")));
  });

  test("elevated latency produces warnings rather than failure", async function () {
    const conn = createTestConn();

    let clock = 1000;
    const probes: DiagnosticProbes = {
      lookupDns: async () => {
        clock += 1200; // > 1000ms triggers DNS warn
        return { address: "1.2.3.4", family: 4 };
      },
      connectTcp: async () => {
        clock += 600; // > 500ms triggers TCP warn
        return { latencyMs: 600 };
      },
      createConnection: async () => {
        clock += 2000; // > 1500ms triggers Auth warn
        return {};
      },
      executeQuery: async () => {
        clock += 100;
        return [];
      },
      detachConnection: async () => {},
      now: () => clock,
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.hasWarnings, true);
    assert.strictEqual(report.steps[0].status, "warn");
    assert.strictEqual(report.steps[1].status, "warn");
    assert.strictEqual(report.steps[2].status, "warn");
    assert.strictEqual(report.steps[3].status, "ok");
    assert.ok(report.summary.includes("latency warnings"));
  });

  test("SSH bastion probe is included when sshTunnel is configured", async function () {
    const conn = createTestConn({
      sshTunnel: {
        host: "bastion.example.com",
        port: 22,
        user: "ubuntu",
        authMethod: "password",
      },
    });

    const probes: DiagnosticProbes = {
      lookupDns: async () => ({ address: "10.0.0.1", family: 4 }),
      connectTcp: async (host, port) => {
        if (host === "bastion.example.com") {
          assert.strictEqual(port, 22);
          return { latencyMs: 35 };
        }
        return { latencyMs: 15 };
      },
      createConnection: async () => ({}),
      executeQuery: async () => [],
      detachConnection: async () => {},
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, true);
    // dns, tcp, ssh_bastion, auth, ping -> 5 steps
    assert.strictEqual(report.steps.length, 5);
    const bastionStep = report.steps.find((s) => s.step === "ssh_bastion");
    assert.ok(bastionStep, "SSH bastion step must be present");
    assert.strictEqual(bastionStep.status, "ok");
  });

  test("authentication failure produces credential and auth plugin recommendations", async function () {
    const conn = createTestConn();

    const probes: DiagnosticProbes = {
      lookupDns: async () => ({ address: "10.0.0.1", family: 4 }),
      connectTcp: async () => ({ latencyMs: 10 }),
      createConnection: async () => {
        throw new Error("Your user name and password are not defined. Ask your database administrator to set up a Firebird login. (code: 335544721)");
      },
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.steps[2].step, "auth");
    assert.strictEqual(report.steps[2].status, "fail");
    assert.strictEqual(report.steps[3].status, "skipped");

    assert.ok(report.recommendations.some((r) => r.includes("Set Connection Password")));
    assert.ok(report.recommendations.some((r) => r.includes("SYSDBA")));
  });

  test("wire encryption negotiation error produces WireCrypt guidance", async function () {
    const conn = createTestConn();

    const probes: DiagnosticProbes = {
      lookupDns: async () => ({ address: "10.0.0.1", family: 4 }),
      connectTcp: async () => ({ latencyMs: 10 }),
      createConnection: async () => {
        throw new Error("Client and server cannot agree on wire crypt plugin");
      },
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.steps[2].status, "fail");
    assert.ok(report.recommendations.some((r) => r.includes("Wire Encryption")));
  });

  test("server database file missing produces server filesystem guidance", async function () {
    const conn = createTestConn({ database: "/srv/data/missing.fdb" });

    const probes: DiagnosticProbes = {
      lookupDns: async () => ({ address: "10.0.0.1", family: 4 }),
      connectTcp: async () => ({ latencyMs: 10 }),
      createConnection: async () => {
        throw new Error("Cannot attach to database: Operating system directive CreateFile failed. The system cannot find the file specified.");
      },
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.steps[2].status, "fail");
    assert.ok(report.recommendations.some((r) => r.includes("SERVER filesystem")));
  });
});

suite("Connection Diagnostics – Embedded Databases", function () {
  test("successful embedded database check runs file, driver, attach, and ping", async function () {
    const conn = createTestConn({
      embedded: true,
      database: "/local/databases/employee.fdb",
    });

    const probes: DiagnosticProbes = {
      checkFile: async (filePath) => {
        assert.strictEqual(filePath, "/local/databases/employee.fdb");
        return { exists: true, sizeBytes: 15 * 1024 * 1024, readable: true, writable: true };
      },
      createConnection: async () => ({ isAttachment: true }),
      executeQuery: async () => [{ 1: 1 }],
      detachConnection: async () => {},
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.isEmbedded, true);
    assert.strictEqual(report.steps.length, 4);

    assert.strictEqual(report.steps[0].step, "file");
    assert.strictEqual(report.steps[0].status, "ok");
    assert.ok(report.steps[0].details.includes("15.00 MB"));

    assert.strictEqual(report.steps[1].step, "native_driver");
    assert.strictEqual(report.steps[1].status, "ok");

    assert.strictEqual(report.steps[2].step, "auth");
    assert.strictEqual(report.steps[2].status, "ok");

    assert.strictEqual(report.steps[3].step, "ping");
    assert.strictEqual(report.steps[3].status, "ok");
  });

  test("missing embedded file fails at file phase and skips remaining checks", async function () {
    const conn = createTestConn({
      embedded: true,
      database: "/local/databases/missing.fdb",
    });

    const probes: DiagnosticProbes = {
      checkFile: async () => ({ exists: false, readable: false, writable: false, error: "File not found" }),
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.steps[0].step, "file");
    assert.strictEqual(report.steps[0].status, "fail");

    const skipped = report.steps.filter((s) => s.status === "skipped");
    assert.strictEqual(skipped.length, 3);
    assert.ok(report.recommendations.some((r) => r.includes("missing.fdb")));
  });

  test("permission denied on embedded file fails with permission troubleshooting", async function () {
    const conn = createTestConn({
      embedded: true,
      database: "/root/secure.fdb",
    });

    const probes: DiagnosticProbes = {
      checkFile: async () => ({ exists: true, readable: true, writable: false }),
    };

    const report = await runConnectionDiagnostics(conn, probes);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.steps[0].status, "fail");
    assert.ok(report.steps[0].error?.includes("permission"));
  });
});

suite("Connection Diagnostics – renderDiagnosticsMarkdown", function () {
  test("healthy report renders valid GFM with status badge, tables, and details", function () {
    const report: DiagnosticReport = {
      connectionId: "c1",
      connectionLabel: "localhost:employee.fdb",
      timestamp: "2026-10-13 10:00:00 UTC",
      isEmbedded: false,
      totalDurationMs: 45,
      success: true,
      hasWarnings: false,
      steps: [
        { step: "dns", label: "DNS Resolution", status: "ok", durationMs: 5, details: "Resolved in 5ms" },
        { step: "tcp", label: "TCP Port Check (3050)", status: "ok", durationMs: 15, details: "Connected in 15ms" },
        { step: "auth", label: "Wire Protocol & Authentication", status: "ok", durationMs: 20, details: "Attached in 20ms" },
        { step: "ping", label: "Query Ping (SELECT 1)", status: "ok", durationMs: 5, details: "Ping ok in 5ms" },
      ],
      summary: "All 4 connectivity checks passed successfully (45ms total latency).",
      recommendations: [],
    };

    const markdown = renderDiagnosticsMarkdown(report);
    assert.ok(markdown.includes("# 🩺 Firebird Connection Diagnostics"));
    assert.ok(markdown.includes("localhost:employee.fdb"));
    assert.ok(markdown.includes("> [!NOTE]"));
    assert.ok(markdown.includes("✅ **Connection is fully operational.**"));
    assert.ok(markdown.includes("| Phase | Status | Latency | Share | Details |"));
    assert.ok(markdown.includes("| **DNS Resolution** | ✅ Passed | 5ms | 11% |"));
    assert.ok(markdown.includes("Total Measured Latency: 45ms"));
  });

  test("failed report renders warning alert and troubleshooting recommendations", function () {
    const report: DiagnosticReport = {
      connectionId: "c2",
      connectionLabel: "remote.server:data.fdb",
      timestamp: "2026-10-13 10:05:00 UTC",
      isEmbedded: false,
      totalDurationMs: 20,
      success: false,
      hasWarnings: false,
      steps: [
        { step: "dns", label: "DNS Resolution", status: "ok", durationMs: 5, details: "Resolved in 5ms" },
        { step: "tcp", label: "TCP Port Check (3050)", status: "fail", durationMs: 15, details: "Connection refused", error: "ECONNREFUSED" },
        { step: "auth", label: "Wire Protocol & Authentication", status: "skipped", durationMs: 0, details: "Skipped" },
      ],
      summary: "Connection failed at TCP Port Check (ECONNREFUSED).",
      recommendations: [
        "Verify Firebird is running: check systemctl status firebird.",
        "Ensure port 3050 is open in firewall.",
      ],
    };

    const markdown = renderDiagnosticsMarkdown(report);
    assert.ok(markdown.includes("> [!CAUTION]"));
    assert.ok(markdown.includes("❌ Failed"));
    assert.ok(markdown.includes("⚪ Skipped"));
    assert.ok(markdown.includes("## 🛠️ Actionable Recommendations & Troubleshooting"));
    assert.ok(markdown.includes("- Verify Firebird is running: check systemctl status firebird."));
    assert.ok(markdown.includes("- Ensure port 3050 is open in firewall."));
  });

  test("warning report renders warning alert", function () {
    const report: DiagnosticReport = {
      connectionId: "c3",
      connectionLabel: "slow.server:data.fdb",
      timestamp: "2026-10-13 10:10:00 UTC",
      isEmbedded: false,
      totalDurationMs: 1800,
      success: true,
      hasWarnings: true,
      steps: [
        { step: "dns", label: "DNS Resolution", status: "warn", durationMs: 1200, details: "Slow DNS" },
        { step: "tcp", label: "TCP Port Check (3050)", status: "warn", durationMs: 600, details: "Slow TCP" },
      ],
      summary: "Connection succeeded with warnings.",
      recommendations: ["DNS took > 1000ms"],
    };

    const markdown = renderDiagnosticsMarkdown(report);
    assert.ok(markdown.includes("> [!WARNING]"));
    assert.ok(markdown.includes("⚠️ **Connection succeeded, but elevated latency was detected.**"));
  });
});

suite("Connection Diagnostics – Error Analyzers", function () {
  test("analyzeDnsError returns host-specific advice", function () {
    const tips = analyzeDnsError({ code: "ENOTFOUND" }, "my-host.internal");
    assert.ok(tips.some((t) => t.includes("my-host.internal")));
    assert.ok(tips.some((t) => t.includes("VPN")));
  });

  test("analyzeTcpError handles ECONNREFUSED and ETIMEDOUT", function () {
    const refused = analyzeTcpError({ code: "ECONNREFUSED" }, "fb-host", 3050);
    assert.ok(refused.some((t) => t.includes("systemctl status firebird")));
    assert.ok(refused.some((t) => t.includes("RemoteServiceName")));

    const timeout = analyzeTcpError({ code: "ETIMEDOUT" }, "fb-host", 3050);
    assert.ok(timeout.some((t) => t.includes("Security Group")));
  });

  test("analyzeAuthError handles auth failures, WireCrypt, and database path errors", function () {
    const auth = analyzeAuthError(new Error("user name and password are not defined"), createTestConn());
    assert.ok(auth.some((t) => t.includes("Set Connection Password")));

    const wireCrypt = analyzeAuthError(new Error("wire crypt mismatch"), createTestConn());
    assert.ok(wireCrypt.some((t) => t.includes("Wire Encryption")));

    const dbPath = analyzeAuthError(new Error("cannot attach to file, I/O error"), createTestConn());
    assert.ok(dbPath.some((t) => t.includes("SERVER filesystem")));
  });

  test("analyzeFileError handles local filesystem issues", function () {
    const tips = analyzeFileError(new Error("ENOENT"), "/workspace/db.fdb");
    assert.ok(tips.some((t) => t.includes("/workspace/db.fdb")));
    assert.ok(tips.some((t) => t.includes("workspace")));
  });
});

suite("Connection Diagnostics – showConnectionDiagnostics", function () {
  test("executes progress notification and returns report", async function () {
    const conn = createTestConn();
    const probes: DiagnosticProbes = {
      lookupDns: async () => ({ address: "127.0.0.1", family: 4 }),
      connectTcp: async () => ({ latencyMs: 5 }),
      createConnection: async () => ({}),
      executeQuery: async () => [],
      detachConnection: async () => {},
    };

    const report = await showConnectionDiagnostics(conn, probes);
    assert.ok(report);
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.connectionId, "test-conn-1");
  });
});
