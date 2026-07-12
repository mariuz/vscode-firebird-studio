import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildConnectConfig, SshTunnelClient } from '../shared/ssh-tunnel';
import { ConnectionOptions, SshTunnelOptions } from '../interfaces';
import { ClientI } from '../shared/driver';

suite('buildConnectConfig – password auth', function () {
  test('builds a config with host/port/username/password, no key/agent fields', function () {
    const tunnel: SshTunnelOptions = { host: 'bastion.example.com', port: 22, user: 'deploy', authMethod: 'password' };
    const config = buildConnectConfig(tunnel, { password: 'hunter2' });
    assert.strictEqual(config.host, 'bastion.example.com');
    assert.strictEqual(config.port, 22);
    assert.strictEqual(config.username, 'deploy');
    assert.strictEqual(config.password, 'hunter2');
    assert.strictEqual(config.privateKey, undefined);
    assert.strictEqual(config.agent, undefined);
  });
});

suite('buildConnectConfig – privateKey auth', function () {
  let tmpDir: string;
  let keyPath: string;

  suiteSetup(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-tunnel-test-'));
    keyPath = path.join(tmpDir, 'id_test');
    fs.writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-content\n-----END OPENSSH PRIVATE KEY-----\n');
  });

  suiteTeardown(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('throws when privateKeyPath is missing', function () {
    const tunnel: SshTunnelOptions = { host: 'h', port: 22, user: 'u', authMethod: 'privateKey' };
    assert.throws(() => buildConnectConfig(tunnel, {}), /no privateKeyPath was set/);
  });

  test('throws with a clear message when the key file cannot be read', function () {
    const tunnel: SshTunnelOptions = { host: 'h', port: 22, user: 'u', authMethod: 'privateKey', privateKeyPath: '/nonexistent/path/to/key' };
    assert.throws(() => buildConnectConfig(tunnel, {}), /could not read private key file/);
  });

  test('reads the key file into config.privateKey as a Buffer', function () {
    const tunnel: SshTunnelOptions = { host: 'h', port: 22, user: 'u', authMethod: 'privateKey', privateKeyPath: keyPath };
    const config = buildConnectConfig(tunnel, {});
    assert.ok(Buffer.isBuffer(config.privateKey));
    assert.ok((config.privateKey as Buffer).toString('utf8').includes('fake-key-content'));
  });

  test('omits passphrase when no password is given', function () {
    const tunnel: SshTunnelOptions = { host: 'h', port: 22, user: 'u', authMethod: 'privateKey', privateKeyPath: keyPath };
    const config = buildConnectConfig(tunnel, {});
    assert.strictEqual(config.passphrase, undefined);
  });

  test('sets passphrase when a password is given (encrypted key)', function () {
    const tunnel: SshTunnelOptions = { host: 'h', port: 22, user: 'u', authMethod: 'privateKey', privateKeyPath: keyPath };
    const config = buildConnectConfig(tunnel, { password: 'key-passphrase' });
    assert.strictEqual(config.passphrase, 'key-passphrase');
  });
});

suite('buildConnectConfig – agent auth', function () {
  const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

  teardown(function () {
    if (originalSshAuthSock === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = originalSshAuthSock;
    }
  });

  test('uses SSH_AUTH_SOCK when set', function () {
    process.env.SSH_AUTH_SOCK = '/tmp/fake-agent.sock';
    const tunnel: SshTunnelOptions = { host: 'h', port: 22, user: 'u', authMethod: 'agent' };
    const config = buildConnectConfig(tunnel, {});
    assert.strictEqual(config.agent, '/tmp/fake-agent.sock');
  });

  test('throws on a non-Windows platform with no SSH_AUTH_SOCK set', function () {
    delete process.env.SSH_AUTH_SOCK;
    if (process.platform === 'win32') {
      this.skip(); // pageant fallback applies instead on Windows
    }
    const tunnel: SshTunnelOptions = { host: 'h', port: 22, user: 'u', authMethod: 'agent' };
    assert.throws(() => buildConnectConfig(tunnel, {}), /no SSH agent was found/);
  });
});

/** A fake ClientI that just records what it was called with — no real Firebird/SSH I/O. */
class FakeClient implements ClientI<any> {
  public createConnectionCalls: ConnectionOptions[] = [];

  async queryPromise<T extends object>(_connection: any, _sql: string, _args?: any[]): Promise<T[]> {
    return [];
  }
  async createConnection(connectionOptions: ConnectionOptions): Promise<any> {
    this.createConnectionCalls.push(connectionOptions);
    return { fake: true };
  }
  async detach(): Promise<void> { /* no-op */ }
}

suite('SshTunnelClient – passthrough when no sshTunnel is configured', function () {
  test('createConnection() passes connectionOptions through unchanged', async function () {
    const fake = new FakeClient();
    const wrapper = new SshTunnelClient(fake);
    const options: ConnectionOptions = { id: 'conn-1', host: 'db.internal', port: 3050, database: '/data/test.fdb', user: 'sysdba', role: null };

    await wrapper.createConnection(options);

    assert.strictEqual(fake.createConnectionCalls.length, 1);
    assert.deepStrictEqual(fake.createConnectionCalls[0], options);
  });

  test('resolveConnectionOptions() returns the same object when sshTunnel is unset', async function () {
    const wrapper = new SshTunnelClient(new FakeClient());
    const options: ConnectionOptions = { id: 'conn-2', host: 'db.internal', port: 3050, database: '/data/test.fdb', user: 'sysdba', role: null };

    const resolved = await wrapper.resolveConnectionOptions(options);
    assert.deepStrictEqual(resolved, options);
  });

  test('resolveConnectionOptions() returns the same object for an embedded connection even with sshTunnel set', async function () {
    const wrapper = new SshTunnelClient(new FakeClient());
    const options: ConnectionOptions = {
      id: 'conn-3', host: '', port: 0, database: '/data/embedded.fdb', user: 'sysdba', role: null,
      embedded: true,
      sshTunnel: { host: 'bastion', port: 22, user: 'deploy', authMethod: 'password' },
    };

    const resolved = await wrapper.resolveConnectionOptions(options);
    assert.deepStrictEqual(resolved, options);
  });

  test('unwrap() returns the wrapped client', function () {
    const fake = new FakeClient();
    const wrapper = new SshTunnelClient(fake);
    assert.strictEqual(wrapper.unwrap(), fake);
  });

  test('queryPromise() delegates straight through to the wrapped client', async function () {
    const fake = new FakeClient();
    let seenArgs: any;
    fake.queryPromise = async (_connection: any, _sql: string, args?: any[]) => { seenArgs = args; return []; };
    const wrapper = new SshTunnelClient(fake);

    await wrapper.queryPromise({}, 'SELECT 1 FROM RDB$DATABASE', [42]);
    assert.deepStrictEqual(seenArgs, [42]);
  });
});
