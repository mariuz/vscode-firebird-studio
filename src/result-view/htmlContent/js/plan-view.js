/**
 * Renders a parsed Firebird query-plan tree (see src/shared/plan-parser.ts) as an interactive
 * diagram/table, scoped to a single container element. This is an instance-scoped adaptation of
 * src/query-plan-view/htmlContent/js/app.js's rendering logic -- that webview only ever shows one
 * plan at a time (module-level state is fine there), but result-view can host several "Query
 * Plan" tabs at once (one per batch statement), so every bit of state here lives inside the
 * closure create() returns rather than at module scope.
 *
 * No messaging of its own: the caller (app.js) already resolves plan data via the extension host
 * (interpretPlanText() on that side) and pushes the result in through show()/showLoading(). The
 * one exception is the "🤖 Analyze" button (phase 6, docs/roadmap/query-plan-visualizer.md) --
 * it doesn't know the extension-host messaging shape either, so it just calls the `onAnalyze`
 * callback passed into create(container, { onAnalyze }) with the plan's raw text; the caller
 * decides what message to post.
 */
window.FirebirdPlanView = (function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const NODE_WIDTH = 170;
  const NODE_HEIGHT = 46;
  const H_GAP = 24;
  const V_GAP = 56;
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 3;

  let instanceCounter = 0;

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) { e.className = className; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Builds the (initially empty) DOM structure for one instance and returns element references. */
  function buildDom(container) {
    container.classList.add("fb-plan-view");
    const instanceId = `fb-plan-${++instanceCounter}`;

    const toolbar = el("div", "fb-plan-toolbar");
    const btnFit = el("button", "secondary", "Fit to View");
    const zoomWrap = el("span", "fb-plan-zoom-controls");
    const btnZoomOut = el("button", "secondary", "−");
    const btnZoomIn = el("button", "secondary", "+");
    zoomWrap.append(btnZoomOut, btnZoomIn);
    const btnToggleTable = el("button", "secondary", "Table View");
    const btnToggleRaw = el("button", "secondary", "Raw Text");
    const btnAnalyze = el("button", "secondary", "🤖 Analyze");
    btnAnalyze.disabled = true;
    const spacer = el("span", "fb-plan-toolbar-spacer");
    const status = el("span", "fb-plan-status");
    toolbar.append(btnFit, zoomWrap, btnToggleTable, btnToggleRaw, btnAnalyze, spacer, status);

    const main = el("div", "fb-plan-main");

    const canvasWrapper = el("div", "fb-plan-canvas-wrapper");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "fb-plan-canvas");
    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    const markerId = `${instanceId}-arrow`;
    marker.setAttribute("id", markerId);
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "7");
    marker.setAttribute("refY", "4");
    marker.setAttribute("orient", "auto");
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    const markerPath = document.createElementNS(SVG_NS, "path");
    markerPath.setAttribute("d", "M0,0 L8,4 L0,8 Z");
    markerPath.setAttribute("class", "fb-plan-arrow-fill");
    marker.appendChild(markerPath);
    defs.appendChild(marker);
    const viewport = document.createElementNS(SVG_NS, "g");
    const edgesLayer = document.createElementNS(SVG_NS, "g");
    const nodesLayer = document.createElementNS(SVG_NS, "g");
    viewport.append(edgesLayer, nodesLayer);
    svg.append(defs, viewport);
    canvasWrapper.appendChild(svg);

    const tableWrapper = el("div", "fb-plan-table-wrapper");
    tableWrapper.style.display = "none";
    const table = el("table", "fb-plan-table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const columns = [
      ["order", "#"], ["kind", "Node"], ["table", "Table"],
      ["method", "Access Method"], ["detail", "Index(es)"], ["depth", "Depth"],
    ];
    const headerCells = columns.map(([key, label]) => {
      const th = document.createElement("th");
      th.textContent = label;
      th.dataset.sort = key;
      headRow.appendChild(th);
      return th;
    });
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);
    tableWrapper.appendChild(table);

    const errorBanner = el("div", "fb-plan-error-banner");
    errorBanner.style.display = "none";
    const emptyBanner = el("div", "fb-plan-empty-banner", "No plan to show.");
    emptyBanner.style.display = "none";

    const detailPanel = el("div", "fb-plan-detail-panel");
    detailPanel.style.display = "none";
    const detailHeading = el("h4", "fb-plan-detail-heading", "Node");
    const detailBody = document.createElement("dl");
    detailPanel.append(detailHeading, detailBody);

    main.append(canvasWrapper, tableWrapper, errorBanner, emptyBanner, detailPanel);

    const rawOutput = el("pre", "fb-plan-raw-output");
    rawOutput.style.display = "none";

    container.append(toolbar, main, rawOutput);

    return {
      markerId, toolbar, btnFit, btnZoomOut, btnZoomIn, btnToggleTable, btnToggleRaw, btnAnalyze, status,
      canvasWrapper, svg, viewport, edgesLayer, nodesLayer,
      tableWrapper, tbody, headerCells,
      errorBanner, emptyBanner, detailPanel, detailHeading, detailBody, rawOutput,
    };
  }

  function create(container, options) {
    const dom = buildDom(container);
    const onAnalyze = (options && options.onAnalyze) || null;

    // ── Per-instance state ────────────────────────────────────────────────────
    let blocks = [];
    let rawText = "";
    let selectedNode = null;
    let viewMode = "diagram"; // "diagram" | "table"
    let tableSort = { column: "order", dir: "asc" };
    const view = { x: 0, y: 0, scale: 1 };

    function setStatus(text) { dom.status.textContent = text; }

    if (onAnalyze) {
      dom.btnAnalyze.addEventListener("click", () => {
        dom.btnAnalyze.disabled = true;
        dom.btnAnalyze.textContent = "🤖 Analyzing…";
        onAnalyze(rawText);
        setTimeout(() => {
          dom.btnAnalyze.disabled = false;
          dom.btnAnalyze.textContent = "🤖 Analyze";
        }, 3000);
      });
    } else {
      dom.btnAnalyze.style.display = "none";
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
        xOffset += laidOut.width + NODE_WIDTH;
        roots.push(laidOut);
      });
      return roots;
    }

    // ── Diagram rendering ────────────────────────────────────────────────────

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

    function clearDiagram() {
      dom.nodesLayer.innerHTML = "";
      dom.edgesLayer.innerHTML = "";
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
      path.setAttribute("class", "fb-plan-edge");
      path.setAttribute("marker-end", `url(#${dom.markerId})`);
      const x1 = parent.x, y1 = parent.y + NODE_HEIGHT;
      const x2 = child.x, y2 = child.y;
      const midY = (y1 + y2) / 2;
      path.setAttribute("d", `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`);
      dom.edgesLayer.appendChild(path);
    }

    function renderNode(layout) {
      const node = layout.node;
      const label = nodeLabel(node);
      const isWrapper = node.kind !== "scan";
      const isNatural = node.kind === "scan" && node.method === "NATURAL";

      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "fb-plan-node"
        + (isWrapper ? " fb-plan-wrapper" : "")
        + (isNatural ? " fb-plan-natural" : "")
        + (selectedNode === node ? " fb-plan-node-selected" : ""));
      g.setAttribute("transform", `translate(${layout.x - NODE_WIDTH / 2},${layout.y})`);

      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("width", NODE_WIDTH);
      rect.setAttribute("height", NODE_HEIGHT);
      rect.setAttribute("rx", 4);
      g.appendChild(rect);

      const title = document.createElementNS(SVG_NS, "text");
      title.setAttribute("class", "fb-plan-node-title");
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

      dom.nodesLayer.appendChild(g);
    }

    function showDetail(node) {
      dom.detailPanel.style.display = "block";
      if (node.kind === "scan") {
        dom.detailHeading.textContent = node.table;
        const rows = [["Access method", node.method]];
        if (node.method === "INDEX") { rows.push(["Index(es)", node.indexes.join(", ")]); }
        if (node.method === "ORDER") { rows.push(["Ordered via", node.index]); }
        if (node.method === "NATURAL") { rows.push(["Note", "Full table scan — consider adding an index if this table is large."]); }
        dom.detailBody.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
      } else {
        dom.detailHeading.textContent = node.kind;
        dom.detailBody.innerHTML = `<dt>Inputs</dt><dd>${node.children.length}</dd>`;
      }
    }

    dom.canvasWrapper.addEventListener("mousedown", event => {
      if (event.target.closest(".fb-plan-node")) { return; }
      if (selectedNode) {
        selectedNode = null;
        dom.detailPanel.style.display = "none";
        render();
      }
    });

    // ── Table view ────────────────────────────────────────────────────────────

    function flattenBlocks(blocksArr) {
      const rows = [];
      let counter = 0;
      function visit(node, depth) {
        counter += 1;
        if (node.kind === "scan") {
          rows.push({
            order: counter, depth, kind: "Scan", table: node.table, method: node.method,
            detail: node.method === "INDEX" ? node.indexes.join(", ") : (node.method === "ORDER" ? node.index : ""),
            node,
          });
        } else {
          rows.push({
            order: counter, depth, kind: node.kind, table: "", method: "",
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
      dom.tbody.innerHTML = "";
      rows.forEach(row => {
        const tr = document.createElement("tr");
        if (row.node === selectedNode) { tr.classList.add("fb-plan-row-selected"); }
        if (row.method === "NATURAL") { tr.classList.add("fb-plan-row-natural"); }

        const cells = [row.order, row.kind, row.table, row.method, row.detail, row.depth];
        cells.forEach((text, i) => {
          const td = document.createElement("td");
          td.textContent = text;
          if (i === 3) { td.classList.add("fb-plan-method-cell"); }
          tr.appendChild(td);
        });

        tr.addEventListener("click", () => {
          selectedNode = row.node;
          showDetail(row.node);
          renderTableView();
        });

        dom.tbody.appendChild(tr);
      });
      updateSortHeaders();
    }

    function updateSortHeaders() {
      dom.headerCells.forEach(th => {
        th.classList.toggle("fb-plan-sorted", th.dataset.sort === tableSort.column);
        th.classList.toggle("fb-plan-desc", th.dataset.sort === tableSort.column && tableSort.dir === "desc");
      });
    }

    dom.headerCells.forEach(th => {
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

    // ── Diagram / table view toggle ──────────────────────────────────────────

    function applyViewMode() {
      if (viewMode === "table") {
        dom.canvasWrapper.style.display = "none";
        dom.tableWrapper.style.display = "block";
        renderTableView();
      } else {
        dom.tableWrapper.style.display = "none";
        dom.canvasWrapper.style.display = "block";
        render();
        fitToView();
      }
    }

    dom.btnToggleTable.addEventListener("click", () => {
      viewMode = viewMode === "table" ? "diagram" : "table";
      dom.btnToggleTable.textContent = viewMode === "table" ? "Diagram View" : "Table View";
      if (blocks.length > 0) { applyViewMode(); }
    });

    // ── Raw text toggle ───────────────────────────────────────────────────────

    dom.btnToggleRaw.addEventListener("click", () => {
      const isOpen = dom.rawOutput.style.display !== "none";
      if (isOpen) {
        dom.rawOutput.style.display = "none";
      } else {
        dom.rawOutput.textContent = rawText;
        dom.rawOutput.style.display = "block";
      }
    });

    // ── Pan / zoom / fit-to-view ─────────────────────────────────────────────

    function applyViewTransform() {
      dom.viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.scale})`);
    }

    function clampScale(s) {
      return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
    }

    let panState = null;
    dom.canvasWrapper.addEventListener("mousedown", event => {
      if (event.target.closest(".fb-plan-node")) { return; }
      panState = { startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
      dom.svg.classList.add("panning");
    });
    window.addEventListener("mousemove", event => {
      if (!panState) { return; }
      view.x = panState.originX + (event.clientX - panState.startX);
      view.y = panState.originY + (event.clientY - panState.startY);
      applyViewTransform();
    });
    window.addEventListener("mouseup", () => {
      panState = null;
      dom.svg.classList.remove("panning");
    });

    dom.svg.addEventListener("wheel", event => {
      event.preventDefault();
      const rect = dom.svg.getBoundingClientRect();
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

    dom.btnZoomIn.addEventListener("click", () => {
      const w = dom.svg.clientWidth || 0;
      const h = dom.svg.clientHeight || 0;
      zoomAt(w / 2, h / 2, 1.2);
    });
    dom.btnZoomOut.addEventListener("click", () => {
      const w = dom.svg.clientWidth || 0;
      const h = dom.svg.clientHeight || 0;
      zoomAt(w / 2, h / 2, 1 / 1.2);
    });

    function diagramBounds() {
      const bbox = dom.nodesLayer.getBBox ? dom.nodesLayer.getBBox() : null;
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
      const canvasWidth = dom.svg.clientWidth || 800;
      const canvasHeight = dom.svg.clientHeight || 400;
      const padding = 60;
      const scale = clampScale(Math.min((canvasWidth - padding) / w, (canvasHeight - padding) / h));
      view.scale = scale;
      view.x = canvasWidth / 2 - (bounds.minX + w / 2) * scale;
      view.y = canvasHeight / 2 - (bounds.minY + h / 2) * scale;
      applyViewTransform();
    }

    dom.btnFit.addEventListener("click", fitToView);

    // ── Public API ────────────────────────────────────────────────────────────

    function showLoading() {
      dom.errorBanner.style.display = "none";
      dom.emptyBanner.style.display = "none";
      clearDiagram();
      dom.tbody.innerHTML = "";
      dom.btnAnalyze.disabled = true;
      setStatus("Loading…");
    }

    function show(data) {
      rawText = data.raw || "";

      if (data.error) {
        dom.errorBanner.textContent = data.error;
        dom.errorBanner.style.display = "block";
        dom.emptyBanner.style.display = "none";
        clearDiagram();
        dom.tbody.innerHTML = "";
        dom.btnAnalyze.disabled = true;
        setStatus("");
        return;
      }
      dom.errorBanner.style.display = "none";

      blocks = data.blocks || [];
      if (blocks.length === 0) {
        dom.emptyBanner.style.display = "block";
        clearDiagram();
        dom.tbody.innerHTML = "";
        dom.btnAnalyze.disabled = true;
        setStatus("");
        return;
      }
      dom.emptyBanner.style.display = "none";
      selectedNode = null;
      dom.detailPanel.style.display = "none";
      dom.btnAnalyze.disabled = false;
      applyViewMode();
      setStatus(`${blocks.length} plan block${blocks.length === 1 ? '' : 's'}`);
    }

    return { show, showLoading, __test__: { flattenBlocks, sortRows, layoutForest, countLeaves, nodeLabel, scanMethodLabel } };
  }

  return { create };
})();

// Test-only hook: no-op in a real webview (there is no `module` global there).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = window.FirebirdPlanView;
}
