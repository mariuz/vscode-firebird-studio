/**
 * Extension Development Host test for the Getting Started walkthrough
 * (contributes.walkthroughs). Runs inside a real VS Code instance.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'AdrianMariusPopa.vscode-firebird-studio';
const WALKTHROUGH_ID = 'firebirdGettingStarted';

suite('Extension Host – Getting Started walkthrough', function () {
  this.timeout(30000);

  let extension: vscode.Extension<unknown> | undefined;

  suiteSetup(async function () {
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (extension && !extension.isActive) {
      await extension.activate();
    }
  });

  test('package.json declares the walkthrough with the expected steps', function () {
    assert.ok(extension, 'Extension should be installed in the test host');
    const packageJSON: any = extension!.packageJSON;
    const walkthroughs: any[] = packageJSON?.contributes?.walkthroughs ?? [];
    const walkthrough = walkthroughs.find(w => w.id === WALKTHROUGH_ID);
    assert.ok(walkthrough, `Expected a walkthrough with id "${WALKTHROUGH_ID}"`);
    assert.ok(Array.isArray(walkthrough.steps) && walkthrough.steps.length > 0, 'Walkthrough should have steps');

    for (const step of walkthrough.steps) {
      assert.ok(step.id, 'Every step needs an id');
      assert.ok(step.media?.markdown, `Step "${step.id}" should use markdown media`);
    }
  });

  test('every step\'s markdown media file exists on disk', function () {
    const packageJSON: any = extension!.packageJSON;
    const walkthrough = packageJSON.contributes.walkthroughs.find((w: any) => w.id === WALKTHROUGH_ID);

    for (const step of walkthrough.steps) {
      const mdPath = path.join(extension!.extensionPath, step.media.markdown);
      assert.ok(fs.existsSync(mdPath), `Missing markdown file for step "${step.id}": ${mdPath}`);
    }
  });

  test('every command: link or completionEvent in the walkthrough is actually registered', async function () {
    const packageJSON: any = extension!.packageJSON;
    const walkthrough = packageJSON.contributes.walkthroughs.find((w: any) => w.id === WALKTHROUGH_ID);
    const registered = new Set(await vscode.commands.getCommands(true));

    for (const step of walkthrough.steps) {
      for (const event of step.completionEvents ?? []) {
        const match = /^onCommand:(.+)$/.exec(event);
        if (match) {
          assert.ok(registered.has(match[1]), `completionEvent references unregistered command "${match[1]}" (step "${step.id}")`);
        }
      }

      const mdPath = path.join(extension!.extensionPath, step.media.markdown);
      const content = fs.readFileSync(mdPath, 'utf8');
      const linkPattern = /\]\(command:([a-zA-Z0-9_.-]+)\)/g;
      let match: RegExpExecArray | null;
      while ((match = linkPattern.exec(content)) !== null) {
        assert.ok(registered.has(match[1]), `"${step.id}" links to unregistered command "${match[1]}"`);
      }
    }
  });

  test('workbench.action.openWalkthrough opens our walkthrough without error', async function () {
    // Opens the walkthrough editor. Throws if the id doesn't resolve to a registered walkthrough.
    await vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      `${EXTENSION_ID}#${WALKTHROUGH_ID}`,
      false
    );
  });
});
