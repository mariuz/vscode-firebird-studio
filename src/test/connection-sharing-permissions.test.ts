/**
 * Unit tests for connection-sharing/permissions.ts (docs/roadmap/cross-extension-connection-api.md,
 * phases 2 and 4). Simulates the user's dialog responses by temporarily monkey-patching the
 * mocked vscode module's `window.showInformationMessage`/`showWarningMessage`/`showQuickPick` —
 * `src/test/setup.ts` redirects every `require('vscode')` call (including permissions.ts's own)
 * to the exact same cached mock module instance, so mutating it here really does affect what the
 * code under test sees. Restored after every test so one test's stubbed response can't leak into
 * the next.
 */

import * as assert from 'assert';
import * as vscodeMock from './mocks/vscode';
import {
  requestConnectionSharingPermission, hasWriteAccess, toggleWriteAccess, editConnectionSharingPermissions, getGrant,
} from '../connection-sharing/permissions';
import { createMockContext } from './mocks/vscode';

const realShowInformationMessage = vscodeMock.window.showInformationMessage;
const realShowWarningMessage = vscodeMock.window.showWarningMessage;
const realShowQuickPick = vscodeMock.window.showQuickPick;

function stubInformationMessage(response: string | undefined) {
  (vscodeMock.window as any).showInformationMessage = () => Promise.resolve(response);
}
function stubWarningMessage(response: string | undefined) {
  (vscodeMock.window as any).showWarningMessage = () => Promise.resolve(response);
}
function stubQuickPick(responses: any[]) {
  let call = 0;
  (vscodeMock.window as any).showQuickPick = () => Promise.resolve(responses[call++]);
}

suite('connection-sharing/permissions – requestConnectionSharingPermission()', function () {
  teardown(function () {
    (vscodeMock.window as any).showInformationMessage = realShowInformationMessage;
  });

  test('refuses outright when extensionId is empty — nothing to remember a grant for', async function () {
    const ctx = createMockContext() as any;
    const result = await requestConnectionSharingPermission(ctx, '');
    assert.strictEqual(result, false);
  });

  test('prompts and returns true when the user approves', async function () {
    stubInformationMessage('Approve');
    const ctx = createMockContext() as any;
    const result = await requestConnectionSharingPermission(ctx, 'some.extension');
    assert.strictEqual(result, true);
  });

  test('prompts and returns false when the user denies', async function () {
    stubInformationMessage('Deny');
    const ctx = createMockContext() as any;
    const result = await requestConnectionSharingPermission(ctx, 'some.extension');
    assert.strictEqual(result, false);
  });

  test('an approval is cached — a second call does not prompt again', async function () {
    let promptCount = 0;
    (vscodeMock.window as any).showInformationMessage = () => { promptCount++; return Promise.resolve('Approve'); };
    const ctx = createMockContext() as any;

    await requestConnectionSharingPermission(ctx, 'some.extension');
    await requestConnectionSharingPermission(ctx, 'some.extension');

    assert.strictEqual(promptCount, 1);
  });

  test('a denial is cached too — a second call still returns false without re-prompting', async function () {
    let promptCount = 0;
    (vscodeMock.window as any).showInformationMessage = () => { promptCount++; return Promise.resolve('Deny'); };
    const ctx = createMockContext() as any;

    const first = await requestConnectionSharingPermission(ctx, 'some.extension');
    const second = await requestConnectionSharingPermission(ctx, 'some.extension');

    assert.strictEqual(first, false);
    assert.strictEqual(second, false);
    assert.strictEqual(promptCount, 1);
  });

  test('dismissing (no button clicked) is not cached — asks again next time', async function () {
    let promptCount = 0;
    (vscodeMock.window as any).showInformationMessage = () => { promptCount++; return Promise.resolve(undefined); };
    const ctx = createMockContext() as any;

    await requestConnectionSharingPermission(ctx, 'some.extension');
    await requestConnectionSharingPermission(ctx, 'some.extension');

    assert.strictEqual(promptCount, 2);
  });

  test('an approved grant defaults writeEnabled to false', async function () {
    stubInformationMessage('Approve');
    const ctx = createMockContext() as any;
    await requestConnectionSharingPermission(ctx, 'some.extension');
    const grant = await getGrant(ctx, 'some.extension');
    assert.strictEqual(grant?.writeEnabled, false);
  });
});

suite('connection-sharing/permissions – hasWriteAccess()', function () {
  teardown(function () {
    (vscodeMock.window as any).showInformationMessage = realShowInformationMessage;
    (vscodeMock.window as any).showWarningMessage = realShowWarningMessage;
  });

  test('false for an extension with no grant at all', async function () {
    const ctx = createMockContext() as any;
    assert.strictEqual(await hasWriteAccess(ctx, 'unknown.extension'), false);
  });

  test('false for an extension that is read-approved but has not been write-enabled', async function () {
    stubInformationMessage('Approve');
    const ctx = createMockContext() as any;
    await requestConnectionSharingPermission(ctx, 'some.extension');
    assert.strictEqual(await hasWriteAccess(ctx, 'some.extension'), false);
  });

  test('true after toggleWriteAccess() is confirmed for a read-approved extension', async function () {
    stubInformationMessage('Approve');
    const ctx = createMockContext() as any;
    await requestConnectionSharingPermission(ctx, 'some.extension');

    stubWarningMessage('Grant Write Access');
    await toggleWriteAccess(ctx, 'some.extension');

    assert.strictEqual(await hasWriteAccess(ctx, 'some.extension'), true);
  });

  test('false for an empty extensionId', async function () {
    const ctx = createMockContext() as any;
    assert.strictEqual(await hasWriteAccess(ctx, ''), false);
  });
});

suite('connection-sharing/permissions – toggleWriteAccess()', function () {
  teardown(function () {
    (vscodeMock.window as any).showInformationMessage = realShowInformationMessage;
    (vscodeMock.window as any).showWarningMessage = realShowWarningMessage;
  });

  test('refuses for an extension that has not been read-approved at all', async function () {
    const ctx = createMockContext() as any;
    await toggleWriteAccess(ctx, 'never.approved.extension');
    assert.strictEqual(await hasWriteAccess(ctx, 'never.approved.extension'), false);
  });

  test('enabling requires an explicit modal confirmation — dismissing leaves it disabled', async function () {
    stubInformationMessage('Approve');
    const ctx = createMockContext() as any;
    await requestConnectionSharingPermission(ctx, 'some.extension');

    stubWarningMessage(undefined); // dismissed
    await toggleWriteAccess(ctx, 'some.extension');

    assert.strictEqual(await hasWriteAccess(ctx, 'some.extension'), false);
  });

  test('disabling an already-enabled grant needs no confirmation', async function () {
    stubInformationMessage('Approve');
    const ctx = createMockContext() as any;
    await requestConnectionSharingPermission(ctx, 'some.extension');
    stubWarningMessage('Grant Write Access');
    await toggleWriteAccess(ctx, 'some.extension');
    assert.strictEqual(await hasWriteAccess(ctx, 'some.extension'), true);

    // Disable -- showWarningMessage is never consulted on the way down, only up.
    (vscodeMock.window as any).showWarningMessage = () => { throw new Error('should not be called when disabling'); };
    await toggleWriteAccess(ctx, 'some.extension');

    assert.strictEqual(await hasWriteAccess(ctx, 'some.extension'), false);
  });
});

suite('connection-sharing/permissions – editConnectionSharingPermissions()', function () {
  teardown(function () {
    (vscodeMock.window as any).showInformationMessage = realShowInformationMessage;
    (vscodeMock.window as any).showQuickPick = realShowQuickPick;
  });

  test('shows an informational message and does nothing when there are no grants yet', async function () {
    let informed = false;
    (vscodeMock.window as any).showInformationMessage = () => { informed = true; return Promise.resolve(undefined); };
    const ctx = createMockContext() as any;

    await editConnectionSharingPermissions(ctx);

    assert.ok(informed);
  });

  test('"Revoke" removes the grant entirely — a later call is treated as never-seen again', async function () {
    stubInformationMessage('Approve');
    const ctx = createMockContext() as any;
    await requestConnectionSharingPermission(ctx, 'some.extension');
    (vscodeMock.window as any).showInformationMessage = () => Promise.resolve(undefined);

    stubQuickPick([
      { extensionId: 'some.extension', label: 'some.extension' }, // pick the extension
      { action: 'revoke' }, // pick "Revoke"
    ]);
    await editConnectionSharingPermissions(ctx);

    assert.strictEqual(await getGrant(ctx, 'some.extension'), undefined);
  });

  test('"Deny future access" flips an approved grant to denied and clears write access', async function () {
    stubInformationMessage('Approve');
    const ctx = createMockContext() as any;
    await requestConnectionSharingPermission(ctx, 'some.extension');
    stubWarningMessage('Grant Write Access');
    await toggleWriteAccess(ctx, 'some.extension');
    assert.strictEqual(await hasWriteAccess(ctx, 'some.extension'), true);

    (vscodeMock.window as any).showInformationMessage = () => Promise.resolve(undefined);
    stubQuickPick([
      { extensionId: 'some.extension', label: 'some.extension' },
      { action: 'deny' },
    ]);
    await editConnectionSharingPermissions(ctx);

    const grant = await getGrant(ctx, 'some.extension');
    assert.strictEqual(grant?.read, 'denied');
    assert.strictEqual(grant?.writeEnabled, false);
  });

  test('dismissing the extension picker does nothing', async function () {
    stubInformationMessage('Approve');
    const ctx = createMockContext() as any;
    await requestConnectionSharingPermission(ctx, 'some.extension');

    (vscodeMock.window as any).showInformationMessage = () => Promise.resolve(undefined);
    stubQuickPick([undefined]);
    await editConnectionSharingPermissions(ctx);

    const grant = await getGrant(ctx, 'some.extension');
    assert.strictEqual(grant?.read, 'approved', 'the grant must be untouched when the picker is dismissed');
  });
});
