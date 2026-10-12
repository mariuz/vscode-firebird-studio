import { ConnectionOptions } from '../interfaces';
import { Driver } from '../shared/driver';
import {
  getTablesQuery,
  fieldsQuery,
  getViewsQuery,
  getStoredProceduresQuery,
  getTriggersQuery,
} from '../shared/queries';
import { getEngineMajorVersion } from "../shared/engine-version";
import { supportsSchemas, schemaDisplayName } from "../shared/schema-support";

export interface SchemaSnapshot {
  tables: TableSnapshot[];
  views: string[];
  procedures: string[];
  triggers: TriggerSnapshot[];
}

export interface TableSnapshot {
  name: string;
  columns: ColumnSnapshot[];
}

export interface ColumnSnapshot {
  name: string;
  type: string;
  length: number;
  notNull: boolean;
}

export interface TriggerSnapshot {
  name: string;
  table: string;
  type: number;
  inactive: boolean;
}

export interface SchemaDiffResult {
  tablesOnlyInSource: string[];
  tablesOnlyInTarget: string[];
  modifiedTables: ModifiedTable[];
  viewsOnlyInSource: string[];
  viewsOnlyInTarget: string[];
  proceduresOnlyInSource: string[];
  proceduresOnlyInTarget: string[];
  triggersOnlyInSource: TriggerSnapshot[];
  triggersOnlyInTarget: TriggerSnapshot[];
}

export interface ModifiedTable {
  name: string;
  columnsOnlyInSource: ColumnSnapshot[];
  columnsOnlyInTarget: ColumnSnapshot[];
  modifiedColumns: { source: ColumnSnapshot; target: ColumnSnapshot }[];
}

/** Fetches the schema snapshot for a given connection */
export async function fetchSchemaSnapshot(conn: ConnectionOptions, maxTables: number): Promise<SchemaSnapshot> {
  const connection = await Driver.client.createConnection(conn);
  try {
    // Firebird 6 keeps every object in a schema. Without asking for it, two same-named tables in
    // different schemas collapse into one snapshot entry whose columns are the union of both — so
    // a diff would report phantom added/removed columns for a table that does not exist. Gated on
    // the server version, since RDB$SCHEMA_NAME is a hard error before Firebird 6.
    const withSchemas = supportsSchemas(
      await getEngineMajorVersion(conn.id, (sql: string) => Driver.client.queryPromise<any>(connection, sql))
    );
    /**
     * Snapshot key and display name.
     *
     * Uses the *display* form — bare in the default schema, qualified elsewhere — rather than
     * always qualifying. Two reasons. A single-schema Firebird 6 database then produces exactly
     * the snapshot it produced before schemas existed, so a comparison against a Firebird 5
     * database (or a project extracted from one) still lines up. And Database Projects names its
     * files the same way, so publish compares like with like; qualifying unconditionally made
     * every object in a single-schema database look renamed, which the suite-tier publish tests
     * caught as `PUB_PARENT should exist in the target snapshot`.
     */
    const qualify = (schema: unknown, name: unknown) =>
      schemaDisplayName(withSchemas ? String(schema ?? "") : undefined, String(name ?? ""));

    // Tables
    const tableRows: any[] = await Driver.client.queryPromise(connection, getTablesQuery(maxTables, withSchemas));
    const tableNames = (tableRows ?? []).map(r => qualify(r.SCHEMA_NAME, r.TABLE_NAME));

    let columns: any[] = [];
    if (tableNames.length > 0) {
      // The IN list matches on bare relation names; rows are then keyed by schema + name below,
      // which is what keeps two same-named tables apart.
      const bareNames = (tableRows ?? []).map(r => String(r.TABLE_NAME).trim());
      columns = await Driver.client.queryPromise(connection, fieldsQuery(bareNames, withSchemas));
    }

    const tableMap: Record<string, ColumnSnapshot[]> = {};
    for (const name of tableNames) {
      tableMap[name] = [];
    }
    for (const col of (columns ?? [])) {
      const tbl = qualify(col.SCHEMA_NAME, col.TBL);
      if (tableMap[tbl]) {
        tableMap[tbl].push({
          name: col.FIELD.trim(),
          type: col.FIELD_TYPE.trim(),
          length: col.FIELD_LENGTH ?? 0,
          notNull: col.NOTNULL === '1',
        });
      }
    }

    const tables: TableSnapshot[] = tableNames.map(name => ({
      name,
      columns: tableMap[name] ?? [],
    }));

    // Views
    const viewRows: any[] = await Driver.client.queryPromise(connection, getViewsQuery(withSchemas));
    const views = (viewRows ?? []).map(r => qualify(r.SCHEMA_NAME, r.VIEW_NAME));

    // Procedures
    const procRows: any[] = await Driver.client.queryPromise(connection, getStoredProceduresQuery(withSchemas));
    const procedures = (procRows ?? []).map(r => qualify(r.SCHEMA_NAME, r.PROCEDURE_NAME));

    // Triggers
    const trigRows: any[] = await Driver.client.queryPromise(connection, getTriggersQuery(withSchemas));
    const triggers: TriggerSnapshot[] = (trigRows ?? []).map(r => ({
      name: qualify(r.SCHEMA_NAME, r.TRIGGER_NAME),
      table: r.TABLE_NAME ? qualify(r.SCHEMA_NAME, r.TABLE_NAME) : '',
      type: r.TRIGGER_TYPE ?? 0,
      inactive: !!r.INACTIVE,
    }));

    return { tables, views, procedures, triggers };
  } finally {
    await Driver.client.detach(connection);
  }
}

export interface SchemaDiffFilter {
  /** Include table differences (default: true) */
  tables?: boolean;
  /** Include view differences (default: true) */
  views?: boolean;
  /** Include stored procedure differences (default: true) */
  procedures?: boolean;
  /** Include trigger differences (default: true) */
  triggers?: boolean;
  /** Include objects/columns only in source / added (default: true) */
  added?: boolean;
  /** Include objects/columns only in target / removed (default: true) */
  removed?: boolean;
  /** Include modified tables and columns (default: true) */
  modified?: boolean;
  /** Optional filter pattern (substring or RegExp) matched against object names */
  namePattern?: string | RegExp;
}

export const DEFAULT_SCHEMA_DIFF_FILTER: Readonly<Required<Omit<SchemaDiffFilter, 'namePattern'>>> = {
  tables: true,
  views: true,
  procedures: true,
  triggers: true,
  added: true,
  removed: true,
  modified: true,
};

export function isFilterActive(filter?: SchemaDiffFilter): boolean {
  if (!filter) {
    return false;
  }
  return (
    filter.tables === false ||
    filter.views === false ||
    filter.procedures === false ||
    filter.triggers === false ||
    filter.added === false ||
    filter.removed === false ||
    filter.modified === false ||
    Boolean(filter.namePattern)
  );
}

export function formatFilterSummary(filter: SchemaDiffFilter): string {
  const catParts: string[] = [];
  if (filter.tables !== false) catParts.push('Tables');
  if (filter.views !== false) catParts.push('Views');
  if (filter.procedures !== false) catParts.push('Procedures');
  if (filter.triggers !== false) catParts.push('Triggers');

  const actionParts: string[] = [];
  if (filter.added !== false) actionParts.push('Added');
  if (filter.removed !== false) actionParts.push('Removed');
  if (filter.modified !== false) actionParts.push('Modified');

  const summaryParts: string[] = [];
  if (catParts.length < 4) {
    summaryParts.push(`Categories: ${catParts.join(', ') || 'None'}`);
  }
  if (actionParts.length < 3) {
    summaryParts.push(`Actions: ${actionParts.join(', ') || 'None'}`);
  }
  if (filter.namePattern) {
    const pStr = filter.namePattern instanceof RegExp ? filter.namePattern.toString() : `"${filter.namePattern}"`;
    summaryParts.push(`Name matching ${pStr}`);
  }
  return summaryParts.join(' · ') || 'All objects and actions';
}

function matchesName(name: string, pattern?: string | RegExp): boolean {
  if (!pattern) {
    return true;
  }
  if (pattern instanceof RegExp) {
    return pattern.test(name);
  }
  return name.toLowerCase().includes(pattern.toLowerCase());
}

/** Filters an existing SchemaDiffResult according to a SchemaDiffFilter */
export function filterDiffResult(diff: SchemaDiffResult, filter?: SchemaDiffFilter): SchemaDiffResult {
  if (!filter) {
    return diff;
  }

  const includeTables = filter.tables !== false;
  const includeViews = filter.views !== false;
  const includeProcs = filter.procedures !== false;
  const includeTriggers = filter.triggers !== false;
  const includeAdded = filter.added !== false;
  const includeRemoved = filter.removed !== false;
  const includeModified = filter.modified !== false;
  const namePattern = filter.namePattern;

  // Tables
  let tablesOnlyInSource: string[] = [];
  let tablesOnlyInTarget: string[] = [];
  const modifiedTables: ModifiedTable[] = [];

  if (includeTables) {
    if (includeAdded) {
      tablesOnlyInSource = diff.tablesOnlyInSource.filter(name => matchesName(name, namePattern));
    }
    if (includeRemoved) {
      tablesOnlyInTarget = diff.tablesOnlyInTarget.filter(name => matchesName(name, namePattern));
    }
    if (includeModified) {
      for (const t of diff.modifiedTables) {
        if (!matchesName(t.name, namePattern)) {
          continue;
        }
        const colsSource = includeAdded ? t.columnsOnlyInSource : [];
        const colsTarget = includeRemoved ? t.columnsOnlyInTarget : [];
        const modifiedCols = includeModified ? t.modifiedColumns : [];

        if (colsSource.length > 0 || colsTarget.length > 0 || modifiedCols.length > 0) {
          modifiedTables.push({
            name: t.name,
            columnsOnlyInSource: colsSource,
            columnsOnlyInTarget: colsTarget,
            modifiedColumns: modifiedCols,
          });
        }
      }
    }
  }

  // Views
  let viewsOnlyInSource: string[] = [];
  let viewsOnlyInTarget: string[] = [];
  if (includeViews) {
    if (includeAdded) {
      viewsOnlyInSource = diff.viewsOnlyInSource.filter(name => matchesName(name, namePattern));
    }
    if (includeRemoved) {
      viewsOnlyInTarget = diff.viewsOnlyInTarget.filter(name => matchesName(name, namePattern));
    }
  }

  // Procedures
  let proceduresOnlyInSource: string[] = [];
  let proceduresOnlyInTarget: string[] = [];
  if (includeProcs) {
    if (includeAdded) {
      proceduresOnlyInSource = diff.proceduresOnlyInSource.filter(name => matchesName(name, namePattern));
    }
    if (includeRemoved) {
      proceduresOnlyInTarget = diff.proceduresOnlyInTarget.filter(name => matchesName(name, namePattern));
    }
  }

  // Triggers
  let triggersOnlyInSource: TriggerSnapshot[] = [];
  let triggersOnlyInTarget: TriggerSnapshot[] = [];
  if (includeTriggers) {
    const matchesTrigger = (t: TriggerSnapshot) =>
      matchesName(t.name, namePattern) || (t.table ? matchesName(t.table, namePattern) : false);

    if (includeAdded) {
      triggersOnlyInSource = diff.triggersOnlyInSource.filter(matchesTrigger);
    }
    if (includeRemoved) {
      triggersOnlyInTarget = diff.triggersOnlyInTarget.filter(matchesTrigger);
    }
  }

  return {
    tablesOnlyInSource,
    tablesOnlyInTarget,
    modifiedTables,
    viewsOnlyInSource,
    viewsOnlyInTarget,
    proceduresOnlyInSource,
    proceduresOnlyInTarget,
    triggersOnlyInSource,
    triggersOnlyInTarget,
  };
}

/** Compares two schema snapshots and returns the differences, optionally filtered */
export function diffSchemas(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  filter?: SchemaDiffFilter
): SchemaDiffResult {
  const sourceTableMap = new Map(source.tables.map(t => [t.name, t]));
  const targetTableMap = new Map(target.tables.map(t => [t.name, t]));

  const tablesOnlyInSource = source.tables.map(t => t.name).filter(n => !targetTableMap.has(n));
  const tablesOnlyInTarget = target.tables.map(t => t.name).filter(n => !sourceTableMap.has(n));

  const modifiedTables: ModifiedTable[] = [];
  for (const sourceTbl of source.tables) {
    const targetTbl = targetTableMap.get(sourceTbl.name);
    if (!targetTbl) {
      continue;
    }
    const sourceColMap = new Map(sourceTbl.columns.map(c => [c.name, c]));
    const targetColMap = new Map(targetTbl.columns.map(c => [c.name, c]));

    const columnsOnlyInSource = sourceTbl.columns.filter(c => !targetColMap.has(c.name));
    const columnsOnlyInTarget = targetTbl.columns.filter(c => !sourceColMap.has(c.name));
    const modifiedColumns: { source: ColumnSnapshot; target: ColumnSnapshot }[] = [];

    for (const sourceCol of sourceTbl.columns) {
      const targetCol = targetColMap.get(sourceCol.name);
      if (targetCol && !columnsEqual(sourceCol, targetCol)) {
        modifiedColumns.push({ source: sourceCol, target: targetCol });
      }
    }

    if (columnsOnlyInSource.length > 0 || columnsOnlyInTarget.length > 0 || modifiedColumns.length > 0) {
      modifiedTables.push({ name: sourceTbl.name, columnsOnlyInSource, columnsOnlyInTarget, modifiedColumns });
    }
  }

  const sourceViews = new Set(source.views);
  const targetViews = new Set(target.views);
  const viewsOnlyInSource = source.views.filter(v => !targetViews.has(v));
  const viewsOnlyInTarget = target.views.filter(v => !sourceViews.has(v));

  const sourceProcs = new Set(source.procedures);
  const targetProcs = new Set(target.procedures);
  const proceduresOnlyInSource = source.procedures.filter(p => !targetProcs.has(p));
  const proceduresOnlyInTarget = target.procedures.filter(p => !sourceProcs.has(p));

  const targetTrigNames = new Set(target.triggers.map(t => t.name));
  const sourceTrigNames = new Set(source.triggers.map(t => t.name));
  const triggersOnlyInSource = source.triggers.filter(t => !targetTrigNames.has(t.name));
  const triggersOnlyInTarget = target.triggers.filter(t => !sourceTrigNames.has(t.name));

  const rawDiff: SchemaDiffResult = {
    tablesOnlyInSource,
    tablesOnlyInTarget,
    modifiedTables,
    viewsOnlyInSource,
    viewsOnlyInTarget,
    proceduresOnlyInSource,
    proceduresOnlyInTarget,
    triggersOnlyInSource,
    triggersOnlyInTarget,
  };

  return filter ? filterDiffResult(rawDiff, filter) : rawDiff;
}

/** Renders a SchemaDiffResult as a human-readable text report */
export function renderDiffReport(
  diff: SchemaDiffResult,
  sourceLabel: string,
  targetLabel: string,
  filter?: SchemaDiffFilter
): string {
  const activeDiff = filter ? filterDiffResult(diff, filter) : diff;
  const lines: string[] = [];

  lines.push(`SCHEMA DIFF: ${sourceLabel}  →  ${targetLabel}`);
  lines.push('='.repeat(70));
  if (isFilterActive(filter)) {
    lines.push(`Filter: ${formatFilterSummary(filter!)}`);
    lines.push('');
  } else {
    lines.push('');
  }

  // Tables
  if (filter?.tables !== false) {
    lines.push('── TABLES ──────────────────────────────────────────────────────────');
    if (activeDiff.tablesOnlyInSource.length === 0 && activeDiff.tablesOnlyInTarget.length === 0 && activeDiff.modifiedTables.length === 0) {
      lines.push('  (no differences)');
    } else {
      for (const t of activeDiff.tablesOnlyInSource) {
        lines.push(`  + ${t}  [only in source]`);
      }
      for (const t of activeDiff.tablesOnlyInTarget) {
        lines.push(`  - ${t}  [only in target]`);
      }
      for (const t of activeDiff.modifiedTables) {
        lines.push(`  ~ ${t.name}  [modified]`);
        for (const c of t.columnsOnlyInSource) {
          lines.push(`      + column: ${c.name} ${c.type}${c.length > 0 ? `(${c.length})` : ''}${c.notNull ? ' NOT NULL' : ''}`);
        }
        for (const c of t.columnsOnlyInTarget) {
          lines.push(`      - column: ${c.name} ${c.type}${c.length > 0 ? `(${c.length})` : ''}${c.notNull ? ' NOT NULL' : ''}`);
        }
        for (const m of t.modifiedColumns) {
          lines.push(`      ~ column: ${m.source.name}`);
          lines.push(`          source: ${m.source.type}(${m.source.length})${m.source.notNull ? ' NOT NULL' : ''}`);
          lines.push(`          target: ${m.target.type}(${m.target.length})${m.target.notNull ? ' NOT NULL' : ''}`);
        }
      }
    }
    lines.push('');
  }

  // Views
  if (filter?.views !== false) {
    lines.push('── VIEWS ───────────────────────────────────────────────────────────');
    if (activeDiff.viewsOnlyInSource.length === 0 && activeDiff.viewsOnlyInTarget.length === 0) {
      lines.push('  (no differences)');
    } else {
      for (const v of activeDiff.viewsOnlyInSource) {
        lines.push(`  + ${v}  [only in source]`);
      }
      for (const v of activeDiff.viewsOnlyInTarget) {
        lines.push(`  - ${v}  [only in target]`);
      }
    }
    lines.push('');
  }

  // Procedures
  if (filter?.procedures !== false) {
    lines.push('── STORED PROCEDURES ───────────────────────────────────────────────');
    if (activeDiff.proceduresOnlyInSource.length === 0 && activeDiff.proceduresOnlyInTarget.length === 0) {
      lines.push('  (no differences)');
    } else {
      for (const p of activeDiff.proceduresOnlyInSource) {
        lines.push(`  + ${p}  [only in source]`);
      }
      for (const p of activeDiff.proceduresOnlyInTarget) {
        lines.push(`  - ${p}  [only in target]`);
      }
    }
    lines.push('');
  }

  // Triggers
  if (filter?.triggers !== false) {
    lines.push('── TRIGGERS ────────────────────────────────────────────────────────');
    if (activeDiff.triggersOnlyInSource.length === 0 && activeDiff.triggersOnlyInTarget.length === 0) {
      lines.push('  (no differences)');
    } else {
      for (const t of activeDiff.triggersOnlyInSource) {
        lines.push(`  + ${t.name} ON ${t.table}  [only in source]`);
      }
      for (const t of activeDiff.triggersOnlyInTarget) {
        lines.push(`  - ${t.name} ON ${t.table}  [only in target]`);
      }
    }
    lines.push('');
  }

  lines.push('='.repeat(70));

  return lines.join('\n');
}


function columnsEqual(a: ColumnSnapshot, b: ColumnSnapshot): boolean {
  return a.type === b.type && a.length === b.length && a.notNull === b.notNull;
}

/**
 * Renders a SchemaDiffResult as a rich GitHub-Flavoured Markdown document suitable for displaying
 * in VS Code's built-in Markdown preview.  The output is structured for scannability:
 *
 *  - A top-level summary table (counts per category)
 *  - Per-section details using emoji sigils (🆕 added · 🗑️ removed · ✏️ modified)
 *  - Column-level changes laid out as proper Markdown tables
 *  - GFM `<details>` blocks to keep long diffs compact
 */
export function renderDiffMarkdown(
  diff: SchemaDiffResult,
  sourceLabel: string,
  targetLabel: string,
  generatedAt: Date = new Date(),
  filter?: SchemaDiffFilter
): string {
  const activeDiff = filter ? filterDiffResult(diff, filter) : diff;
  const ts = generatedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const totalChanges =
    activeDiff.tablesOnlyInSource.length + activeDiff.tablesOnlyInTarget.length + activeDiff.modifiedTables.length +
    activeDiff.viewsOnlyInSource.length + activeDiff.viewsOnlyInTarget.length +
    activeDiff.proceduresOnlyInSource.length + activeDiff.proceduresOnlyInTarget.length +
    activeDiff.triggersOnlyInSource.length + activeDiff.triggersOnlyInTarget.length;

  const lines: string[] = [];

  lines.push(`# 🔍 Firebird Schema Diff`);
  lines.push('');
  lines.push(`**Source:** \`${sourceLabel}\``);
  lines.push(`**Target:** \`${targetLabel}\``);
  lines.push(`**Generated:** ${ts}`);
  if (isFilterActive(filter)) {
    lines.push(`**Filter:** ${formatFilterSummary(filter!)}`);
  }
  lines.push('');

  if (totalChanges === 0) {
    if (isFilterActive(filter)) {
      lines.push('> ℹ️ **No differences found matching active filter.**');
    } else {
      lines.push('> ✅ **Schemas are identical** — no differences found.');
    }
    lines.push('');
    return lines.join('\n');
  }

  // --- Summary table ---
  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | 🆕 Added (source only) | 🗑️ Removed (target only) | ✏️ Modified |');
  lines.push('|---|---|---|---|');
  if (filter?.tables !== false) {
    lines.push(`| Tables | ${activeDiff.tablesOnlyInSource.length} | ${activeDiff.tablesOnlyInTarget.length} | ${activeDiff.modifiedTables.length} |`);
  } else {
    lines.push(`| Tables | *(filtered out)* | *(filtered out)* | *(filtered out)* |`);
  }
  if (filter?.views !== false) {
    lines.push(`| Views | ${activeDiff.viewsOnlyInSource.length} | ${activeDiff.viewsOnlyInTarget.length} | — |`);
  } else {
    lines.push(`| Views | *(filtered out)* | *(filtered out)* | — |`);
  }
  if (filter?.procedures !== false) {
    lines.push(`| Procedures | ${activeDiff.proceduresOnlyInSource.length} | ${activeDiff.proceduresOnlyInTarget.length} | — |`);
  } else {
    lines.push(`| Procedures | *(filtered out)* | *(filtered out)* | — |`);
  }
  if (filter?.triggers !== false) {
    lines.push(`| Triggers | ${activeDiff.triggersOnlyInSource.length} | ${activeDiff.triggersOnlyInTarget.length} | — |`);
  } else {
    lines.push(`| Triggers | *(filtered out)* | *(filtered out)* | — |`);
  }
  lines.push('');

  // --- Tables ---
  const hasTableChanges = filter?.tables !== false && (activeDiff.tablesOnlyInSource.length > 0 || activeDiff.tablesOnlyInTarget.length > 0 || activeDiff.modifiedTables.length > 0);
  if (hasTableChanges) {
    lines.push('## Tables');
    lines.push('');

    for (const t of activeDiff.tablesOnlyInSource) {
      lines.push(`### 🆕 \`${t}\` *(only in source)*`);
      lines.push('');
    }
    for (const t of activeDiff.tablesOnlyInTarget) {
      lines.push(`### 🗑️ \`${t}\` *(only in target)*`);
      lines.push('');
    }
    for (const t of activeDiff.modifiedTables) {
      const colChangeCount = t.columnsOnlyInSource.length + t.columnsOnlyInTarget.length + t.modifiedColumns.length;
      lines.push(`### ✏️ \`${t.name}\` — ${colChangeCount} column change${colChangeCount === 1 ? '' : 's'}`);
      lines.push('');

      if (t.columnsOnlyInSource.length > 0 || t.columnsOnlyInTarget.length > 0 || t.modifiedColumns.length > 0) {
        lines.push('<details open>');
        lines.push('<summary>Column changes</summary>');
        lines.push('');
        lines.push('| Change | Column | Type | Length | Not Null |');
        lines.push('|---|---|---|---|---|');
        for (const c of t.columnsOnlyInSource) {
          lines.push(`| 🆕 Added | \`${c.name}\` | ${c.type} | ${c.length > 0 ? c.length : '—'} | ${c.notNull ? 'YES' : 'no'} |`);
        }
        for (const c of t.columnsOnlyInTarget) {
          lines.push(`| 🗑️ Removed | \`${c.name}\` | ${c.type} | ${c.length > 0 ? c.length : '—'} | ${c.notNull ? 'YES' : 'no'} |`);
        }
        for (const m of t.modifiedColumns) {
          lines.push(`| ✏️ Modified | \`${m.source.name}\` | ${m.source.type} → ${m.target.type} | ${m.source.length} → ${m.target.length} | ${m.source.notNull ? 'YES' : 'no'} → ${m.target.notNull ? 'YES' : 'no'} |`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }
  }

  // --- Views ---
  const hasViewChanges = filter?.views !== false && (activeDiff.viewsOnlyInSource.length > 0 || activeDiff.viewsOnlyInTarget.length > 0);
  if (hasViewChanges) {
    lines.push('## Views');
    lines.push('');
    for (const v of activeDiff.viewsOnlyInSource) {
      lines.push(`- 🆕 \`${v}\` *(only in source)*`);
    }
    for (const v of activeDiff.viewsOnlyInTarget) {
      lines.push(`- 🗑️ \`${v}\` *(only in target)*`);
    }
    lines.push('');
  }

  // --- Procedures ---
  const hasProcChanges = filter?.procedures !== false && (activeDiff.proceduresOnlyInSource.length > 0 || activeDiff.proceduresOnlyInTarget.length > 0);
  if (hasProcChanges) {
    lines.push('## Stored Procedures');
    lines.push('');
    for (const p of activeDiff.proceduresOnlyInSource) {
      lines.push(`- 🆕 \`${p}\` *(only in source)*`);
    }
    for (const p of activeDiff.proceduresOnlyInTarget) {
      lines.push(`- 🗑️ \`${p}\` *(only in target)*`);
    }
    lines.push('');
  }

  // --- Triggers ---
  const hasTriggerChanges = filter?.triggers !== false && (activeDiff.triggersOnlyInSource.length > 0 || activeDiff.triggersOnlyInTarget.length > 0);
  if (hasTriggerChanges) {
    lines.push('## Triggers');
    lines.push('');
    for (const t of activeDiff.triggersOnlyInSource) {
      lines.push(`- 🆕 \`${t.name}\` on \`${t.table}\` *(only in source)*`);
    }
    for (const t of activeDiff.triggersOnlyInTarget) {
      lines.push(`- 🗑️ \`${t.name}\` on \`${t.table}\` *(only in target)*`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`*Generated by [Firebird Studio](https://marketplace.visualstudio.com/items?itemName=AdrianMariusPopa.vscode-firebird-studio) — ${ts}*`);
  lines.push('');

  return lines.join('\n');
}

