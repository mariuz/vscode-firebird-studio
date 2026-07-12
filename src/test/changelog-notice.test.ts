import * as assert from 'assert';
import { extractChangelogEntry, summarizeChangelogEntry } from '../shared/changelog-notice';

const SAMPLE_CHANGELOG = `# Change Log

All notable changes to the "vscode-firebird-studio" extension will be documented in this file.

## 0.1.46 - 2026-07-12

### Added

- **Getting Started walkthrough** — an interactive, checklist-style onboarding flow.
- **Second bullet** — with more detail than the first one, just to check joining.

## 0.1.45 - 2026-07-12

### Added

- **Object privileges/grants viewer** — right-click a table for a new command.

## 0.1.44 - 2026-07-12

### Fixed

- Something older.
`;

suite('extractChangelogEntry', function () {
  test('extracts the body between a version heading and the next one', function () {
    const entry = extractChangelogEntry(SAMPLE_CHANGELOG, '0.1.46');
    assert.ok(entry, 'expected an entry for 0.1.46');
    assert.ok(entry!.includes('Getting Started walkthrough'), entry);
    assert.ok(!entry!.includes('Object privileges'), 'should not bleed into the next version\'s entry');
  });

  test('extracts the last entry in the file (no following heading)', function () {
    const entry = extractChangelogEntry(SAMPLE_CHANGELOG, '0.1.44');
    assert.ok(entry, 'expected an entry for 0.1.44');
    assert.ok(entry!.includes('Something older'), entry);
  });

  test('returns undefined for a version not present in the changelog', function () {
    assert.strictEqual(extractChangelogEntry(SAMPLE_CHANGELOG, '9.9.9'), undefined);
  });

  test('does not let "." in the version act as a regex wildcard', function () {
    // 0x1046 should not match "0.1.46" just because "." matches any character.
    assert.strictEqual(extractChangelogEntry(SAMPLE_CHANGELOG, '0x1046'), undefined);
  });
});

suite('summarizeChangelogEntry', function () {
  test('joins bullet points and strips markdown bold markers', function () {
    const entry = extractChangelogEntry(SAMPLE_CHANGELOG, '0.1.46')!;
    const summary = summarizeChangelogEntry(entry);
    assert.ok(!summary.includes('**'), summary);
    assert.ok(summary.includes('Getting Started walkthrough'), summary);
    assert.ok(summary.includes('Second bullet'), summary);
    assert.ok(summary.includes(' · '), summary);
  });

  test('truncates with an ellipsis past maxLength', function () {
    const entry = extractChangelogEntry(SAMPLE_CHANGELOG, '0.1.46')!;
    const summary = summarizeChangelogEntry(entry, 20);
    assert.ok(summary.endsWith('…'), summary);
    assert.ok(summary.length <= 20, summary);
  });

  test('ignores non-bullet lines like section headers', function () {
    const entry = extractChangelogEntry(SAMPLE_CHANGELOG, '0.1.46')!;
    const summary = summarizeChangelogEntry(entry);
    assert.ok(!summary.includes('### Added'), summary);
  });
});
