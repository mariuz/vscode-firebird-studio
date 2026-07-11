(function () {
  const vscode = acquireVsCodeApi();
  const SVG_NS = "http://www.w3.org/2000/svg";

  const el = {
    canvas: document.getElementById("canvas"),
    viewport: document.getElementById("viewport"),
    edgesLayer: document.getElementById("edges"),
    nodesLayer: document.getElementById("nodes"),
    minimap: document.getElementById("minimap"),
    minimapNodes: document.getElementById("minimap-nodes"),
    minimapViewport: document.getElementById("minimap-viewport"),
    loading: document.getElementById("loading"),
    errorBanner: document.getElementById("error-banner"),
    emptyBanner: document.getElementById("empty-banner"),
    status: document.getElementById("status"),
    btnRefresh: document.getElementById("btn-refresh"),
    btnAutoLayout: document.getElementById("btn-auto-layout"),
    btnFit: document.getElementById("btn-fit"),
    btnZoomIn: document.getElementById("btn-zoom-in"),
    btnZoomOut: document.getElementById("btn-zoom-out"),
  };

  const ROW_HEIGHT = 18;
  const HEADER_HEIGHT = 24;
  const COL_PADDING = 10;
  const MIN_NODE_WIDTH = 150;
  const MIN_SCALE = 0.15;
  const MAX_SCALE = 3;

  /** @type {{tables: Array, relationships: Array} | null} */
  let graph = null;
  /** tableName -> { x, y, width, height } */
  let positions = {};
  const view = { x: 0, y: 0, scale: 1 };

  // ── Messaging ──────────────────────────────────────────────────────────────

  vscode.postMessage({ command: "getData" });

  window.addEventListener("message", event => {
    const msg = event.data;
    if (msg.command === "schemaData") {
      handleSchemaData(msg.data);
    }
  });

  function handleSchemaData(data) {
    el.loading.style.display = "none";

    if (data.error) {
      el.errorBanner.textContent = data.error;
      el.errorBanner.style.display = "block";
      el.emptyBanner.style.display = "none";
      return;
    }
    el.errorBanner.style.display = "none";

    graph = data.graph;
    if (!graph.tables || graph.tables.length === 0) {
      el.emptyBanner.style.display = "block";
      clearDiagram();
      return;
    }
    el.emptyBanner.style.display = "none";

    // Keep existing positions for tables that survived a refresh; only lay out new ones.
    const previous = positions;
    positions = {};
    const newTables = [];
    graph.tables.forEach(t => {
      if (previous[t.name]) {
        positions[t.name] = previous[t.name];
      } else {
        newTables.push(t.name);
      }
    });

    measureNodes();
    if (newTables.length > 0) {
      runAutoLayout(Object.keys(previous).length > 0 ? newTables : null);
    }

    render();
    fitToView();
    setStatus(`${graph.tables.length} table(s), ${graph.relationships.length} relationship(s)`);
  }

  function setStatus(text) {
    el.status.textContent = text;
  }

  function clearDiagram() {
    el.nodesLayer.innerHTML = "";
    el.edgesLayer.innerHTML = "";
    el.minimapNodes.innerHTML = "";
  }

  // ── Sizing ─────────────────────────────────────────────────────────────────
  // SVG text isn't monospace, so table widths are based on the real rendered
  // width of the longest label rather than a fixed character-width guess.

  function measureTextWidth(text, className) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("class", className);
    t.textContent = text;
    t.style.visibility = "hidden";
    el.nodesLayer.appendChild(t);
    const width = t.getBBox().width;
    el.nodesLayer.removeChild(t);
    return width;
  }

  function columnLabel(col) {
    return col.isPrimaryKey ? `🔑 ${col.name}` : col.name;
  }

  function columnTypeLabel(col) {
    return col.length ? `${col.type}(${col.length})` : col.type;
  }

  function measureNodes() {
    graph.tables.forEach(table => {
      let maxWidth = measureTextWidth(table.name, "fb-table-header-text") + 24;
      table.columns.forEach(col => {
        const w =
          measureTextWidth(columnLabel(col), "fb-col-text") +
          measureTextWidth(columnTypeLabel(col), "fb-col-type") +
          COL_PADDING * 3;
        if (w > maxWidth) { maxWidth = w; }
      });
      const width = Math.max(MIN_NODE_WIDTH, Math.ceil(maxWidth));
      const height = HEADER_HEIGHT + table.columns.length * ROW_HEIGHT;
      const existing = positions[table.name];
      positions[table.name] = { x: existing ? existing.x : 0, y: existing ? existing.y : 0, width, height };
    });
  }

  // ── Force-directed auto layout ───────────────────────────────────────────
  // A small from-scratch simulation (repulsion between every pair of tables,
  // spring attraction along foreign-key edges) — no charting/graph library is
  // vendored in this extension, so this replaces what a library like d3-force
  // would otherwise provide.

  function runAutoLayout(onlyThese) {
    const tables = graph.tables;
    const n = tables.length;
    if (n === 0) { return; }

    const fullRelayout = !onlyThese;
    const movable = fullRelayout ? tables.map(t => t.name) : onlyThese;
    const movableSet = new Set(movable);

    // Seed positions for tables that need one, spread around a circle so the
    // simulation doesn't start from a total pile-up at the origin.
    const R = Math.max(260, n * 55);
    let seedIndex = 0;
    tables.forEach(t => {
      if (!movableSet.has(t.name)) { return; }
      const angle = (seedIndex / Math.max(1, movable.length)) * Math.PI * 2;
      seedIndex++;
      const p = positions[t.name];
      p.x = R * Math.cos(angle) - p.width / 2;
      p.y = R * Math.sin(angle) - p.height / 2;
    });

    const indexByName = {};
    tables.forEach((t, i) => { indexByName[t.name] = i; });
    const edges = (graph.relationships || [])
      .map(r => ({ a: indexByName[r.table], b: indexByName[r.refTable] }))
      .filter(e => e.a !== undefined && e.b !== undefined && e.a !== e.b);

    const ITERATIONS = 300;
    const REPULSION = 14000;
    const SPRING = 0.02;
    const IDEAL_EDGE_LEN = 260;

    function center(p) {
      return { cx: p.x + p.width / 2, cy: p.y + p.height / 2 };
    }

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const cooling = 1 - iter / ITERATIONS;
      const forces = tables.map(() => ({ x: 0, y: 0 }));

      for (let i = 0; i < n; i++) {
        const pi = center(positions[tables[i].name]);
        for (let j = i + 1; j < n; j++) {
          const pj = center(positions[tables[j].name]);
          let dx = pi.cx - pj.cx;
          let dy = pi.cy - pj.cy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = REPULSION / (dist * dist);
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          forces[i].x += dx; forces[i].y += dy;
          forces[j].x -= dx; forces[j].y -= dy;
        }
      }

      edges.forEach(e => {
        const pa = center(positions[tables[e.a].name]);
        const pb = center(positions[tables[e.b].name]);
        const dx = pb.cx - pa.cx;
        const dy = pb.cy - pa.cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - IDEAL_EDGE_LEN) * SPRING;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        forces[e.a].x += fx; forces[e.a].y += fy;
        forces[e.b].x -= fx; forces[e.b].y -= fy;
      });

      tables.forEach((t, i) => {
        if (!movableSet.has(t.name)) { return; }
        const p = positions[t.name];
        p.x += forces[i].x * cooling * 0.05;
        p.y += forces[i].y * cooling * 0.05;
      });
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    clearDiagram();
    graph.tables.forEach(renderTableNode);
    graph.relationships.forEach(renderEdge);
    renderMinimap();
  }

  function renderTableNode(table) {
    const pos = positions[table.name];
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "fb-table-node");
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);
    g.setAttribute("data-table", table.name);

    const body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("class", "fb-table-body");
    body.setAttribute("width", pos.width);
    body.setAttribute("height", pos.height);
    g.appendChild(body);

    const header = document.createElementNS(SVG_NS, "rect");
    header.setAttribute("class", "fb-table-header");
    header.setAttribute("width", pos.width);
    header.setAttribute("height", HEADER_HEIGHT);
    g.appendChild(header);

    const headerText = document.createElementNS(SVG_NS, "text");
    headerText.setAttribute("class", "fb-table-header-text");
    headerText.setAttribute("x", COL_PADDING);
    headerText.setAttribute("y", HEADER_HEIGHT / 2);
    headerText.textContent = table.name;
    g.appendChild(headerText);

    table.columns.forEach((col, i) => {
      const rowY = HEADER_HEIGHT + i * ROW_HEIGHT;

      if (i > 0) {
        const sep = document.createElementNS(SVG_NS, "line");
        sep.setAttribute("class", "fb-table-row-sep");
        sep.setAttribute("x1", 0);
        sep.setAttribute("x2", pos.width);
        sep.setAttribute("y1", rowY);
        sep.setAttribute("y2", rowY);
        g.appendChild(sep);
      }

      const nameText = document.createElementNS(SVG_NS, "text");
      nameText.setAttribute("class", "fb-col-text" + (col.isPrimaryKey ? " fb-pk" : ""));
      nameText.setAttribute("x", COL_PADDING);
      nameText.setAttribute("y", rowY + ROW_HEIGHT / 2);
      nameText.textContent = columnLabel(col);
      g.appendChild(nameText);

      const typeText = document.createElementNS(SVG_NS, "text");
      typeText.setAttribute("class", "fb-col-type");
      typeText.setAttribute("x", pos.width - COL_PADDING);
      typeText.setAttribute("y", rowY + ROW_HEIGHT / 2);
      typeText.setAttribute("text-anchor", "end");
      typeText.textContent = columnTypeLabel(col);
      g.appendChild(typeText);
    });

    g.addEventListener("mousedown", onNodeMouseDown);
    el.nodesLayer.appendChild(g);
  }

  /** Anchor point for a column on a table's left or right edge, in diagram coordinates. */
  function columnAnchor(tableName, columnName, side) {
    const pos = positions[tableName];
    const table = graph.tables.find(t => t.name === tableName);
    const colIndex = table ? table.columns.findIndex(c => c.name === columnName) : -1;
    const rowY = colIndex >= 0 ? HEADER_HEIGHT + colIndex * ROW_HEIGHT + ROW_HEIGHT / 2 : pos.height / 2;
    return { x: pos.x + (side === "right" ? pos.width : 0), y: pos.y + rowY };
  }

  function renderEdge(rel) {
    const sourcePos = positions[rel.table];
    const targetPos = positions[rel.refTable];
    if (!sourcePos || !targetPos) { return; } // referenced table not in this schema snapshot

    const sourceOnLeft = sourcePos.x + sourcePos.width / 2 <= targetPos.x + targetPos.width / 2;
    const from = columnAnchor(rel.table, rel.column, sourceOnLeft ? "right" : "left");
    const to = columnAnchor(rel.refTable, rel.refColumn, sourceOnLeft ? "left" : "right");

    const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
    const c1x = sourceOnLeft ? from.x + dx : from.x - dx;
    const c2x = sourceOnLeft ? to.x - dx : to.x + dx;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "fb-edge");
    path.setAttribute("data-source", rel.table);
    path.setAttribute("data-target", rel.refTable);
    path.setAttribute("d", `M${from.x},${from.y} C${c1x},${from.y} ${c2x},${to.y} ${to.x},${to.y}`);
    el.edgesLayer.appendChild(path);
  }

  // ── Highlighting (hover a table to see just its relationships) ─────────────

  el.nodesLayer.addEventListener("mouseover", event => {
    const nodeEl = event.target.closest(".fb-table-node");
    if (!nodeEl) { return; }
    const tableName = nodeEl.getAttribute("data-table");
    const edges = el.edgesLayer.querySelectorAll(".fb-edge");
    edges.forEach(edge => {
      const related = edge.getAttribute("data-source") === tableName || edge.getAttribute("data-target") === tableName;
      edge.classList.toggle("fb-edge-dim", !related);
    });
  });
  el.nodesLayer.addEventListener("mouseleave", () => {
    el.edgesLayer.querySelectorAll(".fb-edge").forEach(edge => edge.classList.remove("fb-edge-dim"));
  });

  // ── Minimap ──────────────────────────────────────────────────────────────

  function schemaBounds() {
    const names = Object.keys(positions);
    if (names.length === 0) { return { minX: 0, minY: 0, maxX: 100, maxY: 100 }; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    names.forEach(name => {
      const p = positions[name];
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.width);
      maxY = Math.max(maxY, p.y + p.height);
    });
    return { minX, minY, maxX, maxY };
  }

  function renderMinimap() {
    el.minimapNodes.innerHTML = "";
    const bounds = schemaBounds();
    const w = bounds.maxX - bounds.minX || 1;
    const h = bounds.maxY - bounds.minY || 1;
    const mmWidth = el.minimap.clientWidth || 160;
    const mmHeight = el.minimap.clientHeight || 110;
    const scale = Math.min(mmWidth / w, mmHeight / h) * 0.9;
    el.minimap.dataset.scale = String(scale);
    el.minimap.dataset.minX = String(bounds.minX);
    el.minimap.dataset.minY = String(bounds.minY);

    Object.keys(positions).forEach(name => {
      const p = positions[name];
      const r = document.createElementNS(SVG_NS, "rect");
      r.setAttribute("x", (p.x - bounds.minX) * scale);
      r.setAttribute("y", (p.y - bounds.minY) * scale);
      r.setAttribute("width", Math.max(2, p.width * scale));
      r.setAttribute("height", Math.max(2, p.height * scale));
      el.minimapNodes.appendChild(r);
    });
    updateMinimapViewport();
  }

  function updateMinimapViewport() {
    // minX/minY/scale come from the last renderMinimap() call, not recomputed here, so the
    // viewport indicator stays aligned with the minimap's own (already-drawn) node rectangles.
    const scale = parseFloat(el.minimap.dataset.scale || "1");
    const minX = parseFloat(el.minimap.dataset.minX || "0");
    const minY = parseFloat(el.minimap.dataset.minY || "0");
    const canvasWidth = el.canvas.clientWidth || 1;
    const canvasHeight = el.canvas.clientHeight || 1;

    // Visible diagram-space rectangle given the current pan/zoom.
    const visX = -view.x / view.scale;
    const visY = -view.y / view.scale;
    const visW = canvasWidth / view.scale;
    const visH = canvasHeight / view.scale;

    el.minimapViewport.setAttribute("x", (visX - minX) * scale);
    el.minimapViewport.setAttribute("y", (visY - minY) * scale);
    el.minimapViewport.setAttribute("width", Math.max(1, visW * scale));
    el.minimapViewport.setAttribute("height", Math.max(1, visH * scale));
  }

  el.minimap.addEventListener("mousedown", event => {
    const scale = parseFloat(el.minimap.dataset.scale || "1");
    const minX = parseFloat(el.minimap.dataset.minX || "0");
    const minY = parseFloat(el.minimap.dataset.minY || "0");
    const rect = el.minimap.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    const targetDiagramX = clickX / scale + minX;
    const targetDiagramY = clickY / scale + minY;
    const canvasWidth = el.canvas.clientWidth || 1;
    const canvasHeight = el.canvas.clientHeight || 1;
    view.x = -(targetDiagramX * view.scale) + canvasWidth / 2;
    view.y = -(targetDiagramY * view.scale) + canvasHeight / 2;
    applyViewTransform();
  });

  // ── Pan / zoom / fit-to-view ─────────────────────────────────────────────

  function applyViewTransform() {
    el.viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.scale})`);
    updateMinimapViewport();
  }

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  let panState = null;
  el.canvas.addEventListener("mousedown", event => {
    if (event.target.closest(".fb-table-node")) { return; } // node dragging handles this
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

  function fitToView() {
    if (!graph || graph.tables.length === 0) { return; }
    const bounds = schemaBounds();
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

  el.btnAutoLayout.addEventListener("click", () => {
    if (!graph) { return; }
    runAutoLayout(null);
    render();
    fitToView();
  });

  el.btnRefresh.addEventListener("click", () => {
    setStatus("Refreshing…");
    el.loading.style.display = "block";
    el.errorBanner.style.display = "none";
    vscode.postMessage({ command: "refresh" });
  });

  // ── Node dragging ─────────────────────────────────────────────────────────

  let dragState = null;
  function onNodeMouseDown(event) {
    event.stopPropagation();
    const nodeEl = event.currentTarget;
    const tableName = nodeEl.getAttribute("data-table");
    dragState = {
      tableName,
      startX: event.clientX,
      startY: event.clientY,
      originX: positions[tableName].x,
      originY: positions[tableName].y,
    };
  }
  window.addEventListener("mousemove", event => {
    if (!dragState) { return; }
    const dx = (event.clientX - dragState.startX) / view.scale;
    const dy = (event.clientY - dragState.startY) / view.scale;
    const p = positions[dragState.tableName];
    p.x = dragState.originX + dx;
    p.y = dragState.originY + dy;
    render();
  });
  window.addEventListener("mouseup", () => {
    dragState = null;
  });
})();
