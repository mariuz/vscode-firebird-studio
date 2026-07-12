/**
 * In-memory (not persisted — resets on window reload, same lifetime as Global.activeConnection),
 * per-connection, per-category name filters for the DB Explorer tree's category folders (Tables,
 * Views, Procedures, ...). Narrows a folder's children to objects whose name contains the filter
 * substring — distinct from Object Search's one-shot fuzzy QuickPick lookup across every object
 * type at once, this narrows what's actually shown in the tree itself, scoped to one folder.
 */

const filters = new Map<string, string>();

function filterKey(connectionId: string, category: string): string {
  return `${connectionId}::${category}`;
}

export function getObjectFilter(connectionId: string, category: string): string | undefined {
  return filters.get(filterKey(connectionId, category));
}

/** Setting an empty/whitespace-only filter clears it. */
export function setObjectFilter(connectionId: string, category: string, filter: string): void {
  const trimmed = filter.trim();
  if (trimmed === "") {
    filters.delete(filterKey(connectionId, category));
  } else {
    filters.set(filterKey(connectionId, category), trimmed);
  }
}

export function clearObjectFilter(connectionId: string, category: string): void {
  filters.delete(filterKey(connectionId, category));
}

/**
 * Case-insensitive substring match. `name` is trimmed first since Firebird's RDB$ identifier
 * columns are fixed-width CHAR, padded with trailing spaces (e.g. "PRODUCTS   ").
 */
export function matchesObjectFilter(name: string, filter: string | undefined): boolean {
  if (!filter) { return true; }
  return name.trim().toLowerCase().includes(filter.toLowerCase());
}
