import { v1 as uuidv1 } from "uuid";
import { ExtensionContext, workspace, window, commands, QuickPickItem, QuickPickItemKind } from "vscode";
import { Constants } from "../config/constants";

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

export function clearAllObjectFilters(): void {
  filters.clear();
}

/**
 * Case-insensitive substring match. `name` is trimmed first since Firebird's RDB$ identifier
 * columns are fixed-width CHAR, padded with trailing spaces (e.g. "PRODUCTS   ").
 */
export function matchesObjectFilter(name: string, filter: string | undefined): boolean {
  if (!filter) { return true; }
  return name.trim().toLowerCase().includes(filter.toLowerCase());
}

/**
 * Saved Object Explorer Filter Preset definition.
 * Presets can be scoped to a specific category (e.g. "tables"), a specific connection, or be universal.
 */
export interface ObjectFilterPreset {
  id: string;
  name: string;
  filter: string;
  category?: string;       // e.g. "tables", "views", or undefined for all categories
  connectionId?: string;   // optional: scoped to specific connection or undefined for all
  createdTimestamp?: number;
}

let extensionContext: ExtensionContext | undefined;
let inMemoryPresets: ObjectFilterPreset[] = [];

/**
 * Initializes preset storage with VS Code's ExtensionContext (persists to globalState).
 */
export function initObjectFilterPresets(context?: ExtensionContext): void {
  extensionContext = context;
}

/**
 * Returns user-saved filter presets stored in globalState (or in-memory fallback).
 */
export function getSavedPresets(): ObjectFilterPreset[] {
  if (extensionContext) {
    return extensionContext.globalState.get<ObjectFilterPreset[]>(Constants.ObjectFilterPresetsKey) ?? [];
  }
  return [...inMemoryPresets];
}

/**
 * Overwrites user-saved filter presets in globalState (or in-memory fallback).
 */
export async function setSavedPresets(presets: ObjectFilterPreset[]): Promise<void> {
  if (extensionContext) {
    await extensionContext.globalState.update(Constants.ObjectFilterPresetsKey, presets);
  } else {
    inMemoryPresets = [...presets];
  }
}

/**
 * Reads preset filters configured via workspace/user settings (`firebird.explorer.filterPresets`).
 */
export function getSettingPresets(): ObjectFilterPreset[] {
  try {
    const conf = workspace.getConfiguration("firebird");
    const raw = conf.get<any[]>("explorer.filterPresets");
    if (!Array.isArray(raw)) { return []; }
    return raw
      .filter(p => p && typeof p === "object" && typeof p.name === "string" && typeof p.filter === "string")
      .map((p, idx) => ({
        id: `setting-preset-${idx}-${p.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
        name: String(p.name).trim(),
        filter: String(p.filter).trim(),
        category: typeof p.category === "string" && p.category.trim() ? p.category.trim() : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Returns all active filter presets (user-saved plus setting presets), optionally filtered by category and connection.
 */
export function getAllFilterPresets(category?: string, connectionId?: string): ObjectFilterPreset[] {
  const saved = getSavedPresets();
  const settings = getSettingPresets();
  const all = [...saved, ...settings];

  return all.filter(p => {
    if (p.category && category && p.category.toLowerCase() !== category.toLowerCase()) {
      return false;
    }
    if (p.connectionId && connectionId && p.connectionId !== connectionId) {
      return false;
    }
    return true;
  });
}

/**
 * Saves a new filter preset to globalState. Overwrites an existing preset if name, category, and connectionId match.
 */
export async function saveFilterPreset(
  name: string,
  filter: string,
  category?: string,
  connectionId?: string
): Promise<ObjectFilterPreset> {
  const trimmedName = name.trim();
  const trimmedFilter = filter.trim();
  if (!trimmedName) {
    throw new Error("Preset name cannot be empty.");
  }
  if (!trimmedFilter) {
    throw new Error("Preset filter expression cannot be empty.");
  }

  const existing = getSavedPresets();
  const index = existing.findIndex(
    p => p.name.toLowerCase() === trimmedName.toLowerCase() &&
         (p.category ?? "") === (category ?? "") &&
         (p.connectionId ?? "") === (connectionId ?? "")
  );

  const newPreset: ObjectFilterPreset = {
    id: index >= 0 ? existing[index].id : uuidv1(),
    name: trimmedName,
    filter: trimmedFilter,
    category: category ? category.trim() : undefined,
    connectionId: connectionId ? connectionId.trim() : undefined,
    createdTimestamp: Date.now(),
  };

  if (index >= 0) {
    existing[index] = newPreset;
  } else {
    existing.push(newPreset);
  }

  await setSavedPresets(existing);
  return newPreset;
}

/**
 * Deletes a user-saved preset by id from globalState.
 */
export async function deleteFilterPreset(presetId: string): Promise<boolean> {
  const existing = getSavedPresets();
  const filtered = existing.filter(p => p.id !== presetId);
  if (filtered.length !== existing.length) {
    await setSavedPresets(filtered);
    return true;
  }
  return false;
}

/**
 * Interactive prompt to create and save a new filter preset.
 */
export async function promptSaveFilterPreset(
  defaultFilter?: string,
  defaultCategory?: string,
  connectionId?: string
): Promise<ObjectFilterPreset | undefined> {
  const filterInput = await window.showInputBox({
    title: "Save Filter Preset",
    prompt: "Enter filter text / substring to match against object names",
    value: defaultFilter ?? "",
    ignoreFocusOut: true,
  });
  if (filterInput === undefined || !filterInput.trim()) { return undefined; }

  const nameInput = await window.showInputBox({
    title: "Save Filter Preset",
    prompt: "Enter a descriptive name for this filter preset (e.g. 'Sales Module', 'Audit Tables')",
    value: "",
    ignoreFocusOut: true,
  });
  if (nameInput === undefined || !nameInput.trim()) { return undefined; }

  let categoryScope: string | undefined = defaultCategory;
  if (defaultCategory) {
    const scopeChoice = await window.showQuickPick([
      { label: `Scope to this category (${defaultCategory})`, category: defaultCategory },
      { label: "Universal (apply to any category folder)", category: undefined },
    ], { placeHolder: "Select scope for this preset" });
    if (!scopeChoice) { return undefined; }
    categoryScope = scopeChoice.category;
  }

  const preset = await saveFilterPreset(nameInput, filterInput, categoryScope, connectionId);
  window.showInformationMessage(`Filter preset "${preset.name}" saved!`);
  return preset;
}

/**
 * Interactive prompt to manage and delete saved filter presets.
 */
export async function promptManageFilterPresets(category?: string, connectionId?: string): Promise<void> {
  const saved = getSavedPresets();
  if (saved.length === 0) {
    window.showInformationMessage("No user-saved filter presets found.");
    return;
  }

  const items = saved.map(p => ({
    label: `$(bookmark) ${p.name}`,
    description: `Filter: "${p.filter}"`,
    detail: `Scope: ${p.category ? `Category [${p.category}]` : "Universal"}${p.connectionId ? " · Scoped to connection" : ""}`,
    preset: p,
  }));

  const selected = await window.showQuickPick(items, {
    placeHolder: "Select a preset to delete or manage",
  });
  if (!selected) { return; }

  const action = await window.showQuickPick([
    { label: "$(trash) Delete Preset", action: "delete" },
    { label: "$(arrow-left) Cancel", action: "cancel" },
  ], { placeHolder: `Action for preset "${selected.preset.name}"` });

  if (action?.action === "delete") {
    await deleteFilterPreset(selected.preset.id);
    window.showInformationMessage(`Filter preset "${selected.preset.name}" deleted.`);
  }
}

interface FilterPickerItem extends QuickPickItem {
  action?: "apply-typed" | "custom-input" | "clear" | "save-preset" | "manage-presets";
  preset?: ObjectFilterPreset;
  filterValue?: string;
}

/**
 * Displays an interactive QuickPick allowing the user to select from saved presets,
 * type a custom filter substring, clear an active filter, or save/manage presets.
 */
export async function showFilterPicker(
  connectionId: string,
  category: string,
  label: string
): Promise<void> {
  const current = getObjectFilter(connectionId, category) ?? "";
  const presets = getAllFilterPresets(category, connectionId);

  const picker = window.createQuickPick<FilterPickerItem>();
  picker.title = `Filter ${label}`;
  picker.placeholder = "Type filter text and press Enter, or choose a preset below...";
  picker.ignoreFocusOut = true;

  function buildItems(typedValue: string): FilterPickerItem[] {
    const items: FilterPickerItem[] = [];
    const trimmed = typedValue.trim();

    if (trimmed) {
      items.push({
        label: `$(filter) Apply filter: "${trimmed}"`,
        action: "apply-typed",
        filterValue: trimmed,
        alwaysShow: true,
      });
    }

    if (current) {
      items.push({
        label: `$(clear-all) Clear Active Filter ("${current}")`,
        description: "Show all objects in this folder",
        action: "clear",
        alwaysShow: true,
      });
    }

    items.push({
      label: "$(edit) Enter Custom Filter in Input Box...",
      description: current ? `Current active filter: "${current}"` : "Prompt with classic input box",
      action: "custom-input",
      alwaysShow: true,
    });

    items.push({
      label: "$(save) Save Filter as New Preset...",
      description: current ? `Save current "${current}" or create new` : "Create named preset",
      action: "save-preset",
      alwaysShow: true,
    });

    const saved = getSavedPresets();
    if (saved.length > 0) {
      items.push({
        label: "$(trash) Manage / Delete Presets...",
        description: `${saved.length} preset${saved.length === 1 ? "" : "s"} saved`,
        action: "manage-presets",
        alwaysShow: true,
      });
    }

    if (presets.length > 0) {
      items.push({
        label: "FILTER PRESETS",
        kind: QuickPickItemKind.Separator,
      });

      for (const p of presets) {
        items.push({
          label: `$(bookmark) ${p.name}`,
          description: `Filter: "${p.filter}"`,
          detail: p.category ? `Category: ${p.category}` : "Universal",
          preset: p,
        });
      }
    }

    return items;
  }

  picker.items = buildItems("");

  picker.onDidChangeValue(val => {
    picker.items = buildItems(val);
  });

  return new Promise<void>(resolve => {
    picker.onDidAccept(async () => {
      const selected = picker.selectedItems[0];
      picker.hide();

      if (!selected) {
        const typed = picker.value.trim();
        if (typed) {
          setObjectFilter(connectionId, category, typed);
          commands.executeCommand("firebird.explorer.refresh");
        }
        resolve();
        return;
      }

      if (selected.action === "apply-typed" && selected.filterValue) {
        setObjectFilter(connectionId, category, selected.filterValue);
        commands.executeCommand("firebird.explorer.refresh");
      } else if (selected.preset) {
        setObjectFilter(connectionId, category, selected.preset.filter);
        commands.executeCommand("firebird.explorer.refresh");
      } else if (selected.action === "clear") {
        clearObjectFilter(connectionId, category);
        commands.executeCommand("firebird.explorer.refresh");
      } else if (selected.action === "custom-input") {
        const input = await window.showInputBox({
          title: `Filter ${label}`,
          prompt: "Show only objects whose name contains this text (case-insensitive). Leave empty to clear.",
          value: current,
          ignoreFocusOut: true,
        });
        if (input !== undefined) {
          setObjectFilter(connectionId, category, input);
          commands.executeCommand("firebird.explorer.refresh");
        }
      } else if (selected.action === "save-preset") {
        const saved = await promptSaveFilterPreset(current || undefined, category, connectionId);
        if (saved) {
          const applyNow = await window.showQuickPick(["Yes", "No"], {
            placeHolder: `Apply preset "${saved.name}" ("${saved.filter}") now?`,
          });
          if (applyNow === "Yes") {
            setObjectFilter(connectionId, category, saved.filter);
            commands.executeCommand("firebird.explorer.refresh");
          }
        }
      } else if (selected.action === "manage-presets") {
        await promptManageFilterPresets(category, connectionId);
      }

      resolve();
    });

    picker.onDidHide(() => {
      picker.dispose();
      resolve();
    });

    picker.show();
  });
}
