(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    toolbar: document.getElementById("toolbar"),
    btnRefresh: document.getElementById("btn-refresh"),
    btnPause: document.getElementById("btn-pause"),
    filter: document.getElementById("filter"),
    status: document.getElementById("status"),
    activityBody: document.getElementById("activity-body"),
    loading: document.getElementById("loading"),
    errorBanner: document.getElementById("error-banner"),
    emptyBanner: document.getElementById("empty-banner"),
    filteredBanner: document.getElementById("filtered-banner"),
  };

  const ISOLATION_LABELS = {
    0: "Consistency",
    1: "Concurrency (Snapshot)",
    2: "Read Committed (Record Version)",
    3: "Read Committed (No Record Version)",
    4: "Read Committed (Read Consistency)",
  };

  /** attachmentId -> { reads, writes, fetches, seqReads, idxReads, capturedAt } from the last poll, for delta/rate computation. */
  let previous = new Map();
  let pollTimer = null;
  let pollIntervalMs = 3000;
  let paused = false;
  /** [{row, rates}] from the most recent poll -- kept around so typing in the filter box or
   *  toggling a pin can re-render immediately, without waiting for (or forcing) another poll. */
  let lastRendered = [];
  /** Pinned ATTACHMENT_IDs -- pinned rows sort first among whatever the current filter shows. */
  let pinned = new Set();
  let filterText = "";

  // ── Messaging ──────────────────────────────────────────────────────────────

  window.addEventListener("message", event => {
    const msg = event.data;
    if (msg.command === "init") {
      pollIntervalMs = msg.data.pollIntervalMs || pollIntervalMs;
      requestRefresh();
      startPolling();
      return;
    }
    if (msg.command === "activityData") { handleActivityData(msg.data); return; }
    if (msg.command === "actionResult") { handleActionResult(msg.data); return; }
  });

  vscode.postMessage({ command: "ready" });

  function requestRefresh() {
    vscode.postMessage({ command: "refresh" });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(requestRefresh, pollIntervalMs);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  el.btnRefresh.addEventListener("click", requestRefresh);

  el.btnPause.addEventListener("click", () => {
    paused = !paused;
    el.btnPause.textContent = paused ? "Resume" : "Pause";
    if (paused) {
      stopPolling();
    } else {
      startPolling();
      requestRefresh();
    }
  });

  el.filter.addEventListener("input", () => {
    filterText = el.filter.value.trim().toLowerCase();
    renderTable();
  });

  function handleActionResult(data) {
    setStatus(data.ok ? "Action completed." : `Action failed: ${data.error}`);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function handleActivityData(data) {
    el.loading.style.display = "none";

    if (data.error) {
      el.errorBanner.textContent = data.error;
      el.errorBanner.style.display = "block";
      el.emptyBanner.style.display = "none";
      el.activityBody.innerHTML = "";
      setStatus("");
      return;
    }
    el.errorBanner.style.display = "none";

    const rows = data.rows || [];
    if (rows.length === 0) {
      el.emptyBanner.style.display = "block";
      el.filteredBanner.style.display = "none";
      el.activityBody.innerHTML = "";
      previous = new Map();
      pinned = new Set();
      lastRendered = [];
      setStatus("");
      return;
    }
    el.emptyBanner.style.display = "none";

    // Rates must be computed for every row the server returned, regardless of the current filter,
    // so delta tracking for a temporarily-hidden connection doesn't skip a beat.
    const seenIds = new Set();
    lastRendered = rows.map(row => {
      seenIds.add(row.ATTACHMENT_ID);
      return { row, rates: computeRates(row) };
    });
    pruneStale(seenIds);
    Array.from(pinned).forEach(id => { if (!seenIds.has(id)) { pinned.delete(id); } });

    renderTable();
  }

  function matchesFilter(row, text) {
    if (!text) { return true; }
    const haystack = [
      row.USER_NAME,
      row.REMOTE_ADDRESS,
      row.ATTACHMENT_STATE === 1 ? "active" : "idle",
      row.SQL_TEXT,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(text);
  }

  function renderTable() {
    el.activityBody.innerHTML = "";

    const visible = lastRendered
      .filter(({ row }) => matchesFilter(row, filterText))
      .sort((a, b) => {
        const aPinned = pinned.has(a.row.ATTACHMENT_ID);
        const bPinned = pinned.has(b.row.ATTACHMENT_ID);
        return aPinned === bPinned ? 0 : (aPinned ? -1 : 1);
      });

    el.filteredBanner.style.display = (visible.length === 0 && lastRendered.length > 0) ? "block" : "none";
    visible.forEach(({ row, rates }) => renderRow(row, rates));

    setStatus(`${lastRendered.length} connection${lastRendered.length === 1 ? '' : 's'}` +
      (visible.length !== lastRendered.length ? ` (${visible.length} shown)` : '') +
      ` — updated ${new Date().toLocaleTimeString()}`);
  }

  function computeRates(row) {
    const now = Date.now();
    const prev = previous.get(row.ATTACHMENT_ID);
    let rates = null;
    if (prev) {
      const elapsedSec = (now - prev.capturedAt) / 1000;
      if (elapsedSec > 0) {
        rates = {
          reads: rate(row.PAGE_READS, prev.reads, elapsedSec),
          writes: rate(row.PAGE_WRITES, prev.writes, elapsedSec),
          fetches: rate(row.PAGE_FETCHES, prev.fetches, elapsedSec),
          seq: rate(row.SEQ_READS, prev.seqReads, elapsedSec),
          idx: rate(row.IDX_READS, prev.idxReads, elapsedSec),
        };
      }
    }
    previous.set(row.ATTACHMENT_ID, {
      reads: row.PAGE_READS || 0,
      writes: row.PAGE_WRITES || 0,
      fetches: row.PAGE_FETCHES || 0,
      seqReads: row.SEQ_READS || 0,
      idxReads: row.IDX_READS || 0,
      capturedAt: now,
    });
    return rates;
  }

  /** Cumulative counters can only ever go up between polls of the same connection -- a decrease
   *  means the connection was replaced (same attachment id reused) or stats reset, so the delta
   *  is meaningless; show "no data yet" rather than a nonsensical negative rate. */
  function rate(current, prevValue, elapsedSec) {
    const cur = current || 0;
    const delta = cur - prevValue;
    if (delta < 0) { return null; }
    return delta / elapsedSec;
  }

  function pruneStale(currentIds) {
    Array.from(previous.keys()).forEach(id => {
      if (!currentIds.has(id)) { previous.delete(id); }
    });
  }

  function renderRow(row, rates) {
    const tr = document.createElement("tr");
    if (row.ATTACHMENT_STATE === 1) { tr.classList.add("fb-active-row"); }
    const isPinned = pinned.has(row.ATTACHMENT_ID);
    if (isPinned) { tr.classList.add("fb-pinned-row"); }

    const pinTd = document.createElement("td");
    const pinBtn = document.createElement("button");
    pinBtn.className = "fb-pin-btn" + (isPinned ? " fb-pinned" : "");
    pinBtn.textContent = "★";
    pinBtn.title = isPinned ? "Unpin" : "Pin to top";
    pinBtn.addEventListener("click", () => {
      if (pinned.has(row.ATTACHMENT_ID)) { pinned.delete(row.ATTACHMENT_ID); } else { pinned.add(row.ATTACHMENT_ID); }
      renderTable();
    });
    pinTd.appendChild(pinBtn);
    tr.appendChild(pinTd);

    const values = [
      row.USER_NAME || "",
      row.REMOTE_ADDRESS || "",
      row.ATTACHMENT_STATE === 1 ? "Active" : "Idle",
      row.ISOLATION_MODE != null ? isolationLabel(row.ISOLATION_MODE) : "",
      row.SQL_TEXT ? truncateOneLine(row.SQL_TEXT, 80) : "",
      fmtRate(rates && rates.reads),
      fmtRate(rates && rates.writes),
      fmtRate(rates && rates.fetches),
      fmtRate(rates && rates.seq),
      fmtRate(rates && rates.idx),
    ];

    values.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 4) {
        td.classList.add("fb-statement");
        if (row.SQL_TEXT) { td.title = row.SQL_TEXT; }
      }
      tr.appendChild(td);
    });

    tr.appendChild(renderActionsCell(row));

    el.activityBody.appendChild(tr);
  }

  function renderActionsCell(row) {
    const td = document.createElement("td");
    td.classList.add("fb-actions");

    const label = `${row.USER_NAME || "?"} (${row.REMOTE_ADDRESS || "local"})`;

    const killBtn = document.createElement("button");
    killBtn.className = "fb-kill-btn";
    killBtn.textContent = "Kill";
    killBtn.title = "Force-detach this connection";
    killBtn.addEventListener("click", () => {
      vscode.postMessage({ command: "killAttachment", data: { attachmentId: row.ATTACHMENT_ID, label } });
    });
    td.appendChild(killBtn);

    if (row.TRANSACTION_ID != null) {
      const rollbackBtn = document.createElement("button");
      rollbackBtn.textContent = "Rollback";
      rollbackBtn.title = "Roll back this connection's active transaction";
      rollbackBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "rollbackTransaction", data: { transactionId: row.TRANSACTION_ID, label } });
      });
      td.appendChild(rollbackBtn);
    }

    return td;
  }

  function isolationLabel(mode) {
    return ISOLATION_LABELS[mode] || `Mode ${mode}`;
  }

  function fmtRate(n) {
    return (n === null || n === undefined) ? "—" : n.toFixed(1);
  }

  function truncateOneLine(text, max) {
    const oneLine = String(text).replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  }

  function setStatus(text) {
    el.status.textContent = text;
  }

  // Test-only hook: no-op in a real webview (there is no `module` global there).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.__test__ = {
      rate, truncateOneLine, isolationLabel, handleActivityData, matchesFilter,
      getPrevious: () => previous,
      getPinned: () => pinned,
    };
  }
})();
