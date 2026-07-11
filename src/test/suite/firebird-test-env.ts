/**
 * Shared connection options for the VS Code Extension Host integration suites
 * (driver-integration.test.ts, tree-integration.test.ts). These suites talk to
 * a real Firebird server through the extension's own Driver/node classes,
 * running inside the actual Extension Development Host — unlike src/test/e2e
 * (talks to node-firebird directly, bypassing all extension code) and the
 * plain unit tests under src/test/*.test.ts (run outside VS Code against a
 * mocked 'vscode' module).
 *
 * Configured via the same environment variables as the e2e suite so both can
 * point at the same CI-provisioned Firebird service:
 *   FIREBIRD_HOST, FIREBIRD_PORT, FIREBIRD_DATABASE, FIREBIRD_USER, FIREBIRD_PASSWORD
 *
 * NOTE: this file intentionally does not end in `.test.ts` so the
 * @vscode/test-cli suite loader (files: 'out/test/suite/**\/*.test.js') does
 * not try to run it as a standalone test suite.
 */

import { ConnectionOptions } from '../../interfaces';

export function getTestConnectionOptions(): ConnectionOptions {
  return {
    id: 'suite-test-connection',
    host: process.env.FIREBIRD_HOST ?? 'localhost',
    port: Number(process.env.FIREBIRD_PORT ?? '3050'),
    database: process.env.FIREBIRD_DATABASE ?? '/var/lib/firebird/data/test.fdb',
    user: process.env.FIREBIRD_USER ?? 'sysdba',
    password: process.env.FIREBIRD_PASSWORD ?? 'masterkey',
    role: null,
    wireCrypt: 'Disabled',
  };
}
