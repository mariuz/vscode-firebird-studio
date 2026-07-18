import * as assert from 'assert';
import {
  isConnectionLostError, markConnectionUnreachable, markConnectionReachable, isConnectionUnreachable,
} from '../shared/connection-health';

suite('connection-health – isConnectionLostError() (docs/roadmap/connection-lost-indicator.md, phase 1)', function () {
  test('an Error with a known network error code is a connection-lost error', function () {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    assert.strictEqual(isConnectionLostError(err), true);
  });

  test('a plain string mentioning a network error code is a connection-lost error (NodeClient.queryPromise() rejects with strings, losing .code)', function () {
    assert.strictEqual(isConnectionLostError('Error queryPromise: read ECONNRESET'), true);
  });

  test('ECONNREFUSED (server down / wrong port) is a connection-lost error', function () {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3050'), { code: 'ECONNREFUSED' });
    assert.strictEqual(isConnectionLostError(err), true);
  });

  test('Firebird\'s own "unable to complete network request" wire-level message is a connection-lost error', function () {
    assert.strictEqual(isConnectionLostError(new Error('Unable to complete network request to host "localhost".')), true);
  });

  test('node-firebird\'s own generic close-without-a-captured-socket-error fallback message is a connection-lost error', function () {
    assert.strictEqual(isConnectionLostError(new Error('Connection to Firebird server was lost.')), true);
  });

  test('an ordinary SQL syntax error is NOT a connection-lost error', function () {
    assert.strictEqual(isConnectionLostError(new Error('Dynamic SQL Error -- SQL error code = -104 -- Token unknown')), false);
  });

  test('a constraint violation error is NOT a connection-lost error', function () {
    assert.strictEqual(isConnectionLostError(new Error('violation of PRIMARY or UNIQUE KEY constraint')), false);
  });

  test('undefined/null is NOT a connection-lost error', function () {
    assert.strictEqual(isConnectionLostError(undefined), false);
    assert.strictEqual(isConnectionLostError(null), false);
  });

  test('an error-shaped plain object (no Error prototype) is still matched by its .message', function () {
    assert.strictEqual(isConnectionLostError({ message: 'socket hang up' }), true);
  });
});

suite('connection-health – unreachable-connection registry (phase 3)', function () {
  const id = `test-conn-${Math.random()}`;

  test('a fresh connection id is not unreachable', function () {
    assert.strictEqual(isConnectionUnreachable(id), false);
  });

  test('markConnectionUnreachable() marks it, and reports the state actually changed', function () {
    assert.strictEqual(markConnectionUnreachable(id), true);
    assert.strictEqual(isConnectionUnreachable(id), true);
  });

  test('marking an already-unreachable id again reports no change', function () {
    assert.strictEqual(markConnectionUnreachable(id), false);
  });

  test('markConnectionReachable() clears it, and reports the state actually changed', function () {
    assert.strictEqual(markConnectionReachable(id), true);
    assert.strictEqual(isConnectionUnreachable(id), false);
  });

  test('marking an already-reachable id again reports no change', function () {
    assert.strictEqual(markConnectionReachable(id), false);
  });

  test('undefined id is a no-op for both mark functions', function () {
    assert.strictEqual(markConnectionUnreachable(undefined), false);
    assert.strictEqual(markConnectionReachable(undefined), false);
    assert.strictEqual(isConnectionUnreachable(undefined), false);
  });
});
