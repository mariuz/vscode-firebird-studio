(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    toolbar: document.getElementById("toolbar"),
    btnRefresh: document.getElementById("btn-refresh"),
    btnPause: document.getElementById("btn-pause"),
    filter: document.getElementById("filter"),
    status: document.getElementById("status"),
    viewModeBtns: document.querySelectorAll(".view-mode-btn"),
    tableWrapper: document.getElementById("table-wrapper"),
    activityBody: document.getElementById("activity-body"),
    dashboardWrapper: document.getElementById("dashboard-wrapper"),
    timeRangeBtns: document.querySelectorAll(".time-range-btn"),
    chartConnections: document.getElementById("chart-connections"),
    chartValueConnections: document.getElementById("chart-value-connections"),
    chartCachehit: document.getElementById("chart-cachehit"),
    chartValueCachehit: document.getElementById("chart-value-cachehit"),
    chartIo: document.getElementById("chart-io"),
    chartValueIo: document.getElementById("chart-value-io"),
    queriesWrapper: document.getElementById("queries-wrapper"),
    queriesMetricSelect: document.getElementById("queries-metric"),
    queriesMetricHeader: document.getElementById("queries-metric-header"),
    queriesBody: document.getElementById("queries-body"),
    queriesEmptyBanner: document.getElementById("queries-empty-banner"),
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
  let viewMode = "table"; // "table" | "dashboard" | "queries"

  /** Dashboard (phase 4) history -- one sample per poll, kept regardless of which view is
   *  currently showing so switching to Dashboard doesn't start with an empty chart. Capped so a
   *  long-running panel doesn't grow this unboundedly; the time-range selector further narrows
   *  what's actually plotted. */
  const MAX_HISTORY = 600;
  let history = [];
  /** Aggregate (summed across all connections) cumulative counters from the last poll, for the
   *  dashboard's own delta/rate computation -- separate from the per-row `previous` Map above,
   *  since these are database-wide totals, not per-connection. */
  let prevAggregate = null;
  let timeRangeMs = 300000; // 5 min default, matches the "5 min" button already marked .active
  let queriesMetric = "reads";

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

    recordHistorySample(rows);
    renderCurrentView();
  }

  function renderCurrentView() {
    if (viewMode === "dashboard") { renderDashboard(); }
    else if (viewMode === "queries") { renderQueries(); }
    else { renderTable(); }
  }

  function applyViewMode() {
    el.tableWrapper.style.display = viewMode === "table" ? "block" : "none";
    el.dashboardWrapper.style.display = viewMode === "dashboard" ? "block" : "none";
    el.queriesWrapper.style.display = viewMode === "queries" ? "block" : "none";
    el.viewModeBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.mode === viewMode));
    // #filtered-banner is table-only but (like #loading/#error-banner/#empty-banner) lives at the
    // #main level, not inside #table-wrapper -- hide it up front so it can't stay stale/visible
    // after switching away from Table; renderTable() sets it correctly whenever that view is active.
    if (viewMode !== "table") { el.filteredBanner.style.display = "none"; }
    renderCurrentView();
  }

  el.viewModeBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      viewMode = btn.dataset.mode;
      applyViewMode();
    });
  });

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

  // ── Dashboard (phase 4) ──────────────────────────────────────────────────
  //
  // vscode-pgsql's dashboard charts live optimizer/engine metrics over time; this reuses exactly
  // the counters already polled for the activity table (PAGE_READS/WRITES/FETCHES), aggregated
  // across every connection each poll, rather than a new query -- "charting is presentation on
  // top of data this phase already fetches, not new data access" (docs/roadmap/live-profiler.md).

  /** Aggregates one poll's rows into a history sample: connection count plus, once there's a
   *  previous sample to diff against, an approximate cache-hit % and read/write rates. */
  function recordHistorySample(rows) {
    const now = Date.now();
    const totals = rows.reduce((acc, r) => {
      acc.reads += r.PAGE_READS || 0;
      acc.writes += r.PAGE_WRITES || 0;
      acc.fetches += r.PAGE_FETCHES || 0;
      return acc;
    }, { reads: 0, writes: 0, fetches: 0 });

    let cacheHitPct = null;
    let readRate = null;
    let writeRate = null;
    if (prevAggregate) {
      const elapsedSec = (now - prevAggregate.capturedAt) / 1000;
      if (elapsedSec > 0) {
        const deltaReads = totals.reads - prevAggregate.reads;
        const deltaWrites = totals.writes - prevAggregate.writes;
        const deltaFetches = totals.fetches - prevAggregate.fetches;
        // Same defensive rule as rate() above: a negative delta means the connection set changed
        // underneath us (an attachment id was reused), not a real decrease -- skip that sample
        // rather than show a nonsensical value.
        if (deltaReads >= 0 && deltaFetches >= 0) {
          cacheHitPct = deltaFetches > 0 ? Math.max(0, Math.min(100, (1 - deltaReads / deltaFetches) * 100)) : 100;
        }
        if (deltaReads >= 0) { readRate = deltaReads / elapsedSec; }
        if (deltaWrites >= 0) { writeRate = deltaWrites / elapsedSec; }
      }
    }
    prevAggregate = { reads: totals.reads, writes: totals.writes, fetches: totals.fetches, capturedAt: now };

    history.push({ timestamp: now, connectionCount: rows.length, cacheHitPct, readRate, writeRate });
    if (history.length > MAX_HISTORY) { history.shift(); }
  }

  function historyInRange() {
    if (timeRangeMs === 0) { return history; }
    const cutoff = Date.now() - timeRangeMs;
    return history.filter(h => h.timestamp >= cutoff);
  }

  function lastDefined(values) {
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] !== null && values[i] !== undefined) { return values[i]; }
    }
    return null;
  }

  const CHART_WIDTH = 400;
  const CHART_HEIGHT = 110;
  const CHART_PADDING = 6;
  const CHART_COLORS = ["#4a90d9", "#d94a4a"];

  /** Hand-rolled, not a vendored charting library -- matches this repo's convention
   *  (schema-designer's canvas, query-plan-view's diagram, result-view's own chart buttons) of
   *  avoiding a new dependency for a handful of SVG path elements. Each series is drawn as its
   *  own polyline sharing one y-scale (so e.g. reads/writes stay visually comparable); a gap
   *  (null/undefined value, from a poll with nothing to diff against yet) breaks the line rather
   *  than interpolating through it. */
  function buildSparklineSvg(series, options) {
    const width = CHART_WIDTH, height = CHART_HEIGHT;
    const plotWidth = width - CHART_PADDING * 2;
    const plotHeight = height - CHART_PADDING * 2;

    const allValues = series.reduce((acc, s) => acc.concat(s.values.filter(v => v !== null && v !== undefined)), []);
    const maxValue = (options && options.maxValue) || Math.max(0, ...allValues) || 1;
    const count = Math.max(1, ...series.map(s => s.values.length));
    const step = count > 1 ? plotWidth / (count - 1) : 0;

    const paths = series.map((s, si) => {
      const color = CHART_COLORS[si % CHART_COLORS.length];
      let d = "";
      let started = false;
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) { started = false; return; }
        const x = CHART_PADDING + i * step;
        const y = CHART_PADDING + plotHeight - (v / maxValue) * plotHeight;
        d += (started ? " L " : "M ") + `${x.toFixed(1)},${y.toFixed(1)}`;
        started = true;
      });
      return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" />` : "";
    }).join("");

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}">${paths}</svg>`;
  }

  function renderDashboard() {
    const samples = historyInRange();

    const connCounts = samples.map(s => s.connectionCount);
    el.chartConnections.innerHTML = buildSparklineSvg([{ values: connCounts }]);
    const lastConn = lastDefined(connCounts);
    el.chartValueConnections.textContent = lastConn != null ? String(lastConn) : "—";

    const hitPcts = samples.map(s => s.cacheHitPct);
    el.chartCachehit.innerHTML = buildSparklineSvg([{ values: hitPcts }], { maxValue: 100 });
    const lastHit = lastDefined(hitPcts);
    el.chartValueCachehit.textContent = lastHit != null ? `${lastHit.toFixed(1)}%` : "—";

    const readRates = samples.map(s => s.readRate);
    const writeRates = samples.map(s => s.writeRate);
    el.chartIo.innerHTML = buildSparklineSvg([{ values: readRates }, { values: writeRates }]);
    const lastRead = lastDefined(readRates);
    const lastWrite = lastDefined(writeRates);
    el.chartValueIo.innerHTML =
      `<span style="color:${CHART_COLORS[0]}">${lastRead != null ? lastRead.toFixed(1) : '—'} r/s</span>` +
      ` / <span style="color:${CHART_COLORS[1]}">${lastWrite != null ? lastWrite.toFixed(1) : '—'} w/s</span>`;
  }

  el.timeRangeBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      timeRangeMs = parseInt(btn.dataset.range, 10);
      el.timeRangeBtns.forEach(b => b.classList.toggle("active", b === btn));
      if (viewMode === "dashboard") { renderDashboard(); }
    });
  });

  // ── Queries drill-down (phase 4) ─────────────────────────────────────────
  //
  // Ranks the *current* poll's already-active, already-rated connections by a chosen metric --
  // no history needed, just a different view of lastRendered than the activity table gives.

  const QUERIES_METRIC_LABELS = { reads: "Reads/s", writes: "Writes/s", fetches: "Fetches/s", seq: "Seq/s", idx: "Idx/s" };

  function renderQueries() {
    el.queriesMetricHeader.textContent = QUERIES_METRIC_LABELS[queriesMetric];

    const ranked = lastRendered
      .filter(({ row, rates }) => row.ATTACHMENT_STATE === 1 && row.SQL_TEXT && rates && rates[queriesMetric] != null)
      .sort((a, b) => b.rates[queriesMetric] - a.rates[queriesMetric]);

    el.queriesBody.innerHTML = "";
    el.queriesEmptyBanner.style.display = ranked.length === 0 ? "block" : "none";

    ranked.forEach(({ row, rates }, i) => {
      const tr = document.createElement("tr");
      const cells = [i + 1, row.USER_NAME || "", row.REMOTE_ADDRESS || "", truncateOneLine(row.SQL_TEXT, 100), rates[queriesMetric].toFixed(1)];
      cells.forEach((text, ci) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (ci === 3) {
          td.classList.add("fb-statement");
          td.title = row.SQL_TEXT;
        }
        tr.appendChild(td);
      });
      el.queriesBody.appendChild(tr);
    });
  }

  el.queriesMetricSelect.addEventListener("change", () => {
    queriesMetric = el.queriesMetricSelect.value;
    renderQueries();
  });

  // Test-only hook: no-op in a real webview (there is no `module` global there).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.__test__ = {
      rate, truncateOneLine, isolationLabel, handleActivityData, matchesFilter,
      recordHistorySample, buildSparklineSvg, lastDefined,
      getPrevious: () => previous,
      getPinned: () => pinned,
      getHistory: () => history,
    };
  }
})();
