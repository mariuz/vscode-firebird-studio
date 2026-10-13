# Saved Object Explorer Filter Presets

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql) 1.46.0 — "ability to save custom filters directly within the Object Explorer Filters dialog".

## Motivation & Overview

In large production Firebird databases containing hundreds of tables, views, stored procedures, and triggers, database developers repeatedly type the same filter substrings (e.g. `SALES_`, `AUDIT_`, `LOG_`, `_V1`, `SYS_`) to locate related objects.

Previously, Firebird Studio provided only a transient, single-folder input box via `firebird.folder.setFilter` that reset whenever cleared and could not be reused or persisted across sessions.

With Saved Object Explorer Filter Presets:
1. **Named Presets**: Developers can save custom filter expressions with friendly names (e.g., `"Sales Module"`, `"Audit Logs"`, `"Reporting Views"`).
2. **Category & Connection Scoping**: Presets can be scoped to a specific object category (`tables`, `views`, `procedures`, etc.), scoped to a specific database connection, or defined universally across all folders.
3. **Interactive Filter QuickPick**: Right-clicking any category folder and selecting **Filter Objects...** (`firebird.folder.setFilter`) opens a rich QuickPick where users can:
   - Immediately apply any saved or configured filter preset with a single click.
   - Type filter text directly in the search bar and press Enter for instantaneous filtering.
   - Clear active filters with a single click.
   - Save the current filter as a new preset.
   - Manage and delete existing presets.
4. **Persistent Storage & Workspace Settings**:
   - User-saved presets are persisted across VS Code sessions in `context.globalState` (`firebird.objectFilterPresets`).
   - Team-shared presets can be checked into repository workspace settings via `firebird.explorer.filterPresets` in `.vscode/settings.json`.

## Configuration Settings

- `firebird.explorer.filterPresets`: Array of preset definitions:
  - `name`: Display name of the preset (e.g., `"Sales Module"`).
  - `filter`: Substring to match against object names.
  - `category` *(optional)*: Scoped object category (`tables`, `views`, `procedures`, `triggers`, `generators`, `domains`, `roles`, `exceptions`, `users`).

## Commands Contributed

- `firebird.folder.setFilter`: Open the interactive filter & preset picker for the selected folder (`filter@0`).
- `firebird.folder.clearFilter`: Clear active filter on the selected folder (`filter@1`).
- `firebird.folder.savePreset`: Quick action to save a filter as a named preset (`filter@2`).
- `firebird.folder.managePresets`: Quick action to view and delete saved presets (`filter@3`).

## Unit & Integration Testing

Covered in `src/test/object-explorer-filter.test.ts`:
- Preset creation with UUID generation and timestamps
- Empty name and filter validation
- In-place preset updates when name and scope match
- Preset deletion by ID
- Category and connection scope filtering
- Persistence integration via `ExtensionContext.globalState`
