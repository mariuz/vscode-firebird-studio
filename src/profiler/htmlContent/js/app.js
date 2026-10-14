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
    dashboardCharts: document.getElementById("dashboard-charts"),
    dashboardEmpty: document.getElementById("dashboard-empty"),
    btnTiles: document.getElementById("btn-tiles"),
    tilesMenu: document.getElementById("tiles-menu"),
    tilesMenuList: document.getElementById("tiles-menu-list"),
    btnTilesReset: document.getElementById("btn-tiles-reset"),
    pollInterval: document.getElementById("poll-interval"),
    queriesWrapper: document.getElementById("queries-wrapper"),
    queriesMetricSelect: document.getElementById("queries-metric"),
    queriesMetricHeader: document.getElementById("queries-metric-header"),
    queriesBody: document.getElementById("queries-body"),
    queriesEmptyBanner: document.getElementById("queries-empty-banner"),
    sessionsWrapper: document.getElementById("sessions-wrapper"),
    sessionsBody: document.getElementById("sessions-body"),
    sessionsEmptyBanner: document.getElementById("sessions-empty-banner"),
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

  /** attachmentId -> { reads, writes, fetches, seqReads, idxReads, waits, conflicts, capturedAt } from the last poll, for delta/rate computation. */
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
  let viewMode = "table"; // "table" | "dashboard" | "queries" | "sessions"

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
      applyConfig(msg.data);
      requestRefresh();
      startPolling();
      return;
    }
    if (msg.command === "config") { applyConfig(msg.data); return; }
    if (msg.command === "activityData") { handleActivityData(msg.data); return; }
    if (msg.command === "actionResult") { handleActionResult(msg.data); return; }
  });

  vscode.postMessage({ command: "ready" });

  /** Applies settings pushed from the extension host -- on init, and again whenever
   *  `firebird.profiler.*` changes while the panel is open (including as the echo of this
   *  panel's own Refresh/Tiles choices, which is why every branch here is idempotent). */
  function applyConfig(data) {
    if (!data) { return; }
    if (typeof data.pollIntervalMs === "number" && data.pollIntervalMs > 0) {
      setPollInterval(data.pollIntervalMs, false);
    }
    if (Array.isArray(data.dashboardTiles)) {
      setDashboardTiles(data.dashboardTiles, false);
    }
  }

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

  /** Changes the polling cadence. Restarts the timer only if it is running -- a paused profiler
   *  stays paused, and picks up the new cadence when resumed. `persist` is true only for the
   *  user's own choice in the selector, never for a value that came *from* settings. */
  function setPollInterval(ms, persist) {
    const changed = ms !== pollIntervalMs;
    pollIntervalMs = ms;
    syncPollIntervalSelect();
    if (changed && pollTimer) { startPolling(); }
    if (persist) { vscode.postMessage({ command: "setPollInterval", data: { pollIntervalMs: ms } }); }
  }

  /** Reflects pollIntervalMs in the selector, adding a one-off option when the configured value
   *  (e.g. 4500 typed into settings.json) is not one of the presets -- otherwise the select would
   *  silently show a preset that is not what is actually running. */
  function syncPollIntervalSelect() {
    const select = el.pollInterval;
    if (!select || !select.options) { return; }
    const value = String(pollIntervalMs);
    const options = Array.from(select.options);
    options.filter(o => o.dataset && o.dataset.custom === "true" && o.value !== value).forEach(o => o.remove());
    if (!options.some(o => o.value === value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${formatSeconds(pollIntervalMs)} (custom)`;
      option.dataset.custom = "true";
      select.appendChild(option);
    }
    select.value = value;
  }

  function formatSeconds(ms) {
    const sec = ms / 1000;
    return `${Number.isInteger(sec) ? sec : sec.toFixed(1)}s`;
  }

  el.pollInterval.addEventListener("change", () => {
    const ms = parseInt(el.pollInterval.value, 10);
    if (ms > 0) { setPollInterval(ms, true); }
  });

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
    else if (viewMode === "sessions") { renderSessions(); }
    else { renderTable(); }
  }

  function applyViewMode() {
    el.tableWrapper.style.display = viewMode === "table" ? "block" : "none";
    el.dashboardWrapper.style.display = viewMode === "dashboard" ? "block" : "none";
    el.queriesWrapper.style.display = viewMode === "queries" ? "block" : "none";
    el.sessionsWrapper.style.display = viewMode === "sessions" ? "block" : "none";
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
          waits: rate(row.RECORD_WAITS, prev.waits, elapsedSec),
          conflicts: rate(row.RECORD_CONFLICTS, prev.conflicts, elapsedSec),
        };
      }
    }
    previous.set(row.ATTACHMENT_ID, {
      reads: row.PAGE_READS || 0,
      writes: row.PAGE_WRITES || 0,
      fetches: row.PAGE_FETCHES || 0,
      seqReads: row.SEQ_READS || 0,
      idxReads: row.IDX_READS || 0,
      waits: row.RECORD_WAITS || 0,
      conflicts: row.RECORD_CONFLICTS || 0,
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
  //
  // Customizable tiles (mirroring vscode-pgsql 1.30.0): every tile is a pure function of the
  // shared `history`, and every sample records *every* metric whether or not its tile is showing,
  // so switching a tile on draws its full history at once instead of starting from an empty chart.

  /** Mirrors `firebird.profiler.dashboardTiles`' declared default (package.json). */
  const DEFAULT_TILES = ["connections", "cacheHit", "pageIo"];
  /** Tiles currently drawn, in display order. */
  let dashboardTiles = DEFAULT_TILES.slice();
  /** tile id -> { valueEl, detailEl, chartEl } for the cards currently in #dashboard-charts. */
  let tileEls = new Map();

  /** Short isolation names for the Transactions tile's one-line breakdown -- the full
   *  ISOLATION_LABELS strings are too long to fit several on one line of a card. */
  const ISOLATION_SHORT_LABELS = {
    0: "Consistency",
    1: "Snapshot",
    2: "RC (record version)",
    3: "RC (no record version)",
    4: "RC (read consistency)",
  };

  /** Aggregates one poll's rows into a history sample: connection count plus, once there's a
   *  previous sample to diff against, an approximate cache-hit % and per-second rates. Gauges
   *  (memory, open transactions, oldest transaction age) need no previous sample. */
  function recordHistorySample(rows) {
    const now = Date.now();
    const totals = rows.reduce((acc, r) => {
      acc.reads += r.PAGE_READS || 0;
      acc.writes += r.PAGE_WRITES || 0;
      acc.fetches += r.PAGE_FETCHES || 0;
      acc.seqReads += r.SEQ_READS || 0;
      acc.idxReads += r.IDX_READS || 0;
      acc.waits += r.RECORD_WAITS || 0;
      acc.conflicts += r.RECORD_CONFLICTS || 0;
      return acc;
    }, { reads: 0, writes: 0, fetches: 0, seqReads: 0, idxReads: 0, waits: 0, conflicts: 0 });

    let cacheHitPct = null;
    let readRate = null;
    let writeRate = null;
    let seqRate = null;
    let idxRate = null;
    let waitRate = null;
    let conflictRate = null;
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
        seqRate = aggregateRate(totals.seqReads, prevAggregate.seqReads, elapsedSec);
        idxRate = aggregateRate(totals.idxReads, prevAggregate.idxReads, elapsedSec);
        waitRate = aggregateRate(totals.waits, prevAggregate.waits, elapsedSec);
        conflictRate = aggregateRate(totals.conflicts, prevAggregate.conflicts, elapsedSec);
      }
    }
    prevAggregate = { ...totals, capturedAt: now };

    // Gauges: current values, nothing to diff.
    let memoryUsed = null;
    let memoryAllocated = null;
    const isolationCounts = {};
    let txCount = 0;
    let oldestTxStart = null;
    rows.forEach(r => {
      if (r.MEMORY_USED != null) { memoryUsed = (memoryUsed || 0) + Number(r.MEMORY_USED); }
      if (r.MEMORY_ALLOCATED != null) { memoryAllocated = (memoryAllocated || 0) + Number(r.MEMORY_ALLOCATED); }
      if (r.TRANSACTION_ID != null) {
        txCount++;
        const key = r.ISOLATION_MODE != null ? r.ISOLATION_MODE : "unknown";
        isolationCounts[key] = (isolationCounts[key] || 0) + 1;
        const started = r.TX_STARTED_AT ? new Date(r.TX_STARTED_AT).getTime() : NaN;
        if (!isNaN(started) && (oldestTxStart === null || started < oldestTxStart)) { oldestTxStart = started; }
      }
    });

    history.push({
      timestamp: now,
      connectionCount: rows.length,
      activeStatements: rows.filter(r => r.ATTACHMENT_STATE === 1).length,
      cacheHitPct, readRate, writeRate, seqRate, idxRate, waitRate, conflictRate,
      memoryUsed, memoryAllocated,
      txCount, isolationCounts,
      oldestTxAgeSec: oldestTxStart !== null ? Math.max(0, (now - oldestTxStart) / 1000) : null,
    });
    if (history.length > MAX_HISTORY) { history.shift(); }
  }

  /** Database-wide rate between two polls' summed counters; null on a negative delta (a
   *  connection left, so its cumulative counters dropped out of the sum). */
  function aggregateRate(current, previousTotal, elapsedSec) {
    if (previousTotal === undefined || previousTotal === null) { return null; }
    const delta = current - previousTotal;
    return delta >= 0 ? delta / elapsedSec : null;
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

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n)) { return "—"; }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(n);
    let unit = 0;
    while (Math.abs(value) >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
  }

  /** Two-series value line: each number in its own series colour, so the legend *is* the value. */
  function twoSeriesValue(a, aSuffix, b, bSuffix) {
    return `<span style="color:${CHART_COLORS[0]}">${a != null ? a.toFixed(1) : '—'} ${aSuffix}</span>` +
      ` / <span style="color:${CHART_COLORS[1]}">${b != null ? b.toFixed(1) : '—'} ${bSuffix}</span>`;
  }

  /** "Snapshot 2 · RC (record version) 1", most common first. */
  function summarizeIsolation(counts) {
    if (!counts) { return ""; }
    return Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a])
      .map(k => `${k === "unknown" ? "Unknown" : (ISOLATION_SHORT_LABELS[k] || `Mode ${k}`)} ${counts[k]}`)
      .join(" · ");
  }

  /**
   * Every tile the dashboard can draw. Keys must match `PROFILER_DASHBOARD_TILES` in
   * src/config/config.ts and the `firebird.profiler.dashboardTiles` enum in package.json (a unit
   * test checks all three). `view(samples)` is pure: it returns the series to plot, an optional
   * fixed y-max, the headline value (HTML -- only ever built from numbers and fixed strings), and
   * an optional one-line plain-text detail.
   */
  const TILE_DEFS = {
    connections: {
      title: "Connections",
      view(samples) {
        const values = samples.map(s => s.connectionCount);
        const last = lastDefined(values);
        return { series: [{ values }], valueHtml: last != null ? String(last) : "—" };
      },
    },
    cacheHit: {
      title: "Cache Hit %",
      hint: "Approximate: (fetches − physical page reads) / fetches, aggregated across all connections since the last poll.",
      view(samples) {
        const values = samples.map(s => s.cacheHitPct);
        const last = lastDefined(values);
        return { series: [{ values }], maxValue: 100, valueHtml: last != null ? `${last.toFixed(1)}%` : "—" };
      },
    },
    pageIo: {
      title: "Page I/O (reads/writes per sec)",
      view(samples) {
        const reads = samples.map(s => s.readRate);
        const writes = samples.map(s => s.writeRate);
        return { series: [{ values: reads }, { values: writes }], valueHtml: twoSeriesValue(lastDefined(reads), "r/s", lastDefined(writes), "w/s") };
      },
    },
    recordReads: {
      title: "Record Reads (sequential / indexed per sec)",
      hint: "From MON$RECORD_STATS. Sequential (NATURAL) reads walk a whole table; a rising sequential share under steady load often means a query is missing an index.",
      view(samples) {
        const seq = samples.map(s => s.seqRate);
        const idx = samples.map(s => s.idxRate);
        const lastSeq = lastDefined(seq);
        const lastIdx = lastDefined(idx);
        const total = (lastSeq || 0) + (lastIdx || 0);
        const detail = lastSeq != null && lastIdx != null && total > 0
          ? `${((lastIdx / total) * 100).toFixed(0)}% indexed`
          : "";
        return { series: [{ values: seq }, { values: idx }], valueHtml: twoSeriesValue(lastSeq, "seq/s", lastIdx, "idx/s"), detail };
      },
    },
    activeStatements: {
      title: "Active Statements",
      hint: "Connections whose MON$STATE is active — executing a statement at the moment of the poll, not merely holding a transaction open.",
      view(samples) {
        const values = samples.map(s => s.activeStatements);
        const last = lastDefined(values);
        const conns = lastDefined(samples.map(s => s.connectionCount));
        return {
          series: [{ values }],
          valueHtml: last != null ? String(last) : "—",
          detail: last != null && conns != null ? `of ${conns} connection${conns === 1 ? "" : "s"}` : "",
        };
      },
    },
    lockContention: {
      title: "Lock Contention (waits / conflicts per sec)",
      hint: "MON$RECORD_WAITS counts waits on a row another transaction has updated; MON$RECORD_CONFLICTS counts snapshot update conflicts specifically. Waits is the broader signal.",
      view(samples) {
        const waits = samples.map(s => s.waitRate);
        const conflicts = samples.map(s => s.conflictRate);
        return { series: [{ values: waits }, { values: conflicts }], valueHtml: twoSeriesValue(lastDefined(waits), "waits/s", lastDefined(conflicts), "conf/s") };
      },
    },
    memory: {
      title: "Memory (attachment pools)",
      hint: "Sum of MON$MEMORY_USAGE.MON$MEMORY_USED across the monitored connections' attachment-level pools. Excludes the server's shared page cache.",
      view(samples) {
        const used = samples.map(s => s.memoryUsed);
        const last = lastDefined(used);
        const allocated = lastDefined(samples.map(s => s.memoryAllocated));
        return {
          series: [{ values: used }],
          valueHtml: fmtBytes(last),
          detail: allocated != null ? `${fmtBytes(allocated)} allocated` : "",
        };
      },
    },
    transactions: {
      title: "Connections in Transaction",
      hint: "Monitored connections holding an open transaction, broken down by isolation level (each connection's newest transaction).",
      view(samples) {
        const values = samples.map(s => s.txCount);
        const last = lastDefined(values);
        const latest = samples.length ? samples[samples.length - 1] : null;
        return {
          series: [{ values }],
          valueHtml: last != null ? String(last) : "—",
          detail: latest ? summarizeIsolation(latest.isolationCounts) : "",
        };
      },
    },
    oldestTransaction: {
      title: "Oldest Open Transaction",
      hint: "Age of the oldest open transaction among monitored connections. A long-lived transaction holds back garbage collection for every connection — the Sessions view names which one is the database's oldest active.",
      view(samples) {
        const values = samples.map(s => s.oldestTxAgeSec);
        const last = lastDefined(values);
        const latest = samples.length ? samples[samples.length - 1] : null;
        const hasNone = latest && latest.oldestTxAgeSec == null;
        return {
          series: [{ values }],
          valueHtml: hasNone ? "None open" : (last != null ? formatDuration(last * 1000) : "—"),
        };
      },
    },
  };

  /** The tile ids actually drawable, in the given order, de-duplicated -- tolerates a settings
   *  value written by a newer/older version of the extension rather than throwing on it. */
  function normalizeTiles(ids) {
    const seen = new Set();
    return (Array.isArray(ids) ? ids : []).filter(id => {
      if (typeof id !== "string" || !TILE_DEFS[id] || seen.has(id)) { return false; }
      seen.add(id);
      return true;
    });
  }

  /** Replaces the tile selection and rebuilds the grid. `persist` is true only for a change made
   *  in this panel's own Tiles… menu; values that came from settings are never echoed back. */
  function setDashboardTiles(ids, persist) {
    const next = normalizeTiles(ids);
    const changed = next.join(",") !== dashboardTiles.join(",");
    dashboardTiles = next;
    if (changed || tileEls.size !== next.length) { buildTileCards(); }
    syncTilesMenu();
    if (persist) { vscode.postMessage({ command: "setDashboardTiles", data: { tiles: dashboardTiles.slice() } }); }
    if (viewMode === "dashboard") { renderDashboard(); }
  }

  /** Toggling a tile on appends it, so a custom order typed into settings.json is preserved. */
  function toggleTile(id, on) {
    const without = dashboardTiles.filter(t => t !== id);
    setDashboardTiles(on ? without.concat(id) : without, true);
  }

  function buildTileCards() {
    el.dashboardCharts.innerHTML = "";
    tileEls = new Map();
    dashboardTiles.forEach(id => {
      const def = TILE_DEFS[id];
      const card = document.createElement("div");
      card.className = "chart-card";
      card.dataset.tile = id;

      const h4 = document.createElement("h4");
      h4.textContent = def.title + (def.hint ? " " : "");
      if (def.hint) {
        const hint = document.createElement("span");
        hint.className = "chart-hint";
        hint.title = def.hint;
        hint.textContent = "?";
        h4.appendChild(hint);
      }
      const valueEl = document.createElement("div");
      valueEl.className = "chart-value";
      const detailEl = document.createElement("div");
      detailEl.className = "chart-detail";
      const chartEl = document.createElement("div");
      chartEl.className = "chart-container";

      card.appendChild(h4);
      card.appendChild(valueEl);
      card.appendChild(detailEl);
      card.appendChild(chartEl);
      el.dashboardCharts.appendChild(card);
      tileEls.set(id, { valueEl, detailEl, chartEl });
    });
    el.dashboardEmpty.style.display = dashboardTiles.length === 0 ? "block" : "none";
  }

  function renderDashboard() {
    const samples = historyInRange();
    dashboardTiles.forEach(id => {
      const els = tileEls.get(id);
      if (!els) { return; }
      const view = TILE_DEFS[id].view(samples);
      els.chartEl.innerHTML = buildSparklineSvg(view.series, view.maxValue ? { maxValue: view.maxValue } : undefined);
      els.valueEl.innerHTML = view.valueHtml;
      els.detailEl.textContent = view.detail || "";
    });
  }

  // ── Tiles… menu ──────────────────────────────────────────────────────────

  /** id -> checkbox, built once: the set of *possible* tiles never changes at runtime. */
  const tileCheckboxes = new Map();

  function buildTilesMenu() {
    el.tilesMenuList.innerHTML = "";
    Object.keys(TILE_DEFS).forEach(id => {
      const label = document.createElement("label");
      label.setAttribute("role", "menuitemcheckbox");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.tile = id;
      checkbox.addEventListener("change", () => toggleTile(id, checkbox.checked));
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(TILE_DEFS[id].title));
      if (TILE_DEFS[id].hint) { label.title = TILE_DEFS[id].hint; }
      el.tilesMenuList.appendChild(label);
      tileCheckboxes.set(id, checkbox);
    });
  }

  function syncTilesMenu() {
    tileCheckboxes.forEach((checkbox, id) => { checkbox.checked = dashboardTiles.includes(id); });
  }

  function setTilesMenuOpen(open) {
    el.tilesMenu.style.display = open ? "block" : "none";
    el.btnTiles.setAttribute("aria-expanded", open ? "true" : "false");
  }

  el.btnTiles.addEventListener("click", event => {
    event.stopPropagation();
    setTilesMenuOpen(el.tilesMenu.style.display === "none");
  });
  // Clicks inside the menu (ticking several boxes in a row) must not close it.
  el.tilesMenu.addEventListener("click", event => event.stopPropagation());
  document.addEventListener("click", () => setTilesMenuOpen(false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { setTilesMenuOpen(false); }
  });
  el.btnTilesReset.addEventListener("click", () => setDashboardTiles(DEFAULT_TILES, true));

  buildTilesMenu();
  buildTileCards();
  syncTilesMenu();

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

  // ── Sessions (phase 5) ────────────────────────────────────────────────────
  //
  // One row per open transaction, from the same lastRendered the other views already share.
  // Firebird's monitoring tables don't expose a lock-wait graph (no way to name *who* a given
  // transaction is waiting on -- see profilerActivityQuery()'s doc comment), so "blocking" here
  // is two proxies instead: per-attachment record wait/conflict rates, and flagging whichever
  // transaction is the database's current MON$OLDEST_ACTIVE, i.e. most likely holding back
  // garbage collection for every other connection.

  function renderSessions() {
    const sessions = lastRendered.filter(({ row }) => row.TRANSACTION_ID != null);

    el.sessionsBody.innerHTML = "";
    el.sessionsEmptyBanner.style.display = sessions.length === 0 ? "block" : "none";

    sessions.forEach(({ row, rates }) => {
      const tr = document.createElement("tr");
      const isOldestActive = row.DB_OLDEST_ACTIVE != null && row.TRANSACTION_ID === row.DB_OLDEST_ACTIVE;
      if (isOldestActive) { tr.classList.add("fb-oldest-active-row"); }

      const flags = [];
      if (isOldestActive) { flags.push("Oldest Active"); }
      if (row.TX_READ_ONLY) { flags.push("Read-Only"); }
      if (row.TX_AUTO_COMMIT) { flags.push("Auto-Commit"); }

      const cells = [
        row.USER_NAME || "",
        row.REMOTE_ADDRESS || "",
        row.ISOLATION_MODE != null ? isolationLabel(row.ISOLATION_MODE) : "",
        lockTimeoutLabel(row.LOCK_TIMEOUT),
        flags.join(", "),
        row.TX_STARTED_AT ? formatDuration(Date.now() - new Date(row.TX_STARTED_AT).getTime()) : "",
        fmtRate(rates && rates.waits),
        fmtRate(rates && rates.conflicts),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (i === 4 && isOldestActive) { td.classList.add("fb-oldest-active-flag"); }
        tr.appendChild(td);
      });

      tr.appendChild(renderActionsCell(row));
      el.sessionsBody.appendChild(tr);
    });
  }

  function lockTimeoutLabel(seconds) {
    if (seconds == null) { return ""; }
    if (seconds === -1) { return "Infinite"; }
    if (seconds === 0) { return "No Wait"; }
    return `${seconds}s`;
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) { return `${h}h ${m}m`; }
    if (m > 0) { return `${m}m ${s}s`; }
    return `${s}s`;
  }

  // Test-only hook: no-op in a real webview (there is no `module` global there).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.__test__ = {
      rate, truncateOneLine, isolationLabel, handleActivityData, matchesFilter,
      recordHistorySample, buildSparklineSvg, lastDefined,
      lockTimeoutLabel, formatDuration,
      aggregateRate, fmtBytes, summarizeIsolation, normalizeTiles, formatSeconds,
      setDashboardTiles, setPollInterval, applyConfig, toggleTile,
      TILE_DEFS, DEFAULT_TILES,
      getDashboardTiles: () => dashboardTiles.slice(),
      getTileEls: () => tileEls,
      getPollIntervalMs: () => pollIntervalMs,
      resetHistory: () => { history = []; prevAggregate = null; },
      getPrevious: () => previous,
      getPinned: () => pinned,
      getHistory: () => history,
    };
  }
})();
