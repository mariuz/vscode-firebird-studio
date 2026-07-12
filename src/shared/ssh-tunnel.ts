/**
 * Opens a local forwarded TCP port that tunnels through an SSH connection to reach a Firebird
 * server on a private/internal network (a bastion/jump host in front of it) — see
 * docs/roadmap/ssh-tunneling.md. Uses `ssh2` (a real dependency, not hand-rolled — SSH's
 * transport/auth/channel protocol is a poor fit for this codebase's usual "hand-roll it, it's
 * small" approach, the same reasoning that led to accepting @modelcontextprotocol/sdk for the
 * MCP server rather than a from-scratch JSON-RPC implementation).
 */

import { Client as SshClient, ConnectConfig } from "ssh2";
import { createServer, Server } from "net";
import { readFileSync } from "fs";
import type * as Firebird from "node-firebird";
import type { Attachment } from "node-firebird-driver-native";
import type { ClientI, TransactionRequestOptions } from "./driver";
import { ConnectionOptions, SshTunnelOptions } from "../interfaces";
import { CredentialStore } from "./credential-store";
import { logger } from "../logger/logger";
import { PooledClient } from "./connection-pool";

export interface SshTunnelHandle {
  /** Connect to 127.0.0.1:<localPort> instead of the real host/port — the tunnel forwards it through to the SSH server's view of remoteHost:remotePort. */
  localPort: number;
  close(): void;
}

export interface SshTunnelCredentials {
  /** Password (authMethod "password") or private key passphrase (authMethod "privateKey", only if the key is encrypted) — resolved from CredentialStore by the caller, never read from disk/globalState here. */
  password?: string;
}

/** Pure — exported for unit testing without a real SSH server/socket. */
export function buildConnectConfig(tunnel: SshTunnelOptions, credentials: SshTunnelCredentials): ConnectConfig {
  const config: ConnectConfig = {
    host: tunnel.host,
    port: tunnel.port,
    username: tunnel.user,
    readyTimeout: 15000,
  };

  switch (tunnel.authMethod) {
    case "password":
      config.password = credentials.password;
      return config;
    case "privateKey":
      if (!tunnel.privateKeyPath) {
        throw new Error('SSH tunnel: authMethod is "privateKey" but no privateKeyPath was set.');
      }
      try {
        config.privateKey = readFileSync(tunnel.privateKeyPath);
      } catch (err: any) {
        throw new Error(`SSH tunnel: could not read private key file "${tunnel.privateKeyPath}": ${err?.message ?? err}`);
      }
      if (credentials.password) {
        config.passphrase = credentials.password;
      }
      return config;
    case "agent": {
      const agent = process.env.SSH_AUTH_SOCK ?? (process.platform === "win32" ? "pageant" : undefined);
      if (!agent) {
        throw new Error("SSH tunnel: authMethod is \"agent\" but no SSH agent was found (SSH_AUTH_SOCK is not set).");
      }
      config.agent = agent;
      return config;
    }
  }
}

/**
 * Opens the tunnel and resolves once the local forwarded port is accepting connections. The
 * caller owns the returned handle's lifetime and must call close() when done with it (this
 * module has no reference-counting/reuse of its own — see src/shared/driver.ts's SshTunnelClient
 * for the per-connection-id reuse policy).
 */
export function openSshTunnel(
  tunnel: SshTunnelOptions,
  credentials: SshTunnelCredentials,
  remoteHost: string,
  remotePort: number
): Promise<SshTunnelHandle> {
  return new Promise((resolve, reject) => {
    let connectConfig: ConnectConfig;
    try {
      connectConfig = buildConnectConfig(tunnel, credentials);
    } catch (err) {
      reject(err);
      return;
    }

    const ssh = new SshClient();
    let server: Server | undefined;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) { return; }
      settled = true;
      server?.close();
      ssh.end();
      reject(err);
    };

    ssh.on("error", fail);

    ssh.on("ready", () => {
      server = createServer(socket => {
        ssh.forwardOut(socket.remoteAddress ?? "127.0.0.1", socket.remotePort ?? 0, remoteHost, remotePort, (err, stream) => {
          if (err) {
            socket.destroy(err);
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on("error", () => socket.destroy());
          socket.on("error", () => stream.end());
        });
      });

      server.on("error", fail);
      server.listen(0, "127.0.0.1", () => {
        if (settled) { return; }
        settled = true;
        const address = server!.address();
        const localPort = typeof address === "object" && address ? address.port : 0;
        resolve({
          localPort,
          close: () => {
            server?.close();
            ssh.end();
          },
        });
      });
    });

    ssh.connect(connectConfig);
  });
}

/**
 * Wraps a ClientI so createConnection() transparently opens (or reuses) an SSH tunnel first
 * whenever connectionOptions.sshTunnel is set, and rewrites host/port to the local forwarded
 * port before delegating to the inner client — the same decorator shape as connection-pool.ts's
 * PooledClient, keyed the same way (connectionOptions.id), so a saved connection's tunnel is
 * opened once and reused across every subsequent createConnection() call for it (pooled or not)
 * rather than re-established per query. Sits outside the pool in Driver.setClient() (i.e. this
 * wraps the pool, not the other way around) so pooling still works underneath unaffected.
 */
export class SshTunnelClient<K extends Firebird.Database | Attachment> implements ClientI<K> {
  private readonly tunnels = new Map<string, SshTunnelHandle>();
  private readonly pending = new Map<string, Promise<SshTunnelHandle>>();

  constructor(private readonly inner: ClientI<K>) {}

  /** The wrapped client — lets a caller that needs the real NodeClient/NativeClient instance (e.g. Driver.getQueryPlan()'s native-only API) unwrap past tunneling/pooling. */
  public unwrap(): ClientI<K> {
    return this.inner;
  }

  public queryPromise<T extends object>(connection: K, sql: string, args?: any[], txOptions?: TransactionRequestOptions): Promise<T[]> {
    return this.inner.queryPromise(connection, sql, args, txOptions);
  }

  public async createConnection(connectionOptions: ConnectionOptions): Promise<K> {
    const resolved = await this.resolveConnectionOptions(connectionOptions);
    return this.inner.createConnection(resolved);
  }

  /**
   * Rewrites host/port to the local forwarded port if sshTunnel is set (opening/reusing the
   * tunnel as needed), otherwise returns connectionOptions unchanged. Exposed for callers that
   * bypass createConnection() and connect internally (e.g. NativeClient.getQueryPlan()).
   */
  public async resolveConnectionOptions(connectionOptions: ConnectionOptions): Promise<ConnectionOptions> {
    if (!connectionOptions.sshTunnel || connectionOptions.embedded) {
      return connectionOptions;
    }
    const tunnel = await this.ensureTunnel(connectionOptions);
    return { ...connectionOptions, host: "127.0.0.1", port: tunnel.localPort };
  }

  public detach(connection: K): Promise<void> {
    return this.inner.detach(connection);
  }

  public createDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    if (!this.inner.createDatabase) {
      return Promise.reject(new Error("The current driver does not support creating databases."));
    }
    if (!connectionOptions.sshTunnel || connectionOptions.embedded) {
      return this.inner.createDatabase(connectionOptions);
    }
    return this.ensureTunnel(connectionOptions).then(tunnel =>
      this.inner.createDatabase!({ ...connectionOptions, host: "127.0.0.1", port: tunnel.localPort })
    );
  }

  public dropDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    if (!this.inner.dropDatabase) {
      return Promise.reject(new Error("The current driver does not support dropping databases."));
    }
    if (!connectionOptions.sshTunnel || connectionOptions.embedded) {
      return this.inner.dropDatabase(connectionOptions);
    }
    return this.ensureTunnel(connectionOptions).then(tunnel =>
      this.inner.dropDatabase!({ ...connectionOptions, host: "127.0.0.1", port: tunnel.localPort })
    );
  }

  /**
   * Closes every open tunnel — call on extension deactivation or when the driver's client is
   * replaced. Also cascades to the wrapped client's own shutdown() when it's a PooledClient,
   * since Driver.setClient() always wraps SshTunnelClient outermost — PooledClient's own
   * idle-connection cleanup would otherwise never run.
   */
  public async shutdown(): Promise<void> {
    for (const handle of this.tunnels.values()) {
      handle.close();
    }
    this.tunnels.clear();
    this.pending.clear();
    if (this.inner instanceof PooledClient) {
      await this.inner.shutdown();
    }
  }

  private async ensureTunnel(connectionOptions: ConnectionOptions): Promise<SshTunnelHandle> {
    const key = connectionOptions.id;
    const existing = this.tunnels.get(key);
    if (existing) {
      return existing;
    }
    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight;
    }

    const opening = this.openTunnelFor(connectionOptions).then(handle => {
      this.tunnels.set(key, handle);
      this.pending.delete(key);
      return handle;
    }).catch(err => {
      this.pending.delete(key);
      throw err;
    });
    this.pending.set(key, opening);
    return opening;
  }

  private async openTunnelFor(connectionOptions: ConnectionOptions): Promise<SshTunnelHandle> {
    const tunnel = connectionOptions.sshTunnel!;
    logger.info(`Opening SSH tunnel to ${tunnel.host}:${tunnel.port} for connection ${connectionOptions.id}...`);
    const password = await CredentialStore.getSshPassword(connectionOptions.id);
    try {
      const handle = await openSshTunnel(tunnel, { password }, connectionOptions.host, Number(connectionOptions.port ?? 3050));
      logger.info(`SSH tunnel established on local port ${handle.localPort}.`);
      return handle;
    } catch (err: any) {
      logger.error(`SSH tunnel failed: ${err?.message ?? err}`);
      throw new Error(`SSH tunnel to ${tunnel.host}:${tunnel.port} failed: ${err?.message ?? err}`);
    }
  }
}
