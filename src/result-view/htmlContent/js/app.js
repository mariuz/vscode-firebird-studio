$(() => {
  const vscode = acquireVsCodeApi();

  vscode.postMessage({ command: "getData", data: {} });

  // ── Request/response helper ──────────────────────────────────────────────
  // getPrimaryKey/applyChanges are request/response round-trips over
  // postMessage; pair each request with a requestId so out-of-order or
  // concurrent (multi-panel) responses resolve the right caller.

  let nextRequestId = 1;
  const pendingRequests = {};

  function requestFromExtension(command, data) {
    return new Promise(resolve => {
      const requestId = String(nextRequestId++);
      pendingRequests[requestId] = resolve;
      vscode.postMessage({ command, data: Object.assign({ requestId }, data) });
    });
  }

  function resolveRequest(requestId, payload) {
    const resolve = pendingRequests[requestId];
    if (resolve) {
      delete pendingRequests[requestId];
      resolve(payload);
    }
  }

  window.addEventListener("message", event => {
    const msg = event.data;

    if (msg.command === "batchData") {
      renderBatch(msg.data.results, msg.data.recordsPerPage);
      $("body").addClass("loaded");
      return;
    }

    if (msg.command === "message") {
      const data = msg.data;
      if (data.tableBody && data.tableBody.length) {
        $("#zero-results").hide();
        showData(data);
      } else {
        $("#zero-results").show();
        $("body").addClass("loaded");
      }
      return;
    }

    if (msg.command === "primaryKey" || msg.command === "applyResult") {
      resolveRequest(msg.data.requestId, msg.data);
      return;
    }
  });

  // ── Batch rendering ───────────────────────────────────────────────────────

  function renderBatch(results, recordsPerPage) {
    const $tabBar   = $("#tab-bar");
    const $batchDiv = $("#batch-results");
    $tabBar.empty();
    $batchDiv.empty();
    $("#single-result").hide();

    if (!results || results.length === 0) {
      $batchDiv.html("<p>No results.</p>");
      $tabBar.show();
      return;
    }

    results.forEach((r, i) => {
      // Tab button
      const tabClass = i === 0 ? "fb-tab active" : "fb-tab";
      const badge = r.error ? "⚠" : (r.rowCount != null ? r.rowCount : "✓");
      $tabBar.append(
        $("<button>")
          .addClass(tabClass)
          .attr("data-tab", i)
          .html(`<span class="tab-label">${escHtml(r.sql)}</span><span class="tab-badge">${badge}</span>`)
      );

      // Panel
      const $panel = $("<div>").addClass("batch-panel").attr("id", `panel-${i}`);
      if (i !== 0) { $panel.hide(); }

      const meta = `${r.durationMs} ms` + (r.rowCount ? ` · ${r.rowCount} row(s)` : "");
      $panel.append($("<div>").addClass("result-meta").text(meta));

      if (r.error) {
        $panel.append($("<div>").addClass("result-error").text(r.error));
      } else if (r.message) {
        $panel.append($("<div>").addClass("result-message").text(r.message));
      } else if (r.tableBody && r.tableBody.length) {
        const tableId = `batch-table-${i}`;
        buildEditableTable($panel, tableId, r.tableHeader, r.tableBody, recordsPerPage, r.editableTable);
        $batchDiv.append($panel);
        return; // don't fall through to append again
      } else {
        $panel.append($("<div>").addClass("result-message").text("0 rows returned."));
      }

      $batchDiv.append($panel);
    });

    // Tab switching
    $tabBar.off("click", ".fb-tab").on("click", ".fb-tab", function () {
      const idx = $(this).data("tab");
      $(".fb-tab").removeClass("active");
      $(this).addClass("active");
      $(".batch-panel").hide();
      $(`#panel-${idx}`).show();
    });

    $tabBar.show();
  }

  // ── Single-result (legacy) ────────────────────────────────────────────────

  function showData(data) {
    $("#batch-results").hide();
    $("#single-result").show();
    const $target = $("#single-result-table").empty();
    buildEditableTable($target, "query-results", data.tableHeader, data.tableBody, data.recordsPerPage, data.editableTable);
    $("body").addClass("loaded");
  }

  // ── Editable result table (shared by both single and batch views) ────────

  function buildEditableTable($container, tableId, headers, tableBody, recordsPerPage, editableTable) {
    const $wrapper = $("<div>").addClass("container batch-table-wrapper");

    const $editToolbar = $("<div>").addClass("edit-toolbar");
    const $tableNameInput = $("<input>")
      .attr("type", "text")
      .attr("placeholder", "Table name")
      .addClass("edit-table-name")
      .val(editableTable || "");
    const $toggleEdit = $("<button>").addClass("btn-toggle-edit").text("Enable Editing");
    const $addRow     = $("<button>").addClass("btn-add-row").text("+ Add Row").hide();
    const $apply       = $("<button>").addClass("btn-apply-changes").text("Apply Changes").hide();
    const $freezeToggle  = $("<button>").addClass("btn-grid-action btn-freeze-col").text("❄ Freeze Column");
    const $copyInsert    = $("<button>").addClass("btn-grid-action btn-copy-insert").text("Copy as INSERT");
    const $copyInClause  = $("<button>").addClass("btn-grid-action btn-copy-in").text("Copy as IN (...)");
    const $status       = $("<span>").addClass("edit-status");
    $editToolbar.append($tableNameInput, $toggleEdit, $addRow, $apply, $freezeToggle, $copyInsert, $copyInClause, $status);

    const $table = $("<table>")
      .attr("id", tableId)
      .addClass("row-border order-column cell-border compact display")
      .css("width", "100%");
    $wrapper.append($editToolbar, $table);
    $container.append($wrapper);

    // A leading "actions" column (row-delete toggle) is always present but
    // only shown while editing (toggled via the .fb-editing class — see CSS),
    // so DataTables never needs to be reinitialised when edit mode changes.
    const columns = [{
      title: "",
      orderable: false,
      data: null,
      defaultContent: '<button type="button" class="btn-row-delete" title="Delete row">✕</button>',
      className: "fb-row-actions",
    }].concat(headers);
    const data = tableBody.map(row => [""].concat(row));

    const dt = $(`#${tableId}`).DataTable({
      scrollX: true,
      iDisplayLength: recordsPerPage === "All records" ? -1 : parseInt(recordsPerPage, 10),
      columns,
      data,
      order: [],
      dom: "Bfrtip",
      buttons: buildExportButtons(),
      lengthMenu: [[10, 25, 50, 100, -1], ["10 rows", "25 rows", "50 rows", "100 rows", "Show all"]],
    });

    // pending: array of { type: 'update'|'insert'|'delete', tr, values: Map<colIndex,value>, originalRow? }
    const pending = [];
    let editing = false;
    let pkColumns = [];

    function findPending(tr) {
      return pending.find(p => p.tr === tr);
    }

    function columnNames() {
      return headers.map(h => h.title);
    }

    // ── Cell selection (for "Copy as INSERT" / "Copy as IN (...)") ───────────
    // Disabled while editing: cells are contenteditable there, so a mousedown
    // drag is expected to place a text cursor / select text, not cells.
    let selAnchor = null; // { tr, colIndex }
    let selEnd = null;
    let selecting = false;

    function cellColIndex($td) {
      return $td.index() - 1; // account for the leading actions column
    }

    function clearSelection() {
      $(`#${tableId} td.fb-selected`).removeClass("fb-selected");
      selAnchor = null;
      selEnd = null;
    }

    function highlightSelection() {
      $(`#${tableId} td.fb-selected`).removeClass("fb-selected");
      if (!selAnchor || !selEnd) { return; }
      const $rows = $(`#${tableId} tbody tr`);
      const range = selectionRange(
        { row: $rows.index(selAnchor.tr), col: selAnchor.colIndex },
        { row: $rows.index(selEnd.tr), col: selEnd.colIndex }
      );
      $rows.slice(range.rowStart, range.rowEnd + 1).each(function () {
        $(this).find("td:not(.fb-row-actions)").each(function () {
          const c = cellColIndex($(this));
          if (c >= range.colStart && c <= range.colEnd) { $(this).addClass("fb-selected"); }
        });
      });
    }

    function getSelectedGrid() {
      if (!selAnchor || !selEnd) { return null; }
      const $rows = $(`#${tableId} tbody tr`);
      const range = selectionRange(
        { row: $rows.index(selAnchor.tr), col: selAnchor.colIndex },
        { row: $rows.index(selEnd.tr), col: selEnd.colIndex }
      );
      const rows = $rows.slice(range.rowStart, range.rowEnd + 1).map(function () {
        const rowValues = [];
        $(this).find("td:not(.fb-row-actions)").each(function () {
          const c = cellColIndex($(this));
          if (c >= range.colStart && c <= range.colEnd) { rowValues.push($(this).text()); }
        });
        return rowValues;
      }).get();
      return { rows, colStart: range.colStart, colEnd: range.colEnd };
    }

    $(`#${tableId} tbody`).on("mousedown", "td:not(.fb-row-actions)", function (e) {
      if (editing) { return; }
      const tr = $(this).closest("tr")[0];
      const colIndex = cellColIndex($(this));
      if (e.shiftKey && selAnchor) {
        selEnd = { tr, colIndex };
      } else {
        selAnchor = { tr, colIndex };
        selEnd = { tr, colIndex };
        selecting = true;
      }
      highlightSelection();
      e.preventDefault();
    });

    $(`#${tableId} tbody`).on("mouseenter", "td:not(.fb-row-actions)", function () {
      if (!selecting) { return; }
      selEnd = { tr: $(this).closest("tr")[0], colIndex: cellColIndex($(this)) };
      highlightSelection();
    });

    // Namespaced + re-bound (rather than a bare document-level .on()) so
    // repeated buildEditableTable() calls for the same tableId (a batch panel
    // re-rendered on every query run) don't pile up duplicate handlers.
    $(document).off(`mouseup.fbSelect-${tableId}`).on(`mouseup.fbSelect-${tableId}`, () => {
      selecting = false;
    });

    // ── Row actions (delegated so they survive DataTables redraws) ─────────

    $(`#${tableId} tbody`).on("click", ".btn-row-delete", function () {
      if (!editing) { return; }
      const tr = $(this).closest("tr")[0];
      const existing = findPending(tr);

      if (existing && existing.type === "insert") {
        // Discard an unsaved new row entirely.
        dt.row(tr).remove().draw(false);
        pending.splice(pending.indexOf(existing), 1);
        return;
      }
      if (existing && existing.type === "delete") {
        // Un-mark: restore editing on this row.
        pending.splice(pending.indexOf(existing), 1);
        $(tr).removeClass("fb-row-deleted");
        $(tr).find("td:not(.fb-row-actions)").attr("contenteditable", "true");
        return;
      }
      // Mark for deletion — supersedes any pending (unsaved) edit on this row.
      if (existing && existing.type === "update") {
        pending.splice(pending.indexOf(existing), 1);
      }
      const rowData = dt.row(tr).data();
      pending.push({ type: "delete", tr, originalRow: rowData.slice(1) });
      $(tr).addClass("fb-row-deleted");
      $(tr).find("td:not(.fb-row-actions)").removeAttr("contenteditable").removeClass("fb-dirty");
    });

    $(`#${tableId} tbody`).on("input", "td.fb-editable", function () {
      const tr = $(this).closest("tr")[0];
      const colIndex = $(this).index() - 1; // account for the actions column
      const newValue = $(this).text();
      let entry = findPending(tr);
      if (!entry) {
        entry = { type: "update", tr, values: new Map(), originalRow: dt.row(tr).data().slice(1) };
        pending.push(entry);
      }
      entry.values.set(colIndex, newValue);
      $(this).addClass("fb-dirty");
    });

    // ── Toolbar ──────────────────────────────────────────────────────────────

    $toggleEdit.on("click", async () => {
      editing = !editing;
      $toggleEdit.text(editing ? "Disable Editing" : "Enable Editing");
      $addRow.toggle(editing);
      $apply.toggle(editing);
      $wrapper.toggleClass("fb-editing", editing);
      clearSelection();

      if (!editing) {
        // Discard any unapplied inserts and restore the grid.
        pending.filter(p => p.type === "insert").forEach(p => dt.row(p.tr).remove());
        dt.draw(false);
        pending.length = 0;
        $(`#${tableId} td[contenteditable]`).removeAttr("contenteditable").removeClass("fb-editable fb-dirty");
        $(`#${tableId} tr`).removeClass("fb-row-deleted");
        $status.text("");
        return;
      }

      $(`#${tableId} tbody td:not(.fb-row-actions)`).attr("contenteditable", "true").addClass("fb-editable");

      const tableName = $tableNameInput.val();
      if (tableName) {
        $status.text("Looking up primary key…");
        const result = await requestFromExtension("getPrimaryKey", { tableName });
        pkColumns = result.columns || [];
        $status.text(pkColumns.length
          ? `Primary key: ${pkColumns.join(", ")}`
          : "No primary key found — matching on all columns.");
      } else {
        $status.text("Enter a table name to enable safe row targeting.");
      }
    });

    $addRow.on("click", () => {
      const blankRow = ["", ...new Array(headers.length).fill("")];
      // .draw() before .node(): DataTables only builds a row's DOM node once it's been drawn.
      const tr = dt.row.add(blankRow).draw(false).node();
      dt.page("last").draw(false); // new rows land at the end — jump there so it's actually visible
      $(tr).addClass("fb-row-inserted");
      $(tr).find("td:not(.fb-row-actions)").attr("contenteditable", "true").addClass("fb-editable");
      pending.push({ type: "insert", tr, values: new Map() });
    });

    $apply.on("click", async () => {
      if (pending.length === 0) {
        $status.text("No changes to apply.");
        return;
      }
      const tableName = $tableNameInput.val();
      if (!tableName) {
        $status.text("Enter a table name before applying changes.");
        return;
      }

      const changes = pending.map(p => {
        const change = { type: p.type };
        if (p.originalRow) { change.originalRow = p.originalRow; }
        if (p.values) { change.values = Array.from(p.values, ([colIndex, value]) => ({ colIndex, value })); }
        return change;
      });

      $apply.prop("disabled", true);
      $status.text("Applying changes…");
      const result = await requestFromExtension("applyChanges", { tableName, columns: columnNames(), changes });
      $apply.prop("disabled", false);

      if (result.cancelled) {
        $status.text("Cancelled.");
        return;
      }

      const results = result.results || [];
      const stillPending = [];
      results.forEach((r, i) => {
        const entry = pending[i];
        if (!entry) { return; }
        if (r.error) {
          $(entry.tr).addClass("fb-row-error").attr("title", r.error);
          stillPending.push(entry);
          return;
        }
        // Applied successfully: clear this row's pending/dirty markers.
        if (entry.type === "delete") {
          dt.row(entry.tr).remove();
        } else {
          $(entry.tr).removeClass("fb-row-inserted fb-row-error").removeAttr("title");
          $(entry.tr).find("td.fb-dirty").removeClass("fb-dirty");
        }
      });
      dt.draw(false);
      pending.length = 0;
      stillPending.forEach(p => pending.push(p));
      clearSelection(); // rows may have been removed; stale tr references are no longer meaningful

      const failedCount = results.filter(r => r.error).length;
      $status.text(failedCount
        ? `${failedCount} of ${results.length} change(s) failed — see highlighted rows.`
        : `Applied ${results.length} change(s).`);
    });

    // ── Freeze column / copy selection ────────────────────────────────────────

    $freezeToggle.on("click", () => {
      const frozen = $wrapper.toggleClass("fb-frozen").hasClass("fb-frozen");
      $freezeToggle.toggleClass("active", frozen);
      $freezeToggle.text(frozen ? "❄ Unfreeze Column" : "❄ Freeze Column");
    });

    $copyInsert.on("click", () => {
      const sel = getSelectedGrid();
      if (!sel) { $status.text("Select one or more cells first."); return; }
      const tableName = $tableNameInput.val() || "table_name";
      const cols = headers.slice(sel.colStart, sel.colEnd + 1).map(h => h.title);
      const stmts = sel.rows.map(values => buildInsertStatement(tableName, cols, values));
      copyToClipboard(stmts.join("\n"));
      $status.text(`Copied ${stmts.length} INSERT statement(s) to the clipboard.`);
    });

    $copyInClause.on("click", () => {
      const sel = getSelectedGrid();
      if (!sel) { $status.text("Select one or more cells first."); return; }
      const values = [];
      sel.rows.forEach(row => row.forEach(v => values.push(v)));
      copyToClipboard(buildInClause(values));
      $status.text(`Copied an IN (...) clause with ${values.length} value(s) to the clipboard.`);
    });
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  // The leading row-actions column (delete-toggle button) is a UI-only
  // affordance and must never appear in exported data.
  const EXPORT_OPTIONS = { columns: ":not(.fb-row-actions)" };

  function buildExportButtons() {
    return [
      "pageLength",
      {
        extend: "colvis",
        text: "Columns",
        columns: ":gt(0)", // exclude the leading, always-index-0 actions column from the picker
      },
      {
        extend: "collection",
        text: "Export data",
        autoClose: true,
        buttons: [
          {
            text: "as JSON",
            action: function (e, dt) {
              var exportData = dt.buttons.exportData(EXPORT_OPTIONS);
              $.fn.dataTable.fileSave(new Blob([JSON.stringify(exportData)]), "Export.json");
            },
            title: "Data export",
            titleAttr: "Export data to .json file.",
          },
          { extend: "csv",   text: "as CSV",  title: "Data export", exportOptions: EXPORT_OPTIONS },
          { extend: "excel", text: "as XLSX", title: "Data export", exportOptions: EXPORT_OPTIONS },
          { extend: "pdf",   text: "as PDF",  title: "Data export", exportOptions: EXPORT_OPTIONS },
        ],
      },
    ];
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Copy-selection-as-SQL helpers (pure — no DOM/jQuery) ────────────────────

  function sqlLiteral(value) {
    if (value === null || value === undefined || value === "") { return "NULL"; }
    if (/^-?\d+(\.\d+)?$/.test(value)) { return value; }
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  function buildInsertStatement(tableName, columns, values) {
    return `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${values.map(sqlLiteral).join(", ")});`;
  }

  function buildInClause(values) {
    return `IN (${values.map(sqlLiteral).join(", ")})`;
  }

  /** Normalizes an (anchor, end) pair of {row,col} points into an inclusive rectangle. */
  function selectionRange(anchor, end) {
    return {
      rowStart: Math.min(anchor.row, end.row),
      rowEnd: Math.max(anchor.row, end.row),
      colStart: Math.min(anchor.col, end.col),
      colEnd: Math.max(anchor.col, end.col),
    };
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const $ta = $("<textarea>").val(text).css({ position: "fixed", left: "-9999px", top: "0" }).appendTo("body");
    $ta[0].select();
    document.execCommand("copy");
    $ta.remove();
  }

  // Test-only hook: no-op in a real webview (there is no `module` global there).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.__test__ = { sqlLiteral, buildInsertStatement, buildInClause, selectionRange };
  }
});
