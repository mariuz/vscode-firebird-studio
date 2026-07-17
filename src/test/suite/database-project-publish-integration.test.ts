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
    await Driver.runQuery("CREATE PROCEDURE PUB_PROC (X INT, AMT NUMERIC(9,2)) RETURNS (Y INT) AS BEGIN Y = X; SUSPEND; END", conn);
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
    assert.ok(script.includes('(X INTEGER, AMT NUMERIC(9,2))'), script);
    assert.ok(script.includes('RETURNS (Y INTEGER)'), script);
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
    const migratedProc = migratedSnapshot.procedures.find(p => p.name === 'PUB_PROC');
    assert.ok(migratedProc, 'PUB_PROC should now exist');
    assert.strictEqual(migratedProc!.parameters?.length, 3, JSON.stringify(migratedProc!.parameters));
    assert.ok(migratedProc!.parameters!.some(p => p.name === 'AMT' && p.direction === 'in' && p.subType === 1 && p.precision === 9));
    assert.ok(migratedProc!.parameters!.some(p => p.name === 'Y' && p.direction === 'out'));
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

  // ── domains/exceptions/roles/users (docs/roadmap/database-projects.md) ────────────────────
  //
  // Same "actually execute the generated script, then re-fetch and confirm it really matches"
  // methodology as the table/procedure/trigger test above — this is what caught three real bugs
  // during local verification before this suite existed (see the roadmap doc): generators were
  // emitted after the triggers/procedures/table-column-defaults that could reference them via
  // GEN_ID(), RDB$FIELD_LENGTH turned out to be a UTF8-charset column's *byte* length rather than
  // its character length (a real, pre-existing gap well beyond just this phase — every
  // VARCHAR/CHAR column extracted anywhere in this codebase was affected), and a target whose only
  // remaining diff was a brand-new user produced a script that was entirely a `-- ` comment (by
  // design — see buildUserCreateDDL()'s doc comment) which sql-splitter.ts used to still try to
  // send to the server as if it were real SQL.

  const PUB_USER = 'PUB_TEST_USER_ITEST';

  async function cleanupDomainsEtc() {
    await Driver.runQuery(`DROP PROCEDURE PUB_PROC2`, conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery(`DROP EXCEPTION PUB_EXC`, conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery(`DROP TABLE PUB_ACCOUNT`, conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery(`DROP DOMAIN PUB_DOMAIN`, conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery(`DROP ROLE PUB_ROLE`, conn).catch(() => { /* best-effort cleanup */ });
    await Driver.runQuery(`DROP USER ${PUB_USER}`, conn).catch(() => { /* best-effort cleanup */ });
  }

  teardown(async function () {
    await cleanupDomainsEtc();
  });

  test('a domain (default/not-null/check), an exception a procedure actually raises, a role, and a user round-trip through a real publish and execute', async function () {
    await cleanupDomainsEtc();

    // ── "target": a domain with no CHECK constraint yet, no exception, no role, no user ──
    await Driver.runQuery(`CREATE DOMAIN PUB_DOMAIN AS INTEGER DEFAULT 0 NOT NULL`, conn);
    await Driver.runQuery(`CREATE TABLE PUB_ACCOUNT (ID INTEGER NOT NULL PRIMARY KEY, BALANCE PUB_DOMAIN)`, conn);

    const targetSnapshot = await fetchProjectSnapshot(conn);
    const targetDomain = targetSnapshot.domains.find(d => d.name === 'PUB_DOMAIN');
    assert.ok(targetDomain, 'PUB_DOMAIN should exist in the target snapshot');
    assert.strictEqual(targetDomain!.check, undefined, 'target domain should not have a CHECK constraint yet');

    // ── evolve to "source": add a CHECK constraint to the domain, add an exception, a
    //    procedure that actually raises it, a role, and a user ──
    await Driver.runQuery(`ALTER DOMAIN PUB_DOMAIN ADD CONSTRAINT CHECK (VALUE >= 0)`, conn);
    await Driver.runQuery(`CREATE EXCEPTION PUB_EXC 'Balance cannot go negative'`, conn);
    await Driver.runQuery(
      `CREATE PROCEDURE PUB_PROC2 (P_ID INTEGER) AS
       DECLARE VARIABLE V_BAL INTEGER;
       BEGIN
         SELECT BALANCE FROM PUB_ACCOUNT WHERE ID = :P_ID INTO :V_BAL;
         IF (V_BAL IS NULL) THEN
           EXCEPTION PUB_EXC;
       END`,
      conn
    );
    await Driver.runQuery(`CREATE ROLE PUB_ROLE`, conn);
    await Driver.runQuery(`CREATE USER ${PUB_USER} PASSWORD 'Abc12345!'`, conn);

    const sourceSnapshot = await fetchProjectSnapshot(conn);
    const sourceDomain = sourceSnapshot.domains.find(d => d.name === 'PUB_DOMAIN');
    assert.strictEqual(sourceDomain!.check, 'CHECK (VALUE >= 0)');

    // ── revert to the stale "target" domain (drop the CHECK, everything else absent) ──
    await Driver.runQuery(`ALTER DOMAIN PUB_DOMAIN DROP CONSTRAINT`, conn);
    await Driver.runQuery(`DROP PROCEDURE PUB_PROC2`, conn);
    await Driver.runQuery(`DROP EXCEPTION PUB_EXC`, conn);
    await Driver.runQuery(`DROP ROLE PUB_ROLE`, conn);
    await Driver.runQuery(`DROP USER ${PUB_USER}`, conn);

    const revertedSnapshot = await fetchProjectSnapshot(conn);
    const diff = diffProjects(sourceSnapshot, revertedSnapshot);
    assert.strictEqual(diff.changedDomains.length, 1, 'the CHECK constraint drop should show up as a changed domain');
    assert.strictEqual(diff.newExceptions.length, 1);
    assert.strictEqual(diff.newProcedures.length, 1);
    assert.strictEqual(diff.newRoles.length, 1);
    assert.strictEqual(diff.newUsers.length, 1);

    const script = buildPublishScript(diff, revertedSnapshot);
    assert.ok(script.includes('ALTER DOMAIN PUB_DOMAIN ADD CONSTRAINT CHECK (VALUE >= 0);'), script);
    assert.ok(script.includes("CREATE OR ALTER EXCEPTION PUB_EXC 'Balance cannot go negative';"), script);
    assert.ok(script.includes(`-- CREATE USER ${PUB_USER} PASSWORD`), 'the new user must be scripted commented out');
    // The domain fix must be scripted before the procedure that references... well, PUB_PROC2
    // doesn't reference the domain by name (columnTypeToDDL() flattens it — see project-model.ts),
    // but the exception genuinely must precede the procedure that raises it.
    assert.ok(script.indexOf('CREATE OR ALTER EXCEPTION PUB_EXC') < script.indexOf('CREATE OR ALTER PROCEDURE PUB_PROC2'), script);

    const batchResults = await Driver.runBatch(script, conn);
    const failed = batchResults.filter(r => r.error);
    assert.deepStrictEqual(failed, [], `every statement in the generated publish script should succeed, but: ${JSON.stringify(failed)}`);

    // The commented-out CREATE USER must not have silently run.
    const afterPublish = await fetchProjectSnapshot(conn);
    assert.ok(!afterPublish.users.some(u => u.name === PUB_USER), 'the commented-out CREATE USER must not have actually created the user');
    assert.strictEqual(afterPublish.domains.find(d => d.name === 'PUB_DOMAIN')?.check, 'CHECK (VALUE >= 0)', 'the domain CHECK constraint must be restored');
    assert.ok(afterPublish.exceptions.some(e => e.name === 'PUB_EXC' && e.message === 'Balance cannot go negative'));
    assert.ok(afterPublish.roles.some(r => r.name === 'PUB_ROLE'));

    // Now actually uncomment and run the CREATE USER line (simulating a human reviewer who filled
    // in a real password), and confirm the procedure genuinely raises PUB_EXC end-to-end.
    await Driver.runQuery(`CREATE USER ${PUB_USER} PASSWORD 'Abc12345!'`, conn);
    const afterUserCreate = await fetchProjectSnapshot(conn);
    assert.ok(afterUserCreate.users.some(u => u.name === PUB_USER));

    let raisedCorrectly = false;
    try {
      await Driver.runQuery('EXECUTE PROCEDURE PUB_PROC2(999)', conn);
    } catch (err: any) {
      raisedCorrectly = String(err).includes('Balance cannot go negative');
    }
    assert.ok(raisedCorrectly, 'PUB_PROC2 should actually raise the restored PUB_EXC message for a missing account');

    // A second diff against the now-fully-migrated state should report no further domain/
    // exception/role/user changes.
    const finalDiff = diffProjects(sourceSnapshot, afterUserCreate);
    assert.strictEqual(finalDiff.changedDomains.length, 0);
    assert.strictEqual(finalDiff.newExceptions.length, 0);
    assert.strictEqual(finalDiff.newRoles.length, 0);
    assert.strictEqual(finalDiff.newUsers.length, 0);
  });
});
