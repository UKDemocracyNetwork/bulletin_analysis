/* Topic map: one dot per bulletin item, one bubble per topic group.
 *
 * Distance from a bubble's centre is relevance: 100% at the centre, 0% at the outer
 * ring, on the same scale in every group so distances compare across groups. Each
 * dot is pulled to its relevance radius by d3.forceRadial and pushed off its
 * neighbours by d3.forceCollide, so a crowded relevance level spreads into a thicker
 * band and an empty one leaves a gap: the shape is the data. Angle carries nothing.
 * The simulation is seeded from item ids, so the layout is the same on every load.
 * Rendering is canvas; d3-zoom drives pan and zoom, a quadtree drives hover.
 */
(() => {
  "use strict";

  const R_MAX = 320;               // world radius of 0% relevance
  const DOT_R = 3;                 // world radius of a dot
  const SPACING = 5;               // out-of-scope spiral step
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const GRID = [0.75, 0.5, 0.25];  // relevance gridlines drawn inside each bubble
  const OUT = "out_of_scope";
  const TIERS = [
    { key: "high", label: "Core" },
    { key: "medium", label: "Arguable" },
    { key: "low", label: "Stretch" },
  ];
  const TIER_LABEL = Object.fromEntries(TIERS.map((t) => [t.key, t.label]));
  const DOT_STYLES = [
    { conf: "high", a: 1 },
    { conf: "medium", a: 0.5 },
    { conf: "low", hollow: true },
  ];
  const GROUP_VARS = ["--g1", "--g2", "--g3", "--g4", "--g5", "--g6"];
  const pct = (f) => Math.round(f * 100) + "%";

  const $ = (s) => document.querySelector(s);
  const canvas = $("#map");
  const ctx = canvas.getContext("2d");
  const fmt = d3.format(",");

  let data, groups, byKey, items, byId;
  let colors = {}, ink = {};
  let layout = null;
  let transform = d3.zoomIdentity;
  let width = 0, height = 0, dpr = 1;
  let hover = null, selected = null;
  let tree = null;
  let frame = 0;
  const filters = { q: "", years: new Set(), tiers: new Set(TIERS.map((t) => t.key)), change: false, out: false };

  /* ---------- data ---------- */

  function hash(n) {
    let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }

  function prepare(raw) {
    data = raw;
    groups = raw.groups.map((g, i) => ({ ...g, cssVar: g.key === OUT ? "--g-out" : GROUP_VARS[i], items: [] }));
    byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    items = raw.items;
    byId = new Map();
    for (const it of items) {
      it.search = (it.h + " " + it.b + " " + it.links.map((l) => l[0] + " " + l[1]).join(" ")).toLowerCase();
      it.tie = hash(it.id);
      it.x = it.y = 0;
      byKey[it.g].items.push(it);
      byId.set(it.id, it);
    }
    for (const g of groups) {
      g.items.sort((a, b) => b.fit - a.fit || b.chg - a.chg || a.tie - b.tie);
      g.items.forEach((it, i) => (it.rank = i));
    }
  }

  /* ---------- layout ---------- */

  // Positions relative to the group centre, computed once per group.
  function settle(g) {
    if (g.local) return g.local;
    const nodes = g.items.map((it, i) => {
      if (g.key === OUT) {
        // no relevance to show: a plain sunflower disc
        const r = SPACING * Math.sqrt(i + 0.5), a = i * GOLDEN;
        return { it, x: r * Math.cos(a), y: r * Math.sin(a) };
      }
      const target = (1 - it.fit) * R_MAX;
      const a = it.tie * Math.PI * 2;
      return { it, target, x: target * Math.cos(a), y: target * Math.sin(a) };
    });
    if (g.key !== OUT) {
      d3.forceSimulation(nodes)
        .force("r", d3.forceRadial((d) => d.target).strength(0.9))
        .force("c", d3.forceCollide(DOT_R + 0.6).strength(0.85).iterations(2))
        .stop()
        .tick(320);
    }
    g.local = new Map(nodes.map((n) => [n.it, [n.x, n.y]]));
    g.extent = d3.max(nodes, (n) => Math.hypot(n.x, n.y)) + DOT_R;
    return g.local;
  }

  function computeLayout() {
    const active = groups.filter((g) => g.key !== OUT || filters.out);
    for (const g of active) settle(g);
    // Every bubble shares the 0% radius, so a grid reads cleanly. Pick the column
    // count that lets the grid fill the viewport best.
    const cell = Math.max(...active.map((g) => (g.key === OUT ? g.extent + SPACING : Math.max(R_MAX, g.extent) + 4)));
    const gapX = cell * 0.22, gapY = cell * 0.22 + 60;
    const [vw, vh] = viewArea();
    let cols = 1, best = 0;
    for (let n = 1; n <= active.length; n++) {
      const rows = Math.ceil(active.length / n);
      const s = Math.min(vw / (n * 2 * cell + (n - 1) * gapX), vh / (rows * 2 * cell + (rows - 1) * gapY));
      if (s > best) { best = s; cols = n; }
    }
    const rows = Math.ceil(active.length / cols);
    const W = cols * 2 * cell + (cols - 1) * gapX, H = rows * 2 * cell + (rows - 1) * gapY;
    const circles = active.map((g, i) => {
      const row = Math.floor(i / cols), col = i % cols;
      const inRow = Math.min(cols, active.length - row * cols);
      const offset = ((cols - inRow) * (2 * cell + gapX)) / 2; // centre a short last row
      return {
        g,
        r: g.key === OUT ? g.extent + SPACING : Math.max(R_MAX, g.extent) + 8,
        x: -W / 2 + offset + cell + col * (2 * cell + gapX),
        y: -H / 2 + cell + row * (2 * cell + gapY) + 20,
      };
    });
    const pos = new Map();
    for (const c of circles) {
      c.grid = c.g.key === OUT ? [] : GRID.map((f) => ({ r: (1 - f) * R_MAX, label: pct(f) }));
      for (const [it, [x, y]] of c.g.local) pos.set(it, [c.x + x, c.y + y]);
    }
    return { circles, pos, w: W, h: H + 40, byGroup: new Map(circles.map((c) => [c.g.key, c])) };
  }

  function applyLayout(next, animate) {
    const shown = new Set(next.circles.map((c) => c.g.key));
    if (!animate || !layout) {
      for (const [it, [x, y]] of next.pos) { it.x = x; it.y = y; }
      layout = next;
      rebuildIndex();
      return;
    }
    const from = new Map();
    for (const it of items) from.set(it, [it.x, it.y]);
    // newly shown items grow out of their bubble centre
    for (const [it] of next.pos) {
      if (!layout.pos.has(it)) { const c = next.byGroup.get(it.g); from.set(it, [c.x, c.y]); }
    }
    layout = { ...next, fading: groups.filter((g) => !shown.has(g.key) && g.items[0] && layout.pos.has(g.items[0])) };
    const ease = d3.easeCubicInOut;
    const t = d3.timer((elapsed) => {
      const k = ease(Math.min(1, elapsed / 750));
      for (const [it, [x1, y1]] of next.pos) {
        const [x0, y0] = from.get(it);
        it.x = x0 + (x1 - x0) * k;
        it.y = y0 + (y1 - y0) * k;
      }
      layout.fade = 1 - k;
      schedule();
      if (k === 1) { t.stop(); layout.fading = []; rebuildIndex(); }
    });
  }

  /* ---------- filtering ---------- */

  function matches(it) {
    if (filters.years.size && !filters.years.has(it.yr)) return false;
    if (it.g !== OUT && !filters.tiers.has(it.conf)) return false;
    if (filters.change && !it.chg) return false;
    if (filters.q && !filters.q.split(/\s+/).every((w) => it.search.includes(w))) return false;
    return true;
  }

  function isFiltered() {
    return filters.years.size || filters.tiers.size < TIERS.length || filters.change || filters.q;
  }

  function refilter() {
    for (const it of items) it.on = matches(it);
    rebuildIndex();
    updateCounts();
    if (!$("#list").hidden) renderList();
    if (hover && !hover.on) hover = null;
    schedule();
  }

  function rebuildIndex() {
    const pts = layout ? items.filter((it) => it.on && layout.pos.has(it)) : [];
    tree = d3.quadtree(pts, (d) => d.x, (d) => d.y);
  }

  /* ---------- drawing ---------- */

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const g of groups) colors[g.key] = cs.getPropertyValue(g.cssVar).trim();
    for (const k of ["surface", "ink", "ink-2", "ink-3", "hair"]) ink[k] = cs.getPropertyValue("--" + k).trim();
    ink.dark = (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
  }

  function alpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = 0;
    const k = transform.k;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = ink.surface;
    ctx.fillRect(0, 0, width, height);
    if (!layout) return;

    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(k, k);

    // bubbles, relevance gridlines and a centre mark (100%)
    for (const c of layout.circles) {
      const col = colors[c.g.key];
      const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
      grad.addColorStop(0, alpha(col, ink.dark ? 0.16 : 0.10));
      grad.addColorStop(1, alpha(col, ink.dark ? 0.04 : 0.03));
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 1 / k;
      if (!c.grid.length) {
        ctx.strokeStyle = alpha(col, 0.45);
        ctx.stroke();
        continue;
      }
      // the 0% line is the real edge of the scale, wherever collisions pushed dots
      ctx.beginPath();
      ctx.arc(c.x, c.y, R_MAX, 0, Math.PI * 2);
      ctx.strokeStyle = alpha(col, 0.45);
      ctx.stroke();
      ctx.strokeStyle = alpha(col, 0.22);
      for (const ring of c.grid) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, ring.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      const m = 5 / k;
      ctx.beginPath();
      ctx.moveTo(c.x - m, c.y); ctx.lineTo(c.x + m, c.y);
      ctx.moveTo(c.x, c.y - m); ctx.lineTo(c.x, c.y + m);
      ctx.strokeStyle = alpha(col, 0.6);
      ctx.stroke();
    }

    // dots, batched by group and state
    const r = Math.max(DOT_R, 1.1 / k);
    const fading = layout.fading && layout.fading.length ? new Set(layout.fading.map((g) => g.key)) : null;
    const dim = isFiltered();
    for (const g of groups) {
      const shown = layout.byGroup.has(g.key);
      if (!shown && !(fading && fading.has(g.key))) continue;
      const col = colors[g.key];
      const fadeA = shown ? 1 : layout.fade;
      // Core solid, Arguable lighter, Stretch hollow: the classifier's own confidence
      for (const pass of [false, true]) {
        const stateA = (pass || !dim ? 1 : 0.12) * fadeA;
        for (const style of DOT_STYLES) {
          ctx.beginPath();
          let any = false;
          for (const it of g.items) {
            if (it.on !== pass || (it.conf || "high") !== style.conf) continue;
            const base = pass && dim ? r * 1.6 : r;
            const rr = style.hollow ? base - 0.5 / k : base;
            ctx.moveTo(it.x + rr, it.y);
            ctx.arc(it.x, it.y, rr, 0, Math.PI * 2);
            any = true;
          }
          if (!any) continue;
          if (style.hollow) {
            ctx.lineWidth = Math.max(0.9, 1.1 / k);
            ctx.strokeStyle = alpha(col, stateA);
            ctx.stroke();
          } else {
            ctx.fillStyle = alpha(col, style.a * stateA);
            ctx.fill();
          }
        }
      }
    }

    // connections from the selected item to the other groups it touches
    if (selected && layout.pos.has(selected)) {
      ctx.lineWidth = 1.5 / k;
      for (const key of selected.also) {
        const c = layout.byGroup.get(key);
        if (!c) continue;
        const mx = (selected.x + c.x) / 2, my = (selected.y + c.y) / 2;
        const dx = c.x - selected.x, dy = c.y - selected.y;
        ctx.beginPath();
        ctx.moveTo(selected.x, selected.y);
        ctx.quadraticCurveTo(mx - dy * 0.18, my + dx * 0.18, c.x, c.y);
        ctx.strokeStyle = alpha(colors[key], 0.75);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(c.x, c.y, 4 / k, 0, Math.PI * 2);
        ctx.fillStyle = colors[key];
        ctx.fill();
      }
    }

    for (const [it, strong] of [[selected, true], [hover, false]]) {
      if (!it || !layout.pos.has(it)) continue;
      const hr = Math.max(r * 1.9, 5 / k);
      ctx.beginPath();
      ctx.arc(it.x, it.y, hr, 0, Math.PI * 2);
      ctx.fillStyle = colors[it.g];
      ctx.fill();
      ctx.lineWidth = 2 / k;
      ctx.strokeStyle = ink.surface;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(it.x, it.y, hr + 2 / k, 0, Math.PI * 2);
      ctx.lineWidth = (strong ? 2 : 1.25) / k;
      ctx.strokeStyle = ink.ink;
      ctx.stroke();
    }
    ctx.restore();

    drawLabels();
  }

  function halo(text, x, y) {
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.strokeStyle = ink.surface;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  function drawLabels() {
    const k = transform.k;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (const c of layout.circles) {
      const sx = transform.applyX(c.x);
      const top = transform.applyY(c.y - c.r);
      if (sx < -200 || sx > width + 200) continue;

      // relevance gridline labels on the upper-right diagonal, clear of the group name
      if (c.grid.length && k * R_MAX > 150) {
        ctx.font = "500 10.5px " + getComputedStyle(document.body).fontFamily;
        ctx.fillStyle = ink["ink-3"];
        const d = Math.SQRT1_2;
        for (const ring of [{ r: R_MAX, label: "0%" }, ...c.grid]) {
          halo(ring.label, transform.applyX(c.x + ring.r * d) + 10, transform.applyY(c.y - ring.r * d) - 2);
        }
        if (k * R_MAX > 500) halo("100%", sx + 18, transform.applyY(c.y) - 6);
      }

      const g = c.g;
      const shown = g.items.filter((it) => it.on).length;
      const font = getComputedStyle(document.body).fontFamily;
      ctx.font = "650 14px " + font;
      ctx.fillStyle = ink.ink;
      halo(g.name, sx, top - 24);
      ctx.font = "400 12px " + font;
      ctx.fillStyle = ink["ink-2"];
      const noun = g.key === OUT ? "items" : "stories";
      halo(isFiltered() ? `${fmt(shown)} of ${fmt(g.items.length)} ${noun}` : `${fmt(g.items.length)} ${noun}`, sx, top - 8);
    }
  }

  /* ---------- view ---------- */

  const zoom = d3.zoom()
    .scaleExtent([0.1, 60])
    .on("start", () => canvas.classList.add("dragging"))
    .on("zoom", (e) => {
      transform = e.transform;
      if (e.sourceEvent) hideHint();
      hideTooltip();
      schedule();
    })
    .on("end", () => canvas.classList.remove("dragging"));

  function topInset() {
    return document.body.classList.contains("immersive") ? 12 : $(".bar").getBoundingClientRect().bottom + 8;
  }

  // the screen area left for the map once the bar and legend are accounted for
  function viewArea() {
    const top = topInset();
    const bottom = width < 760 && !document.body.classList.contains("immersive") ? 70 : 12;
    const left = width < 760 || document.body.classList.contains("immersive") ? 0 : Math.min(310, width * 0.22);
    return [width - left, height - top - bottom, left, top];
  }

  function fitTransform(cx, cy, w, h) {
    const [vw, vh, left, top] = viewArea();
    const s = Math.min(vw / (w * 1.04), vh / (h * 1.04));
    return d3.zoomIdentity.translate(left + vw / 2, top + vh / 2).scale(s).translate(-cx, -cy);
  }

  function resetView(animate = true) {
    if (!layout) return;
    const t = fitTransform(0, 0, layout.w, layout.h);
    zoom.scaleExtent([t.k * 0.6, 60]);
    (animate ? d3.select(canvas).transition().duration(750) : d3.select(canvas)).call(zoom.transform, t);
  }

  function zoomToGroup(key) {
    const c = layout && layout.byGroup.get(key);
    if (!c) return;
    d3.select(canvas).transition().duration(750).call(zoom.transform, fitTransform(c.x, c.y - 20, 2 * c.r + 40, 2 * c.r + 100));
  }

  function zoomToItem(it) {
    const k = Math.max(transform.k, 4);
    const top = topInset();
    const panelW = width < 760 ? 0 : 412;
    // on a phone the panel is a bottom sheet, so centre the item in the strip above it
    const cx = (width - panelW) / 2, cy = top + (height - top) * (width < 760 ? 0.2 : 0.5);
    d3.select(canvas).transition().duration(750)
      .call(zoom.transform, d3.zoomIdentity.translate(cx, cy).scale(k).translate(-it.x, -it.y));
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    schedule();
  }

  /* ---------- hover & selection ---------- */

  function pick(event) {
    if (!tree) return null;
    const [mx, my] = d3.pointer(event, canvas);
    const [wx, wy] = transform.invert([mx, my]);
    return tree.find(wx, wy, 12 / transform.k) || null;
  }

  const tooltip = $("#tooltip");

  function showTooltip(it, event) {
    tooltip.querySelector(".tt-h").textContent = it.h || truncate(it.b, 110) || "(untitled)";
    tooltip.querySelector(".key").style.background = colors[it.g];
    tooltip.querySelector(".tt-g").textContent = byKey[it.g].name;
    const fit = it.g === OUT ? "" : `${pct(it.fit)} relevant · ${TIER_LABEL[it.conf]} · `;
    tooltip.querySelector(".tt-sub").textContent = fit + formatDate(it.d);
    tooltip.hidden = false;
    const pad = 16;
    const b = tooltip.getBoundingClientRect();
    let x = event.clientX + pad, y = event.clientY + pad;
    if (x + b.width > width - 8) x = event.clientX - b.width - pad;
    if (y + b.height > height - 8) y = event.clientY - b.height - pad;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function select(it, { zoomTo = false, updateHash = true } = {}) {
    selected = it;
    if (updateHash) {
      try { history.replaceState(null, "", it ? "#item=" + it.id : location.pathname + location.search); } catch (e) {}
    }
    if (!it) { $("#panel").hidden = true; schedule(); return; }
    renderPanel(it);
    if (zoomTo) zoomToItem(it);
    schedule();
  }

  /* ---------- panel ---------- */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function safeHref(href) {
    try {
      const u = new URL(href);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch (e) { return null; }
  }

  function renderPanel(it) {
    const p = $("#panel");
    const g = byKey[it.g];
    p.querySelector(".p-group .key").style.background = colors[it.g];
    p.querySelector(".p-gname").textContent = g.name;

    const inScope = it.g !== OUT;
    const bar = p.querySelector(".fitbar");
    bar.hidden = !inScope;
    const n = g.items.length;
    bar.firstElementChild.style.width = inScope ? pct(it.fit) : "0";
    bar.firstElementChild.style.background = colors[it.g];
    const fit = p.querySelector(".p-fit");
    fit.textContent = inScope
      ? `${pct(it.fit)} relevant · ${TIER_LABEL[it.conf]} · rank ${fmt(it.rank + 1)} of ${fmt(n)} in this group`
      : "Ruled out of scope by the classifier";
    if (it.chg) fit.append(el("span", "badge", "Reports a change"));

    p.querySelector(".p-h").textContent = it.h || truncate(it.b, 140);
    const meta = p.querySelector(".p-meta");
    meta.textContent = "";
    meta.append(formatDate(it.d) + " · ");
    const href = safeHref(it.iu);
    if (href) {
      const a = el("a", null, it.issue);
      a.href = href; a.target = "_blank"; a.rel = "noopener";
      meta.append(a);
    } else meta.append(it.issue);
    if (it.sec) meta.append(" · " + it.sec);
    const body = p.querySelector(".p-body");
    body.textContent = it.b;
    body.hidden = !it.h && it.b.length <= 140;

    const section = (sel, value) => {
      const s = p.querySelector(sel);
      s.hidden = !value;
      if (value) s.querySelector("p").textContent = value;
    };
    section(".p-why", it.why ? "This matters democratically because " + it.why.replace(/^this matters democratically because\s*/i, "") : "");
    section(".p-note", it.note);

    const also = p.querySelector(".p-also");
    also.hidden = !it.also.length;
    const tags = also.querySelector(".tags");
    tags.textContent = "";
    for (const key of it.also) {
      const b = el("button", "tag");
      const sw = el("span", "key");
      sw.style.background = colors[key];
      b.append(sw, byKey[key].name);
      b.addEventListener("click", () => zoomToGroup(key));
      tags.append(b);
    }

    const links = p.querySelector(".p-links");
    const ul = links.querySelector("ul");
    ul.textContent = "";
    for (const [h, text] of it.links) {
      const url = safeHref(h);
      if (!url) continue;
      const li = el("li");
      const a = el("a", null, text || new URL(url).hostname);
      a.href = url; a.target = "_blank"; a.rel = "noopener";
      li.append(a, el("span", "dom", new URL(url).hostname.replace(/^www\./, "")));
      ul.append(li);
    }
    links.hidden = !ul.children.length;

    p.hidden = false;
    p.scrollTop = 0;
  }

  /* ---------- list view ---------- */

  function renderList() {
    const rows = items
      .filter((it) => it.on && layout.pos.has(it))
      .sort((a, b) => groups.indexOf(byKey[a.g]) - groups.indexOf(byKey[b.g]) || a.rank - b.rank);
    const body = $("#listBody");
    body.textContent = "";
    const cap = 400;
    for (const it of rows.slice(0, cap)) {
      const tr = el("tr");
      tr.tabIndex = 0;
      tr.append(
        el("td", null, it.h || truncate(it.b, 90)),
        (() => { const td = el("td"); const k = el("span", "key"); k.style.background = colors[it.g]; k.style.marginRight = "6px"; td.append(k, byKey[it.g].name); return td; })(),
        el("td", null, it.g === OUT ? "—" : `${pct(it.fit)} · ${TIER_LABEL[it.conf]}`),
        el("td", null, it.d),
      );
      const go = () => select(it, { zoomTo: true });
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      body.append(tr);
    }
    if (rows.length > cap) {
      const tr = el("tr", "more");
      const td = el("td", null, `${fmt(rows.length - cap)} more. Narrow the filters to see them.`);
      td.colSpan = 4;
      tr.append(td);
      body.append(tr);
    }
    $("#listCount").textContent = `${fmt(rows.length)} items, best fit first`;
  }

  /* ---------- chrome ---------- */

  function truncate(s, n) {
    return s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  }

  const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
  function formatDate(d) {
    return d ? dateFmt.format(new Date(d + "T12:00:00")) : "";
  }

  function hideHint() {
    $("#hint").classList.add("gone");
  }

  function updateCounts() {
    const scope = items.filter((it) => it.g !== OUT || filters.out);
    const on = scope.filter((it) => it.on).length;
    $("#count").textContent = isFiltered() ? `${fmt(on)} of ${fmt(scope.length)}` : "";
    for (const g of groups) {
      const ct = document.querySelector(`.legend [data-key="${g.key}"] .ct`);
      if (!ct) continue;
      const n = g.items.filter((it) => it.on).length;
      ct.textContent = "";
      if (isFiltered()) { ct.append(el("b", null, fmt(n)), ` / ${fmt(g.items.length)}`); }
      else ct.textContent = fmt(g.items.length);
    }
  }

  function buildLegend() {
    const nav = $("#legend");
    nav.textContent = "";
    for (const g of groups) {
      if (g.key === OUT && !filters.out) continue;
      const b = el("button");
      b.dataset.key = g.key;
      b.title = g.question;
      const sw = el("span", "sw");
      sw.style.background = colors[g.key];
      b.append(sw, el("span", "nm", g.name), el("span", "ct"));
      b.addEventListener("click", () => zoomToGroup(g.key));
      nav.append(b);
    }
    const key = el("div", "tier-key");
    key.innerHTML = `<svg viewBox="0 0 34 34" aria-hidden="true">
      <circle cx="17" cy="17" r="15.5" fill="none" stroke="currentColor" stroke-opacity=".5"/>
      <circle cx="17" cy="17" r="10" fill="none" stroke="currentColor" stroke-opacity=".5"/>
      <circle cx="17" cy="17" r="5" fill="none" stroke="currentColor" stroke-opacity=".5"/>
      <circle cx="17" cy="17" r="1.6" fill="currentColor"/></svg>`;
    const lines = el("span", "tk-text");
    lines.append(el("span", null, "Distance from the centre is relevance: centre 100%, edge 0%."));
    const row = el("span", "tk-row");
    for (const [cls, label] of [["solid", "Core"], ["light", "Arguable"], ["hollow", "Stretch"]]) {
      row.append(el("i", "tk-dot " + cls), label);
    }
    lines.append(row);
    key.append(lines);
    nav.append(key);
    updateCounts();
  }

  function buildChips() {
    const years = [...new Set(items.map((it) => it.yr))].sort();
    const yc = $("#years");
    for (const y of years) {
      const b = el("button", "chip", String(y));
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        filters.years.has(y) ? filters.years.delete(y) : filters.years.add(y);
        b.setAttribute("aria-pressed", String(filters.years.has(y)));
        refilter();
      });
      yc.append(b);
    }
    const tc = $("#tiers");
    for (const t of TIERS) {
      const b = el("button", "chip", t.label);
      b.setAttribute("aria-pressed", "true");
      b.addEventListener("click", () => {
        if (filters.tiers.has(t.key)) { if (filters.tiers.size > 1) filters.tiers.delete(t.key); }
        else filters.tiers.add(t.key);
        for (const [i, c] of [...tc.children].entries()) c.setAttribute("aria-pressed", String(filters.tiers.has(TIERS[i].key)));
        refilter();
      });
      tc.append(b);
    }
  }

  function wire() {
    const sel = d3.select(canvas);
    sel.call(zoom).on("dblclick.zoom", null);

    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons) return;
      const it = pick(e);
      if (it !== hover) { hover = it; schedule(); }
      canvas.classList.toggle("over-dot", !!it);
      it ? showTooltip(it, e) : hideTooltip();
    });
    canvas.addEventListener("pointerleave", () => { hover = null; hideTooltip(); schedule(); });
    canvas.addEventListener("click", (e) => {
      const it = pick(e);
      select(it || null);
    });
    canvas.addEventListener("dblclick", (e) => {
      const [wx, wy] = transform.invert(d3.pointer(e, canvas));
      const c = layout.circles.find((c) => Math.hypot(c.x - wx, c.y - wy) < c.r);
      c ? zoomToGroup(c.g.key) : resetView();
    });

    let qTimer;
    $("#q").addEventListener("input", (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { filters.q = e.target.value.trim().toLowerCase(); refilter(); }, 120);
    });
    $("#chg").addEventListener("change", (e) => { filters.change = e.target.checked; refilter(); });
    $("#out").addEventListener("change", (e) => {
      filters.out = e.target.checked;
      if (!filters.out && selected && selected.g === OUT) select(null);
      applyLayout(computeLayout(), true);
      buildLegend();
      updateCounts();
      if (!$("#list").hidden) renderList();
      resetView();
    });

    $("#panelClose").addEventListener("click", () => select(null));
    $("#resetBtn").addEventListener("click", () => resetView());
    $("#fullBtn").addEventListener("click", () => setImmersive(true));
    $("#exitFull").addEventListener("click", () => setImmersive(false));
    // the browser swallows Esc while in native full screen, so follow its state instead
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && document.body.classList.contains("immersive")) setImmersive(false);
    });
    let idle;
    document.addEventListener("pointermove", () => {
      document.body.classList.add("pointer-active");
      clearTimeout(idle);
      idle = setTimeout(() => document.body.classList.remove("pointer-active"), 1800);
    });
    $("#helpBtn").addEventListener("click", () => $("#help").showModal());
    $("#listBtn").addEventListener("click", () => {
      const l = $("#list");
      l.hidden = !l.hidden;
      $("#listBtn").setAttribute("aria-pressed", String(!l.hidden));
      if (!l.hidden) renderList();
    });
    $("#listClose").addEventListener("click", () => { $("#list").hidden = true; $("#listBtn").setAttribute("aria-pressed", "false"); });

    $("#themeBtn").addEventListener("click", () => {
      const next = ink.dark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("topic-map-theme", next); } catch (e) {}
      retheme();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);

    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); $("#q").focus(); }
      else if (e.key === "Escape") {
        if (document.body.classList.contains("immersive")) setImmersive(false);
        else if (document.activeElement === $("#q")) $("#q").blur();
        else if (!$("#panel").hidden) select(null);
        else if (!$("#list").hidden) $("#listClose").click();
      }
    });
    window.addEventListener("resize", () => { resize(); applyLayout(computeLayout(), false); resetView(false); });
    window.addEventListener("hashchange", fromHash);
  }

  // Full screen hides every control and leaves the map. Native full screen where the
  // browser allows it; where it doesn't (iOS Safari) the chrome still hides.
  function setImmersive(on) {
    if (document.body.classList.contains("immersive") === on) return;
    document.body.classList.toggle("immersive", on);
    hideTooltip();
    if (on) {
      if (!$("#list").hidden) $("#listClose").click();
      const req = document.documentElement.requestFullscreen;
      if (req) document.documentElement.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    // let the viewport settle before refitting
    setTimeout(() => { resize(); resetView(); }, 120);
  }

  function retheme() {
    readColors();
    buildLegend();
    if (selected) renderPanel(selected);
    schedule();
  }

  function fromHash() {
    const m = location.hash.match(/item=(\d+)/);
    const it = m && byId.get(Number(m[1]));
    if (!it) return;
    if (it.g === OUT && !filters.out) $("#out").click();
    select(it, { zoomTo: true, updateHash: false });
  }

  /* ---------- boot ---------- */

  fetch("data.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status + " " + r.statusText); return r.json(); })
    .then((raw) => {
      prepare(raw);
      readColors();
      resize();
      buildChips();
      for (const it of items) it.on = true;
      applyLayout(computeLayout(), false);
      buildLegend();
      wire();
      const stories = items.filter((it) => it.g !== OUT).length;
      const years = d3.extent(items, (it) => it.yr);
      $("#subtitle").textContent = `UK Democracy Bulletin · ${fmt(stories)} stories in ${groups.length - 1} topic groups · ${years[0]}–${years[1]}`;
      $("#helpVersion").textContent = `Taxonomy version ${raw.version}. ${fmt(items.length)} items in total.`;
      resetView(false);
      if (location.hash) setTimeout(fromHash, 50);
    })
    .catch((err) => {
      $("#subtitle").textContent = "Couldn't load data.json (" + err.message + "). Serve this folder over HTTP: make serve";
    });
})();
