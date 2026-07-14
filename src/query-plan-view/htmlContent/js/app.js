(function () {
  const vscode = acquireVsCodeApi();
  const SVG_NS = "http://www.w3.org/2000/svg";

  const el = {
    canvasWrapper: document.getElementById("canvas-wrapper"),
    canvas: document.getElementById("canvas"),
    viewport: document.getElementById("viewport"),
    edgesLayer: document.getElementById("edges"),
    nodesLayer: document.getElementById("nodes"),
    tableWrapper: document.getElementById("table-wrapper"),
    planTableBody: document.getElementById("plan-table-body"),
    planTableHeaders: document.querySelectorAll("#plan-table th[data-sort]"),
    icicleWrapper: document.getElementById("icicle-wrapper"),
    icicleChart: document.getElementById("icicle-chart"),
    loading: document.getElementById("loading"),
    errorBanner: document.getElementById("error-banner"),
    emptyBanner: document.getElementById("empty-banner"),
    status: document.getElementById("status"),
    btnRefresh: document.getElementById("btn-refresh"),
    btnImport: document.getElementById("btn-import"),
    btnFit: document.getElementById("btn-fit"),
    btnZoomIn: document.getElementById("btn-zoom-in"),
    btnZoomOut: document.getElementById("btn-zoom-out"),
    viewModeBtns: document.querySelectorAll(".view-mode-btn"),
    btnToggleRaw: document.getElementById("btn-toggle-raw"),
    btnAnalyze: document.getElementById("btn-analyze"),
    detailPanel: document.getElementById("detail-panel"),
    detailHeading: document.getElementById("detail-heading"),
    detailBody: document.getElementById("detail-body"),
    rawOutput: document.getElementById("raw-output"),
  };

  const NODE_WIDTH = 170;
  const NODE_HEIGHT = 46;
  const H_GAP = 24;
  const V_GAP = 56;
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 3;

  let blocks = [];
  let rawText = "";
  let importedFrom = null;
  /** The underlying PlanNode currently selected -- stable across re-renders (unlike a layout-tree
   *  node, which is rebuilt fresh on every render() call), so it stays in sync between the
   *  diagram and table views and survives a re-render after selecting it. */
  let selectedNode = null;
  let viewMode = "diagram"; // "diagram" | "table"
  let tableSort = { column: "order", dir: "asc" };
  const view = { x: 0, y: 0, scale: 1 };

  // ── Messaging ──────────────────────────────────────────────────────────────

  window.addEventListener("message", event => {
    const msg = event.data;
    if (msg.command === "planData") { handlePlanData(msg.data); }
  });

  vscode.postMessage({ command: "ready" });

  function requestRefresh() {
    setStatus("Refreshing…");
    el.loading.style.display = "block";
    el.errorBanner.style.display = "none";
    vscode.postMessage({ command: "refresh" });
  }
  el.btnRefresh.addEventListener("click", requestRefresh);

  el.btnImport.addEventListener("click", () => {
    vscode.postMessage({ command: "importPlan" });
  });

  el.btnAnalyze.addEventListener("click", () => {
    el.btnAnalyze.disabled = true;
    el.btnAnalyze.textContent = "🤖 Analyzing…";
    vscode.postMessage({ command: "analyzePlan" });
    setTimeout(() => {
      el.btnAnalyze.disabled = false;
      el.btnAnalyze.textContent = "🤖 Analyze";
    }, 3000);
  });

  function setStatus(text) {
    el.status.textContent = text;
  }

  function fileBaseName(path) {
    return String(path).split(/[\\/]/).pop();
  }

  // ── Handling plan data ────────────────────────────────────────────────────

  function handlePlanData(data) {
    el.loading.style.display = "none";
    rawText = data.raw || "";
    importedFrom = data.importedFrom || null;

    if (data.error) {
      el.errorBanner.textContent = data.error;
      el.errorBanner.style.display = "block";
      el.emptyBanner.style.display = "none";
      clearDiagram();
      el.planTableBody.innerHTML = "";
      el.icicleChart.innerHTML = "";
      el.btnAnalyze.disabled = true;
      setStatus("");
      return;
    }
    el.errorBanner.style.display = "none";

    blocks = data.blocks || [];
    if (blocks.length === 0) {
      el.emptyBanner.style.display = "block";
      clearDiagram();
      el.planTableBody.innerHTML = "";
      el.icicleChart.innerHTML = "";
      el.btnAnalyze.disabled = true;
      setStatus("");
      return;
    }
    el.emptyBanner.style.display = "none";
    selectedNode = null;
    el.detailPanel.style.display = "none";
    el.btnAnalyze.disabled = false;
    applyViewMode();
    setStatus(`${blocks.length} plan block${blocks.length === 1 ? '' : 's'}` +
      (importedFrom ? ` — imported from ${fileBaseName(importedFrom)}` : ''));
  }

  // ── Diagram / table / icicle view switching ──────────────────────────────

  function applyViewMode() {
    el.canvasWrapper.style.display = viewMode === "diagram" ? "block" : "none";
    el.tableWrapper.style.display = viewMode === "table" ? "block" : "none";
    el.icicleWrapper.style.display = viewMode === "icicle" ? "block" : "none";
    el.viewModeBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.mode === viewMode));

    if (viewMode === "table") {
      renderTableView();
    } else if (viewMode === "icicle") {
      renderIcicleView();
    } else {
      render();
      fitToView();
    }
  }

  el.viewModeBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      viewMode = btn.dataset.mode;
      if (blocks.length > 0) { applyViewMode(); }
    });
  });

  function clearDiagram() {
    el.nodesLayer.innerHTML = "";
    el.edgesLayer.innerHTML = "";
  }

  // ── Layout: each block is a tree (scans are leaves; JOIN/HASH/MERGE/SORT branch) ──

  function countLeaves(node) {
    if (node.kind === "scan") { return 1; }
    const sum = node.children.reduce((acc, c) => acc + countLeaves(c), 0);
    return sum || 1;
  }

  function layoutNode(node, depth, xOffset) {
    const leaves = countLeaves(node);
    const width = leaves * (NODE_WIDTH + H_GAP) - H_GAP;
    const y = depth * (NODE_HEIGHT + V_GAP);

    if (node.kind === "scan") {
      return { node, x: xOffset + width / 2, y, width, children: [] };
    }

    let childX = xOffset;
    const childLayouts = node.children.map(child => {
      const laidOut = layoutNode(child, depth + 1, childX);
      childX += laidOut.width + H_GAP;
      return laidOut;
    });
    const first = childLayouts[0];
    const last = childLayouts[childLayouts.length - 1];
    const x = (first.x + last.x) / 2;
    return { node, x, y, width, children: childLayouts };
  }

  function layoutForest(nodes) {
    let xOffset = 0;
    const roots = [];
    nodes.forEach(node => {
      const laidOut = layoutNode(node, 0, xOffset);
      xOffset += laidOut.width + NODE_WIDTH; // extra gap between independent blocks
      roots.push(laidOut);
    });
    return roots;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function nodeLabel(node) {
    if (node.kind === "scan") {
      return { title: node.table, subtitle: scanMethodLabel(node) };
    }
    return { title: node.kind, subtitle: `${node.children.length} input${node.children.length === 1 ? '' : 's'}` };
  }

  function scanMethodLabel(node) {
    if (node.method === "NATURAL") { return "Natural Scan"; }
    if (node.method === "INDEX") { return `Index: ${node.indexes.join(', ')}`; }
    if (node.method === "ORDER") { return `Ordered: ${node.index}`; }
    return "";
  }

  function render() {
    clearDiagram();
    const roots = layoutForest(blocks);
    roots.forEach(renderLayoutNode);
  }

  function renderLayoutNode(layout) {
    layout.children.forEach(child => {
      renderEdge(layout, child);
      renderLayoutNode(child);
    });
    renderNode(layout);
  }

  function renderEdge(parent, child) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "plan-edge");
    path.setAttribute("marker-end", "url(#fb-arrow)");
    const x1 = parent.x, y1 = parent.y + NODE_HEIGHT;
    const x2 = child.x, y2 = child.y;
    const midY = (y1 + y2) / 2;
    path.setAttribute("d", `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`);
    el.edgesLayer.appendChild(path);
  }

  function renderNode(layout) {
    const node = layout.node;
    const label = nodeLabel(node);
    const isWrapper = node.kind !== "scan";
    const isNatural = node.kind === "scan" && node.method === "NATURAL";

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "plan-node"
      + (isWrapper ? " fb-wrapper" : "")
      + (isNatural ? " fb-natural" : "")
      + (selectedNode === node ? " fb-selected" : ""));
    g.setAttribute("transform", `translate(${layout.x - NODE_WIDTH / 2},${layout.y})`);

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", NODE_WIDTH);
    rect.setAttribute("height", NODE_HEIGHT);
    rect.setAttribute("rx", 4);
    g.appendChild(rect);

    const title = document.createElementNS(SVG_NS, "text");
    title.setAttribute("class", "plan-node-title");
    title.setAttribute("x", NODE_WIDTH / 2);
    title.setAttribute("y", NODE_HEIGHT / 2 - 8);
    title.textContent = label.title;
    g.appendChild(title);

    const subtitle = document.createElementNS(SVG_NS, "text");
    subtitle.setAttribute("x", NODE_WIDTH / 2);
    subtitle.setAttribute("y", NODE_HEIGHT / 2 + 10);
    subtitle.textContent = label.subtitle;
    g.appendChild(subtitle);

    g.addEventListener("click", event => {
      event.stopPropagation();
      selectedNode = node;
      showDetail(node);
      render();
    });

    el.nodesLayer.appendChild(g);
  }

  function showDetail(node) {
    el.detailPanel.style.display = "block";
    if (node.kind === "scan") {
      el.detailHeading.textContent = node.table;
      const rows = [["Access method", node.method]];
      if (node.method === "INDEX") { rows.push(["Index(es)", node.indexes.join(", ")]); }
      if (node.method === "ORDER") { rows.push(["Ordered via", node.index]); }
      if (node.method === "NATURAL") { rows.push(["Note", "Full table scan — consider adding an index if this table is large."]); }
      el.detailBody.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
    } else {
      el.detailHeading.textContent = node.kind;
      el.detailBody.innerHTML = `<dt>Inputs</dt><dd>${node.children.length}</dd>`;
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  el.canvas.addEventListener("mousedown", event => {
    if (event.target.closest(".plan-node")) { return; }
    if (selectedNode) {
      selectedNode = null;
      el.detailPanel.style.display = "none";
      render();
    }
  });

  // ── Table view ────────────────────────────────────────────────────────────

  /** Flattens the parsed tree(s) into one row per node, depth-first, for the sortable table view. */
  function flattenBlocks(blocksArr) {
    const rows = [];
    let counter = 0;
    function visit(node, depth) {
      counter += 1;
      if (node.kind === "scan") {
        rows.push({
          order: counter,
          depth,
          kind: "Scan",
          table: node.table,
          method: node.method,
          detail: node.method === "INDEX" ? node.indexes.join(", ") : (node.method === "ORDER" ? node.index : ""),
          node,
        });
      } else {
        rows.push({
          order: counter,
          depth,
          kind: node.kind,
          table: "",
          method: "",
          detail: `${node.children.length} input${node.children.length === 1 ? '' : 's'}`,
          node,
        });
        node.children.forEach(child => visit(child, depth + 1));
      }
    }
    blocksArr.forEach(block => visit(block, 0));
    return rows;
  }

  function sortRows(rows, column, dir) {
    const numeric = column === "order" || column === "depth";
    const sorted = rows.slice().sort((a, b) => {
      const av = numeric ? a[column] : String(a[column]).toLowerCase();
      const bv = numeric ? b[column] : String(b[column]).toLowerCase();
      if (av < bv) { return -1; }
      if (av > bv) { return 1; }
      return 0;
    });
    if (dir === "desc") { sorted.reverse(); }
    return sorted;
  }

  function renderTableView() {
    const rows = sortRows(flattenBlocks(blocks), tableSort.column, tableSort.dir);
    el.planTableBody.innerHTML = "";
    rows.forEach(row => {
      const tr = document.createElement("tr");
      if (row.node === selectedNode) { tr.classList.add("fb-selected-row"); }
      if (row.method === "NATURAL") { tr.classList.add("fb-natural-row"); }

      const cells = [row.order, row.kind, row.table, row.method, row.detail, row.depth];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (i === 3) { td.classList.add("fb-method-cell"); }
        tr.appendChild(td);
      });

      tr.addEventListener("click", () => {
        selectedNode = row.node;
        showDetail(row.node);
        renderTableView();
      });

      el.planTableBody.appendChild(tr);
    });
    updateSortHeaders();
  }

  function updateSortHeaders() {
    el.planTableHeaders.forEach(th => {
      th.classList.toggle("fb-sorted", th.dataset.sort === tableSort.column);
      th.classList.toggle("fb-desc", th.dataset.sort === tableSort.column && tableSort.dir === "desc");
    });
  }

  el.planTableHeaders.forEach(th => {
    th.addEventListener("click", () => {
      const column = th.dataset.sort;
      if (tableSort.column === column) {
        tableSort.dir = tableSort.dir === "asc" ? "desc" : "asc";
      } else {
        tableSort = { column, dir: "asc" };
      }
      renderTableView();
    });
  });

  // ── Icicle chart view ─────────────────────────────────────────────────────
  //
  // Firebird's legacy PLAN text carries no cost/row-count estimates at all (unlike a modern
  // optimizer's plan output), so there's no real "cost" to chart. This uses each node's share of
  // the plan's total leaf scans (the same countLeaves() weight layoutNode() already uses for the
  // diagram's node spacing) as the bar width instead -- a structural proxy, not a cost one. Rows
  // stack by depth (root at top); natural scans are colored the same warning color the diagram
  // and table already use, since for this plan format "which scans are unindexed" is the closest
  // available answer to "what looks expensive."

  const ICICLE_ROW_HEIGHT = 40;

  /** One segment per node: depth (row), x0/width as a 0..1 fraction of the chart's total width. */
  function icicleLayout(blocksArr) {
    const totalLeaves = blocksArr.reduce((sum, b) => sum + countLeaves(b), 0) || 1;
    const segments = [];

    function visit(node, depth, x0, width) {
      segments.push({ node, depth, x0, width });
      if (node.kind === "scan") { return; }
      const totalChildLeaves = node.children.reduce((sum, c) => sum + countLeaves(c), 0) || 1;
      let childX = x0;
      node.children.forEach(child => {
        const childWidth = width * (countLeaves(child) / totalChildLeaves);
        visit(child, depth + 1, childX, childWidth);
        childX += childWidth;
      });
    }

    let xCursor = 0;
    blocksArr.forEach(block => {
      const width = countLeaves(block) / totalLeaves;
      visit(block, 0, xCursor, width);
      xCursor += width;
    });
    return segments;
  }

  function renderIcicleView() {
    const segments = icicleLayout(blocks);
    const maxDepth = segments.reduce((m, s) => Math.max(m, s.depth), 0);
    el.icicleChart.innerHTML = "";
    el.icicleChart.style.height = `${(maxDepth + 1) * ICICLE_ROW_HEIGHT}px`;

    segments.forEach(seg => {
      const node = seg.node;
      const label = nodeLabel(node);
      const isWrapper = node.kind !== "scan";
      const isNatural = node.kind === "scan" && node.method === "NATURAL";

      const div = document.createElement("div");
      div.className = "icicle-segment"
        + (isWrapper ? " fb-wrapper" : "")
        + (isNatural ? " fb-natural" : "")
        + (selectedNode === node ? " fb-selected" : "");
      div.style.top = `${seg.depth * ICICLE_ROW_HEIGHT}px`;
      div.style.left = `${seg.x0 * 100}%`;
      div.style.width = `${seg.width * 100}%`;
      div.style.height = `${ICICLE_ROW_HEIGHT}px`;
      div.title = [label.title, label.subtitle].filter(Boolean).join(" — ");
      div.textContent = label.title;

      div.addEventListener("click", event => {
        event.stopPropagation();
        selectedNode = node;
        showDetail(node);
        renderIcicleView();
      });

      el.icicleChart.appendChild(div);
    });
  }

  el.icicleWrapper.addEventListener("mousedown", event => {
    if (event.target.closest(".icicle-segment")) { return; }
    if (selectedNode) {
      selectedNode = null;
      el.detailPanel.style.display = "none";
      renderIcicleView();
    }
  });

  // ── Raw text toggle ───────────────────────────────────────────────────────

  el.btnToggleRaw.addEventListener("click", () => {
    const isOpen = el.rawOutput.style.display !== "none";
    if (isOpen) {
      el.rawOutput.style.display = "none";
    } else {
      el.rawOutput.textContent = rawText;
      el.rawOutput.style.display = "block";
    }
  });

  // ── Pan / zoom / fit-to-view ─────────────────────────────────────────────

  function applyViewTransform() {
    el.viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.scale})`);
  }

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  let panState = null;
  el.canvas.addEventListener("mousedown", event => {
    if (event.target.closest(".plan-node")) { return; }
    panState = { startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
    el.canvas.classList.add("panning");
  });
  window.addEventListener("mousemove", event => {
    if (!panState) { return; }
    view.x = panState.originX + (event.clientX - panState.startX);
    view.y = panState.originY + (event.clientY - panState.startY);
    applyViewTransform();
  });
  window.addEventListener("mouseup", () => {
    panState = null;
    el.canvas.classList.remove("panning");
  });

  el.canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = el.canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    zoomAt(mouseX, mouseY, event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  function zoomAt(pointX, pointY, factor) {
    const newScale = clampScale(view.scale * factor);
    const ratio = newScale / view.scale;
    view.x = pointX - (pointX - view.x) * ratio;
    view.y = pointY - (pointY - view.y) * ratio;
    view.scale = newScale;
    applyViewTransform();
  }

  el.btnZoomIn.addEventListener("click", () => {
    const canvasWidth = el.canvas.clientWidth || 0;
    const canvasHeight = el.canvas.clientHeight || 0;
    zoomAt(canvasWidth / 2, canvasHeight / 2, 1.2);
  });
  el.btnZoomOut.addEventListener("click", () => {
    const canvasWidth = el.canvas.clientWidth || 0;
    const canvasHeight = el.canvas.clientHeight || 0;
    zoomAt(canvasWidth / 2, canvasHeight / 2, 1 / 1.2);
  });

  function diagramBounds() {
    const bbox = el.nodesLayer.getBBox ? el.nodesLayer.getBBox() : null;
    if (!bbox || (bbox.width === 0 && bbox.height === 0)) {
      return { minX: 0, minY: 0, maxX: NODE_WIDTH, maxY: NODE_HEIGHT };
    }
    return { minX: bbox.x, minY: bbox.y, maxX: bbox.x + bbox.width, maxY: bbox.y + bbox.height };
  }

  function fitToView() {
    if (blocks.length === 0) { return; }
    const bounds = diagramBounds();
    const w = bounds.maxX - bounds.minX || 1;
    const h = bounds.maxY - bounds.minY || 1;
    const canvasWidth = el.canvas.clientWidth || 800;
    const canvasHeight = el.canvas.clientHeight || 600;
    const padding = 60;
    const scale = clampScale(Math.min((canvasWidth - padding) / w, (canvasHeight - padding) / h));
    view.scale = scale;
    view.x = canvasWidth / 2 - (bounds.minX + w / 2) * scale;
    view.y = canvasHeight / 2 - (bounds.minY + h / 2) * scale;
    applyViewTransform();
  }

  el.btnFit.addEventListener("click", fitToView);

  // Test-only hook: no-op in a real webview (there is no `module` global there).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.__test__ = {
      layoutForest, countLeaves, nodeLabel, scanMethodLabel,
      flattenBlocks, sortRows, icicleLayout,
    };
  }
})();
