import { MAX_SOURCE_CAST_LENGTH } from "./queries";

/**
 * "Actual Plan" (docs/roadmap/query-plan-visualizer.md phase 3): per-record-source execution
 * statistics from Firebird 5.0+'s built-in `RDB$PROFILER` package -- a genuinely different data
 * source from the *estimated* plan `plan-parser.ts` parses out of the legacy `PLAN (...)` text.
 * `MON$RECORD_STATS`/`MON$IO_STATS` (already used by `profilerActivityQuery()` in `queries.ts`)
 * only report I/O at the *statement* level, with no per-node breakdown -- `RDB$PROFILER` is the
 * real per-node source this phase needed, found by checking directly against a live server
 * rather than trusting that assumption. Every query/behavior below was verified the same way,
 * against a real Firebird 6.0 server (a scratch database, via `isql`):
 *
 *   - `RDB$PROFILER.START_SESSION()` begins profiling *immediately*, capturing even its own
 *     wrapping `SELECT` statement -- so the statement actually being profiled is always the
 *     *second*-lowest `STATEMENT_ID` for a session, not the lowest. Neither `SQL_TEXT` matching
 *     nor `PACKAGE_NAME` filtering reliably distinguishes "the caller's query" from
 *     `RDB$PROFILER`'s own control calls: `PACKAGE_NAME` is NULL for both the `START_SESSION`
 *     wrapper `SELECT` and the profiled query itself (only nested procedure/function calls like
 *     `FLUSH` get one set).
 *   - The `PLG$PROF_*` tables are auto-created by the engine on first `START_SESSION()` call --
 *     nothing this extension needs to provision itself.
 *   - Firebird 6.0 (the first version with SQL schema support at all) puts them in a dedicated
 *     `PLG$PROFILER` schema (`PLG$PROFILER.PLG$PROF_STATEMENTS`); an unqualified reference fails
 *     with "Table unknown." Firebird 5.0 has no schema support, so there the same tables are
 *     unqualified.
 *   - `RDB$PROFILER.CANCEL_SESSION` does *not* delete already-flushed data -- without an explicit
 *     cleanup, the `PLG$PROF_*` tables would grow forever in the user's own database every time
 *     this feature runs. `DELETE FROM PLG$PROF_SESSIONS WHERE PROFILE_ID = ...` cascades to every
 *     child table for that session (record sources, stats, statements) in one statement.
 *   - `*_ELAPSED_TIME` columns are nanoseconds, confirmed by cross-checking a deliberately slow
 *     20,000-row scan's reported elapsed time against the wall-clock time the query actually took.
 *   - Reading the profiler's own tables needs no special driver support (unlike the *estimated*
 *     plan's real `PLAN` text, which needs the native driver) -- it's plain SQL against regular
 *     (if system-owned) relations, so this works identically over `NodeClient`/`NativeClient`.
 *
 * Because an `ActualPlanNode`'s labels come from `ACCESS_PATH` text ("Select Expression" /
 * "Aggregate" / "Filter" / `Table "PUBLIC"."T1" Full Scan`) rather than `PLAN(...)`'s
 * NATURAL/INDEX/JOIN/HASH/MERGE/SORT keywords, its tree shape doesn't line up node-for-node with
 * a `PlanNode` tree -- so this is rendered as its own view, not overlaid onto the estimated
 * diagram/table/icicle views.
 */

export interface ActualPlanNode {
  recordSourceId: number;
  parentRecordSourceId: number | null;
  level: number;
  /** First line of ACCESS_PATH, with a leading "-> " stripped -- e.g. `Table "PUBLIC"."T1" Full Scan`. */
  label: string;
  /** The full (possibly multi-line) ACCESS_PATH text, for the detail panel. */
  accessPath: string;
  openCount: number;
  openElapsedMs: number;
  fetchCount: number;
  fetchElapsedMs: number;
  children: ActualPlanNode[];
}

interface RecordSourceRow {
  RECORD_SOURCE_ID: number;
  PARENT_RECORD_SOURCE_ID: number | null;
  ACCESS_PATH: string | null;
}

interface StatsRow {
  RECORD_SOURCE_ID: number;
  OPEN_COUNTER: number | null;
  OPEN_TOTAL_ELAPSED_TIME: number | null;
  FETCH_COUNTER: number | null;
  FETCH_TOTAL_ELAPSED_TIME: number | null;
}

const NANOS_PER_MS = 1_000_000;

/**
 * Builds a tree from `PLG$PROF_RECORD_SOURCES` + `PLG$PROF_RECORD_SOURCE_STATS`'s flat rows for
 * one statement. Pure and dependency-free (no `vscode`, no driver) so it's unit-testable without
 * a database, matching this repo's convention for parsing/transform logic (`plan-parser.ts`,
 * `sql-analysis.ts`).
 */
export function buildActualPlanTree(recordSources: RecordSourceRow[], stats: StatsRow[]): ActualPlanNode[] {
  const statsById = new Map(stats.map(s => [s.RECORD_SOURCE_ID, s]));
  const nodesById = new Map<number, ActualPlanNode>();

  recordSources.forEach(rs => {
    const stat = statsById.get(rs.RECORD_SOURCE_ID);
    const accessPath = (rs.ACCESS_PATH ?? "").trim();
    const firstLine = accessPath.split("\n")[0].replace(/^->\s*/, "").trim();
    nodesById.set(rs.RECORD_SOURCE_ID, {
      recordSourceId: rs.RECORD_SOURCE_ID,
      parentRecordSourceId: rs.PARENT_RECORD_SOURCE_ID ?? null,
      level: 0,
      label: firstLine || accessPath || `Record source ${rs.RECORD_SOURCE_ID}`,
      accessPath,
      openCount: stat?.OPEN_COUNTER ?? 0,
      openElapsedMs: (stat?.OPEN_TOTAL_ELAPSED_TIME ?? 0) / NANOS_PER_MS,
      fetchCount: stat?.FETCH_COUNTER ?? 0,
      fetchElapsedMs: (stat?.FETCH_TOTAL_ELAPSED_TIME ?? 0) / NANOS_PER_MS,
      children: [],
    });
  });

  const roots: ActualPlanNode[] = [];
  nodesById.forEach(node => {
    const parent = node.parentRecordSourceId != null ? nodesById.get(node.parentRecordSourceId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  // LEVEL isn't trusted from the source rows (a node with no reachable parent would otherwise
  // keep whatever LEVEL the server reported for it) -- derived here from the tree actually built,
  // so it's always consistent with parentRecordSourceId/children.
  const byId = (a: ActualPlanNode, b: ActualPlanNode) => a.recordSourceId - b.recordSourceId;
  const assignLevels = (node: ActualPlanNode, level: number) => {
    node.level = level;
    node.children.sort(byId);
    node.children.forEach(child => assignLevels(child, level + 1));
  };
  roots.sort(byId);
  roots.forEach(node => assignLevels(node, 0));
  return roots;
}

/** Parses "N.M.P..." into just the major version number, or 0 if unparseable. */
export function parseEngineMajorVersion(engineVersion: string): number {
  const match = /^(\d+)\./.exec(engineVersion.trim());
  return match ? parseInt(match[1], 10) : 0;
}

/** RDB$PROFILER (and the PLG$PROF_* tables it auto-creates) needs Firebird 5.0 or newer. */
export function isProfilerSupported(engineMajorVersion: number): boolean {
  return engineMajorVersion >= 5;
}

/** See this file's header comment for how this was verified against a live server. */
export function profilerSchemaPrefix(engineMajorVersion: number): string {
  return engineMajorVersion >= 6 ? "PLG$PROFILER." : "";
}

function assertValidId(id: number, what: string): void {
  if (!Number.isInteger(id)) {
    throw new Error(`Invalid ${what}.`);
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function startProfilerSessionQuery(description: string): string {
  return `SELECT RDB$PROFILER.START_SESSION(DESCRIPTION => '${escapeSqlLiteral(description)}') AS PROFILE_ID FROM RDB$DATABASE;`;
}

export const flushProfilerQuery = `EXECUTE PROCEDURE RDB$PROFILER.FLUSH;`;

/**
 * Must run right after flushProfilerQuery and before any of the read/correlation queries below --
 * verified directly against a live server that this is not just tidiness: while a session is
 * still active, *every* statement executed on the connection gets profiled, including the
 * diagnostic SELECTs this module itself runs afterward to read the profiler's own tables. Without
 * stopping the session first, those diagnostic queries pollute the very session being read (and,
 * worse, some of that self-referential data can land in PLG$PROF_RECORD_SOURCES *after* the
 * cleanup DELETE already ran, since it isn't flushed yet at that point -- leaving orphaned rows
 * behind). `FALSE` here means "don't flush again" (the one flush already done captured everything
 * this module needs); it does not discard already-flushed data.
 */
export const finishProfilerSessionQuery = `EXECUTE PROCEDURE RDB$PROFILER.FINISH_SESSION(FALSE);`;

/**
 * Identifies the profiled query by an exact `SQL_TEXT` match, not by position (`STATEMENT_ID`
 * ordinal within the session was tried first and found unreliable on a live server: Firebird
 * appears to reuse/cache a prepared statement's id across separate executions of identical SQL
 * text within the same attachment -- since `getActualPlan()` runs the *same* `ENGINE_VERSION`
 * check on every call, a second call's "lowest" or "second-lowest" `STATEMENT_ID` for its own
 * `PROFILE_ID` could actually be a stale id carried over from an earlier call's cached statement,
 * not this session's own statements at all. `ORDER BY STATEMENT_ID DESC` picks the most recent
 * match in the (normally impossible, but not worth failing on) case of two identical-text
 * statements landing in the same session.
 */
export function profiledStatementIdQuery(schemaPrefix: string, profileId: number, sql: string): string {
  assertValidId(profileId, "profile id");
  return `SELECT FIRST 1 STATEMENT_ID FROM ${schemaPrefix}PLG$PROF_STATEMENTS
           WHERE PROFILE_ID = ${profileId}
             AND CAST(SQL_TEXT AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) = '${escapeSqlLiteral(sql)}'
        ORDER BY STATEMENT_ID DESC;`;
}

export function profilerRecordSourcesQuery(schemaPrefix: string, profileId: number, statementId: number): string {
  assertValidId(profileId, "profile id");
  assertValidId(statementId, "statement id");
  return `SELECT RECORD_SOURCE_ID, PARENT_RECORD_SOURCE_ID,
                 CAST(ACCESS_PATH AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS ACCESS_PATH
            FROM ${schemaPrefix}PLG$PROF_RECORD_SOURCES
           WHERE PROFILE_ID = ${profileId} AND STATEMENT_ID = ${statementId}
        ORDER BY RECORD_SOURCE_ID;`;
}

export function profilerRecordSourceStatsQuery(schemaPrefix: string, profileId: number, statementId: number): string {
  assertValidId(profileId, "profile id");
  assertValidId(statementId, "statement id");
  return `SELECT RECORD_SOURCE_ID, OPEN_COUNTER, OPEN_TOTAL_ELAPSED_TIME, FETCH_COUNTER, FETCH_TOTAL_ELAPSED_TIME
            FROM ${schemaPrefix}PLG$PROF_RECORD_SOURCE_STATS
           WHERE PROFILE_ID = ${profileId} AND STATEMENT_ID = ${statementId};`;
}

/** Cascades to every child row for this session -- see this file's header comment for why this
 *  cleanup step exists at all (CANCEL_SESSION alone doesn't do it). */
export function cleanupProfilerSessionQuery(schemaPrefix: string, profileId: number): string {
  assertValidId(profileId, "profile id");
  return `DELETE FROM ${schemaPrefix}PLG$PROF_SESSIONS WHERE PROFILE_ID = ${profileId};`;
}
