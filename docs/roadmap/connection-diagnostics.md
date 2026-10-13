# Connection Diagnostics & Latency Breakdown

**Inspired by**: [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql) 1.30.0 — step-by-step connection diagnostic and latency breakdown tooling.

## Motivation & Overview

When connecting to remote, Dockerized, or SSH-tunneled Firebird databases, connections can fail or perform poorly due to firewalls on TCP port 3050, slow DNS resolution, SRP/wire-encryption negotiation mismatches, or file permission problems. Previously, `Driver.createConnection()` surfaced only a generic error or timed out without explaining where the failure occurred.

The **Connection Diagnostics & Latency Breakdown** (`firebird.connection.diagnose`) tool runs a step-by-step diagnostic probe against any saved or active Firebird connection:

1. **DNS Resolution**: Measures hostname resolution latency (`dns.promises.lookup`) and resolved IP family (IPv4/IPv6). Numeric IP addresses bypass DNS cleanly. Flags slow DNS resolution (> 1000ms).
2. **TCP Port Reachability**: Establishes a raw TCP socket connection (`net.Socket`) to target port (default `3050`) with an explicit timeout. Pinpoints `ECONNREFUSED` (Firebird server down or wrong port), `ETIMEDOUT` (firewall/security group dropping packets), or `EHOSTUNREACH`.
3. **SSH Bastion Reachability** *(when SSH tunneling is configured)*: Probes reachability and TCP latency to the SSH jump host/bastion port before attempting tunnel negotiation.
4. **Wire Protocol & Authentication Handshake**: Tests Firebird engine attachment (`Driver.client.createConnection`) and authentication (SRP, ChaCha/wire-encryption). Explicitly identifies authentication failures, WireCrypt mismatches, database file access errors on the server, or native driver requirements.
5. **Query Ping (`SELECT 1 FROM RDB$DATABASE`)**: Executes a minimal ping query to measure statement execution latency and retrieve engine version metadata (`RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION')`).
6. **Embedded Database Path**: For local embedded files (`embedded: true`), verifies file existence, size, read/write filesystem permissions, and native driver availability prior to engine attachment and ping execution.

## User Experience & Reports

- **Interactive Progress**: Uses VS Code's `window.withProgress` notification to stream phase-by-phase status (`[1/4] Resolving host...`, `[2/4] Testing TCP connectivity...`).
- **One-Click Markdown Report**: Succeeded or failed diagnostics offer a **View Full Report** button that opens a rich GitHub-flavored Markdown document beside the active editor via `markdown.showPreviewToSide`.
- **Latency Breakdown**: Generates summary tables and visual distribution bars displaying latency share per phase (e.g. `DNS: 12ms (15%) | TCP: 18ms (23%) | Auth: 45ms (57%) | Ping: 4ms (5%)`).
- **Actionable Recommendations**: Context-aware troubleshooting suggestions for port 3050 firewall rules, `firebird.conf` settings, user credentials, and WireCrypt options.

## Commands Contributed

- `firebird.connection.diagnose`: "Diagnose Connection..." (`Firebird` category). Contributed to database node context menus (`manage@9`) in Object Explorer and Command Palette.

## Testing

Unit tests in `src/test/connection-diagnostics.test.ts` cover:
- Network connection diagnostics across all phases with mock probes
- DNS resolution failure with troubleshooting recommendations
- Numeric IP address bypassing DNS
- TCP connection timeout and `ECONNREFUSED` error handling
- SSH bastion connectivity checks
- Authentication failure analysis and credential update suggestions
- WireCrypt mismatch detection and guidance
- Database file missing / permission error detection for embedded connections
- Markdown report generation (tables, latency distribution, status badges, recommendations)
