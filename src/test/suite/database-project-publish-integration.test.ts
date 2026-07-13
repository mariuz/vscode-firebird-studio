/**
 * End-to-end verification of Database Projects' Publish/migrate (Phase 3) against a real
 * Firebird server: builds a "source" snapshot representing the desired schema, a "target"
 * snapshot representing the current (stale) live schema, generates a migration script via
 * diffProjects()/buildPublishScript(), *actually executes it* against the target, then re-fetches
 * the target's schema and asserts it now matches the source — not just that a script was
 * generated, but that running it produces the intended result.
 */

import * as assert from 'assert';
import { Driver, NodeClient } from '../../shared/driver';
import { fetchProjectSnapshot } from '../../database-projects';
import { diffProjects, buildPublishScript } from '../../database-projects/publish-model';
import { getTestConnectionOptions } from './firebird-test-env';

suite('Database Projects – Publish/migrate (real Firebird integration)', function () {
  this.timeout(30000);

  const conn = getTestConnectionOptions();

  suiteSetup(function () {
    Driver.client = new NodeClient();
  });

  async function cleanup() {
    // Drop in dependency order; ignore errors (may not exist yet).
    await Driver.runQuery('ALTER TABLE PUB_CHILD DROP CONSTRAINT FK_PUB_CHILD_PARENT', conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery('DROP TRIGGER PUB_TRIG', conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery('DROP TABLE PUB_CHILD', conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery('DROP TABLE PUB_PARENT', conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery('DROP PROCEDURE PUB_PROC', conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery('DROP SEQUENCE PUB_GEN', conn).catch(() => { /* best-effort cleanup */ });
  }

  teardown(async function () {
    await cleanup();
  });

  test('column add/drop/type/not-null/default changes, a new FK, a new generator, and a new procedure round-trip through a real publish and execute', async function () {
    await cleanup();

    // ── Set up the "target" (current, stale) live schema ──────────────────
    await Driver.runQuery(
      "CREATE TABLE PUB_PARENT (ID INTEGER NOT NULL, CODE VARCHAR(10), OLD_COL VARCHAR(5), CONSTRAINT PK_PUB_PARENT PRIMARY KEY (ID))",
      conn
    );
    await Driver.runQuery(
      "CREATE TABLE PUB_CHILD (ID INTEGER NOT NULL, CONSTRAINT PK_PUB_CHILD PRIMARY KEY (ID))",
      conn
    );

    const targetSnapshot = await fetchProjectSnapshot(conn);
    const targetParent = targetSnapshot.graph.tables.find(t => t.name === 'PUB_PARENT');
    assert.ok(targetParent, 'PUB_PARENT should exist in the target snapshot');
    assert.strictEqual(targetParent!.columns.find(c => c.name === 'CODE')?.length, 10);
    assert.ok(targetSnapshot.pkConstraintNames.PUB_PARENT, 'should have captured the real PK constraint name');

    // ── Evolve the live schema in place to become the "source" (desired) state ──
    // Widen CODE, make it required, drop OLD_COL, add a new NOT NULL column with a default, add a
    // new FK from PUB_CHILD to PUB_PARENT, and add a new table + generator + procedure — a real
    // Firebird server must accept every one of these as a genuinely valid schema evolution.
    await Driver.runQuery("ALTER TABLE PUB_PARENT ALTER COLUMN CODE TYPE VARCHAR(30)", conn);
    await Driver.runQuery("ALTER TABLE PUB_PARENT ALTER COLUMN CODE SET NOT NULL", conn);
    await Driver.runQuery("ALTER TABLE PUB_PARENT DROP OLD_COL", conn);
    await Driver.runQuery("ALTER TABLE PUB_PARENT ADD STATUS VARCHAR(10) DEFAULT 'ACTIVE' NOT NULL", conn);
    await Driver.runQuery("ALTER TABLE PUB_CHILD ADD PARENT_ID INTEGER", conn);
    await Driver.runQuery("ALTER TABLE PUB_CHILD ADD CONSTRAINT FK_PUB_CHILD_PARENT FOREIGN KEY (PARENT_ID) REFERENCES PUB_PARENT (ID)", conn);
    await Driver.runQuery("CREATE SEQUENCE PUB_GEN", conn);
    await Driver.runQuery("CREATE PROCEDURE PUB_PROC AS BEGIN EXIT; END", conn);
    await Driver.runQuery("CREATE TRIGGER PUB_TRIG FOR PUB_PARENT ACTIVE BEFORE INSERT AS BEGIN END", conn);

    const sourceSnapshot = await fetchProjectSnapshot(conn);

    // ── Diff + generate the publish script ──────────────────────────────
    const diff = diffProjects(sourceSnapshot, targetSnapshot);
    const script = buildPublishScript(diff, targetSnapshot);

    assert.ok(script.includes('ALTER TABLE PUB_PARENT DROP OLD_COL;'), script);
    assert.ok(script.includes('ALTER TABLE PUB_PARENT ALTER COLUMN CODE TYPE VARCHAR(30);'), script);
    assert.ok(script.includes('ALTER TABLE PUB_PARENT ALTER COLUMN CODE SET NOT NULL;'), script);
    assert.ok(script.includes("ALTER TABLE PUB_PARENT ADD STATUS VARCHAR(10) DEFAULT 'ACTIVE' NOT NULL;"), script);
    assert.ok(script.includes('ALTER TABLE PUB_CHILD ADD PARENT_ID INTEGER;'), script);
    assert.ok(script.includes('ALTER TABLE PUB_CHILD ADD CONSTRAINT FK_PUB_CHILD_PARENT FOREIGN KEY (PARENT_ID) REFERENCES PUB_PARENT (ID);'), script);
    assert.ok(script.includes('CREATE SEQUENCE PUB_GEN;'), script);
    assert.ok(script.includes('CREATE OR ALTER PROCEDURE PUB_PROC'), script);
    assert.ok(script.includes('CREATE OR ALTER TRIGGER PUB_TRIG'), script);
    assert.ok(script.includes('FOR PUB_PARENT ACTIVE BEFORE INSERT'), script);

    // ── Revert the live schema back to the stale "target" state, then actually run the script ──
    await cleanup();
    await Driver.runQuery(
      "CREATE TABLE PUB_PARENT (ID INTEGER NOT NULL, CODE VARCHAR(10), OLD_COL VARCHAR(5), CONSTRAINT PK_PUB_PARENT PRIMARY KEY (ID))",
      conn
    );
    await Driver.runQuery(
      "CREATE TABLE PUB_CHILD (ID INTEGER NOT NULL, CONSTRAINT PK_PUB_CHILD PRIMARY KEY (ID))",
      conn
    );

    const batchResults = await Driver.runBatch(script, conn);
    const failed = batchResults.filter(r => r.error);
    assert.deepStrictEqual(failed, [], `every statement in the generated publish script should succeed against the reverted target, but: ${JSON.stringify(failed)}`);

    // ── Confirm the target now actually matches the source ──────────────
    const migratedSnapshot = await fetchProjectSnapshot(conn);
    const migratedParent = migratedSnapshot.graph.tables.find(t => t.name === 'PUB_PARENT')!;
    assert.strictEqual(migratedParent.columns.find(c => c.name === 'CODE')?.length, 30);
    assert.strictEqual(migratedParent.columns.find(c => c.name === 'CODE')?.notNull, true);
    assert.ok(!migratedParent.columns.find(c => c.name === 'OLD_COL'), 'OLD_COL should be gone');
    assert.ok(migratedParent.columns.find(c => c.name === 'STATUS'), 'STATUS column should now exist');
    assert.strictEqual(migratedParent.columns.find(c => c.name === 'STATUS')?.notNull, true);
    assert.ok(migratedSnapshot.generators.includes('PUB_GEN'));
    assert.ok(migratedSnapshot.procedures.some(p => p.name === 'PUB_PROC'));
    assert.ok(migratedSnapshot.triggers.some(t => t.name === 'PUB_TRIG' && t.table === 'PUB_PARENT'));
    assert.ok(
      migratedSnapshot.graph.relationships.some(r => r.table === 'PUB_CHILD' && r.refTable === 'PUB_PARENT'),
      'the new foreign key should now exist'
    );

    // A second diff against the now-migrated target should report no further changes.
    const finalDiff = diffProjects(sourceSnapshot, migratedSnapshot);
    const finalScript = buildPublishScript(finalDiff, migratedSnapshot);
    assert.ok(finalScript.includes('No changes detected'), finalScript);
  });
});
