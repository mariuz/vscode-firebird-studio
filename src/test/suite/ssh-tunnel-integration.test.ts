/**
 * Extension Development Host integration test for SSH Tunneling (docs/roadmap/ssh-tunneling.md).
 * Had no *committed* automated coverage of a real SSH connection at all before this — the roadmap
 * doc describes thorough live verification (a throwaway `sshd`, a real Firebird server, `openSshTunnel()`/
 * `SshTunnelClient` driven end-to-end) having been done twice during development, but only ever as
 * one-off, uncommitted Node scripts, not a permanent test. `src/test/ssh-tunnel.test.ts` covers
 * `buildConnectConfig()`'s pure logic with no real SSH server involved.
 *
 * Spawns a real, throwaway `sshd` as the current (unprivileged) user — its own generated host key,
 * its own `authorized_keys` file under a scratch temp directory, nothing under the real `~/.ssh`
 * touched — and drives `openSshTunnel()`/`SshTunnelClient` through it against the real seeded
 * Firebird test server, the same way the roadmap doc's live verification did.
 *
 * If `sshd`/`ssh-keygen` aren't available at their well-known Debian/Ubuntu paths (this suite
 * doesn't fall back to a PATH search — a hosted CI runner or a dev container either has them at
 * the standard location or doesn't), the suite skips rather than failing, matching
 * isql-terminal-integration.test.ts's precedent for an optional-binary-dependent integration test.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { openSshTunnel, SshTunnelClient } from '../../shared/ssh-tunnel';
import { NodeClient } from '../../shared/driver';
import { CredentialStore } from '../../shared/credential-store';
import { SshTunnelOptions } from '../../interfaces';
import { getTestConnectionOptions } from './firebird-test-env';

function resolveSshBinaries(): { sshd: string; sshKeygen: string } | undefined {
  const sshdPath = ['/usr/sbin/sshd', '/usr/bin/sshd'].find(p => fs.existsSync(p));
  const keygenPath = ['/usr/bin/ssh-keygen', '/bin/ssh-keygen'].find(p => fs.existsSync(p));
  if (!sshdPath || !keygenPath) { return undefined; }
  return { sshd: sshdPath, sshKeygen: keygenPath };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('could not allocate a free port'))));
    });
    server.on('error', reject);
  });
}

suite('SSH Tunneling – real sshd + real Firebird server (extension host)', function () {
  this.timeout(30000);

  let bins: { sshd: string; sshKeygen: string } | undefined;
  let tmpDir: string;
  let sshdProcess: cp.ChildProcess | undefined;
  let sshPort: number;
  let tunnelOptions: SshTunnelOptions;

  suiteSetup(async function () {
    // CredentialStore.getSshPassword() (called inside SshTunnelClient.openTunnelFor()) needs
    // CredentialStore.setContext() to have already run -- but the *real* extension activation
    // (extension.ts#activate()) sets it on the CredentialStore class bundled *inside*
    // out/extension.js (esbuild's single-file bundle), a separate module instance (with its own
    // independent static state) from out/shared/credential-store.js, the plain tsc-compiled
    // output this suite-tier test file's own `import { CredentialStore } from
    // '../../shared/credential-store'` resolves to. Activating the extension (as the other new
    // integration suites in this pass do) doesn't touch *this* copy at all, so it's set directly
    // here instead, with a minimal in-memory SecretStorage -- sufficient since the scratch private
    // key generated below has no passphrase, so getSshPassword() correctly resolving to
    // `undefined` is exactly the right behavior, not a gap being papered over.
    const secrets = new Map<string, string>();
    CredentialStore.setContext({
      secrets: {
        get: (key: string) => Promise.resolve(secrets.get(key)),
        store: (key: string, value: string) => { secrets.set(key, value); return Promise.resolve(); },
        delete: (key: string) => { secrets.delete(key); return Promise.resolve(); },
        onDidChange: () => ({ dispose: () => { /* no-op */ } }),
      },
    } as unknown as vscode.ExtensionContext);

    bins = resolveSshBinaries();
    if (!bins) {
      // eslint-disable-next-line no-console
      console.log('[ssh-tunnel-integration] no sshd/ssh-keygen found at the expected paths — skipping.');
      return;
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ssh-tunnel-it-'));
    const hostKeyPath = path.join(tmpDir, 'host_key');
    const clientKeyPath = path.join(tmpDir, 'client_key');
    const authorizedKeysPath = path.join(tmpDir, 'authorized_keys');
    const sshdConfigPath = path.join(tmpDir, 'sshd_config');
    const pidPath = path.join(tmpDir, 'sshd.pid');

    cp.execFileSync(bins.sshKeygen, ['-t', 'ed25519', '-f', hostKeyPath, '-N', '', '-q']);
    cp.execFileSync(bins.sshKeygen, ['-t', 'ed25519', '-f', clientKeyPath, '-N', '', '-q']);
    fs.copyFileSync(`${clientKeyPath}.pub`, authorizedKeysPath);
    fs.chmodSync(authorizedKeysPath, 0o600);
    fs.chmodSync(clientKeyPath, 0o600);

    sshPort = await freePort();
    fs.writeFileSync(sshdConfigPath, [
      `Port ${sshPort}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKeyPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      `PidFile ${pidPath}`,
      'PasswordAuthentication no',
      'PubkeyAuthentication yes',
      'UsePAM no',
      'StrictModes no',
      'AllowTcpForwarding yes',
      'PermitRootLogin no',
    ].join('\n') + '\n');

    await new Promise<void>((resolve, reject) => {
      sshdProcess = cp.spawn(bins!.sshd, ['-f', sshdConfigPath, '-D', '-e']);
      const timer = setTimeout(() => reject(new Error('scratch sshd did not report "listening" in time')), 10000);
      sshdProcess.stderr?.on('data', chunk => {
        if (String(chunk).includes('Server listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      sshdProcess.on('error', err => { clearTimeout(timer); reject(err); });
    });

    tunnelOptions = {
      host: '127.0.0.1',
      port: sshPort,
      user: os.userInfo().username,
      authMethod: 'privateKey',
      privateKeyPath: clientKeyPath,
    };
  });

  suiteTeardown(function () {
    sshdProcess?.kill();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('openSshTunnel() opens a real local forwarded port through the real sshd to the real Firebird server', async function () {
    if (!bins) { this.skip(); return; }

    const conn = getTestConnectionOptions();
    const handle = await openSshTunnel(tunnelOptions, {}, conn.host, Number(conn.port ?? 3050));
    try {
      assert.ok(handle.localPort > 0);

      // A raw TCP connect through the forwarded port should succeed and reach *something* --
      // proof the tunnel is actually forwarding bytes, not just that ssh2 reported "ready".
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: handle.localPort }, () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
      });
    } finally {
      handle.close();
    }
  });

  test('a wrong private key is rejected cleanly, not left hanging', async function () {
    if (!bins) { this.skip(); return; }

    const wrongKeyPath = path.join(tmpDir, 'wrong_key');
    cp.execFileSync(bins.sshKeygen, ['-t', 'ed25519', '-f', wrongKeyPath, '-N', '', '-q']);
    const conn = getTestConnectionOptions();

    await assert.rejects(
      openSshTunnel({ ...tunnelOptions, privateKeyPath: wrongKeyPath }, {}, conn.host, Number(conn.port ?? 3050))
    );
  });

  test('SshTunnelClient runs a real query against the real Firebird server through the tunnel', async function () {
    if (!bins) { this.skip(); return; }

    const conn = { ...getTestConnectionOptions(), sshTunnel: tunnelOptions };
    const tunnelClient = new SshTunnelClient(new NodeClient());

    let connection: unknown;
    try {
      connection = await tunnelClient.createConnection(conn);
      const rows = await tunnelClient.queryPromise<{ N: number }>(connection as any, 'SELECT COUNT(*) AS N FROM PRODUCTS');
      assert.strictEqual(rows.length, 1);
      assert.ok(Number(rows[0].N) >= 1, 'expected the real seeded PRODUCTS rows to be visible through the tunnel');
    } finally {
      if (connection) { await tunnelClient.detach(connection as any); }
      await tunnelClient.shutdown();
    }
  });

  test('a second createConnection() for the same connection id reuses the already-open tunnel rather than opening a second one', async function () {
    if (!bins) { this.skip(); return; }

    const conn = { ...getTestConnectionOptions(), sshTunnel: tunnelOptions };
    const tunnelClient = new SshTunnelClient(new NodeClient());

    try {
      const first = await tunnelClient.resolveConnectionOptions(conn);
      const second = await tunnelClient.resolveConnectionOptions(conn);
      assert.strictEqual(first.port, second.port, 'the same local forwarded port should be reused, not a freshly-opened one');
    } finally {
      await tunnelClient.shutdown();
    }
  });
});
