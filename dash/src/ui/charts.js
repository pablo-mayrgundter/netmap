// Small SVG charts and list rows, shared by the core cards and offered to
// plugins as ctx.ui.

import { css, el, fmt, niceTicks, svgEl } from "../format.js";
import { bucketPoints, fmtDH, pointLabel } from "../time.js";

function placeTip(tip, card, ev, width = 170) {
  const box = card.getBoundingClientRect();
  const tx = ev.clientX - box.left + 14, flip = tx > box.width - width;
  tip.style.left = `${flip ? tx - width : tx}px`;
  tip.style.top = `${ev.clientY - box.top + 10}px`;
  tip.style.display = "block";
}
function tipRow(tip, color, value, note) {
  const row = el("div", "row");
  const k = el("span", "k"); k.style.borderColor = color;
  row.append(k, el("span", "v", value), el("span", "n", note));
  tip.appendChild(row);
}

/**
 * The main series chart: active users with the expected baseline, spike
 * shading, and an optional secondary event series on its own right axis (it
 * usually runs far below the user count, and sharing the left axis would
 * flatten it onto the floor). A null secondary value is unknown, not zero: the
 * line lifts its pen there.
 *
 * opts: {bucket, episodes, secondaryLabel, withinDay, tip, card}
 */
export function mainChart(svg, raw, opts) {
  svg.textContent = "";
  if (!raw.length) return;
  const byMinute = raw[0].minutesAgo != null;
  const bucket = byMinute ? "hour" : opts.bucket;
  const pts = bucketPoints(raw, bucket);
  const episodes = bucket === "hour" ? opts.episodes || [] : [];
  const W = svg.clientWidth || svg.parentElement?.clientWidth || 800, H = +svg.getAttribute("height");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const sec = pts.map(p => p.secondary).filter(v => v != null);
  const hasSec = sec.some(v => v > 0);
  const M = { l: 44, r: hasSec ? 40 : 12, t: 10, b: 22 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const hasBaseline = pts.some(p => p.baseline != null);
  const maxV = Math.max(...pts.map(p => p.value), ...(hasBaseline ? pts.map(p => p.baseline ?? 0) : [0]));
  const ticks = niceTicks(maxV), yMax = ticks[ticks.length - 1];
  const sTicks = hasSec ? niceTicks(Math.max(...sec)) : [0], sMax = sTicks[sTicks.length - 1] || 1;
  const x = i => M.l + (pts.length === 1 ? iw / 2 : i * iw / (pts.length - 1));
  const y = v => M.t + ih - (v / yMax) * ih;
  const ys = v => M.t + ih - (v / sMax) * ih;
  for (const t of ticks) {
    svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: y(t), y2: y(t), stroke: css("--grid"), "stroke-width": 1 }));
    svg.appendChild(svgEl("text", { x: M.l - 6, y: y(t) + 3, "text-anchor": "end" })).textContent = fmt(t);
  }
  if (hasSec) for (const t of sTicks)
    svg.appendChild(svgEl("text", { x: W - M.r + 6, y: ys(t) + 3, "text-anchor": "start", class: "sec-tick",
                                    fill: css("--series-2") })).textContent = fmt(t);
  const everyCol = Math.max(1, Math.ceil(pts.length / 8));
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], hr = p.ts ? +p.ts.slice(8, 10) : 0;
    const tick = byMinute ? p.minutesAgo % 10 === 0
      : bucket !== "hour" || pts.length <= 6 ? i % everyCol === 0
      : opts.withinDay ? hr % 4 === 0
      : hr === 0 && (Math.floor(i / 24) % Math.max(1, Math.round(pts.length / 24 / 6))) === 0;
    if (!tick) continue;
    svg.appendChild(svgEl("text", { x: x(i), y: H - 6, "text-anchor": "middle" })).textContent = byMinute ? pointLabel(p)
      : bucket !== "hour" ? fmtDH(p.ts, false) : opts.withinDay || pts.length <= 6 ? `${String(hr).padStart(2, "0")}:00` : fmtDH(p.ts, false);
  }
  svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: y(0), y2: y(0), stroke: css("--axis"), "stroke-width": 1 }));
  const idx = Object.fromEntries(pts.map((p, i) => [p.ts, i]));
  for (const e of episodes) {
    if (idx[e.start] === undefined && idx[e.end] === undefined) continue;
    const i0 = idx[e.start] ?? 0, i1 = idx[e.end] ?? pts.length - 1;
    const x0 = x(Math.max(0, i0 - 0.5)), x1 = x(Math.min(pts.length - 1, i1 + 0.5));
    svg.appendChild(svgEl("rect", { x: x0, y: M.t, width: Math.max(3, x1 - x0), height: ih,
                                    fill: css("--critical-wash"), class: "spike-shade" }));
  }
  const path = which => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[which] ?? 0).toFixed(1)}`).join("");
  svg.appendChild(svgEl("path", { d: `${path("value")}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z`,
                                  fill: css("--series-1-wash"), stroke: "none" }));
  const line = (d, color, cls) => svg.appendChild(svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round", class: cls }));
  if (hasBaseline) line(path("baseline"), css("--baseline"), "baseline-line");
  if (hasSec) {
    let d = "", pen = false;
    pts.forEach((p, i) => {
      if (p.secondary == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${ys(p.secondary).toFixed(1)}`;
      pen = true;
    });
    line(d, css("--series-2"), "secondary-line");
  }
  line(path("value"), css("--series-1"), "value-line");
  // A one-point path has no segment to stroke: mark short series with dots.
  if (pts.length <= 6) pts.forEach((p, i) => {
    if (hasBaseline && p.baseline != null) svg.appendChild(svgEl("circle", { cx: x(i), cy: y(p.baseline), r: 3.5, class: "pt-marker", fill: css("--baseline") }));
    svg.appendChild(svgEl("circle", { cx: x(i), cy: y(p.value), r: 4, class: "pt-marker", fill: css("--series-1") }));
    if (hasSec && p.secondary != null) svg.appendChild(svgEl("circle", { cx: x(i), cy: ys(p.secondary), r: 4, class: "pt-marker", fill: css("--series-2") }));
  });
  let biggest = null;
  for (const e of episodes) {
    const i = idx[e.peak_ts];
    if (i === undefined) continue;
    svg.appendChild(svgEl("circle", { cx: x(i), cy: y(e.peak), r: 6, fill: css("--surface-1") }));
    svg.appendChild(svgEl("circle", { cx: x(i), cy: y(e.peak), r: 4, fill: css("--critical"), class: "spike-peak" }));
    if (!biggest || e.peak > biggest.peak) biggest = { ...e, i };
  }
  if (biggest) {
    const py = y(biggest.peak);
    const attrs = py < 26 ? { x: Math.min(x(biggest.i) + 10, W - M.r - 60), y: py + 12, "text-anchor": "start" }
      : { x: Math.min(Math.max(x(biggest.i), M.l + 30), W - M.r - 30), y: py - 10, "text-anchor": "middle" };
    svg.appendChild(svgEl("text", { ...attrs, fill: css("--text-secondary"), "font-weight": 600 })).textContent = `${fmt(biggest.peak)} peak`;
  }
  const { tip, card } = opts;
  if (!tip) return pts;
  const hair = svgEl("line", { y1: M.t, y2: M.t + ih, stroke: css("--axis"), "stroke-width": 1, visibility: "hidden" });
  const dot = svgEl("circle", { r: 4, fill: css("--series-1"), stroke: css("--surface-1"), "stroke-width": 2, visibility: "hidden" });
  const hit = svgEl("rect", { x: M.l, y: M.t, width: Math.max(1, iw), height: ih, fill: "transparent" });
  svg.append(hair, dot, hit);
  hit.addEventListener("pointermove", ev => {
    const box = svg.getBoundingClientRect();
    const px = (ev.clientX - box.left) * (W / box.width);
    const i = pts.length === 1 ? 0 : Math.round((px - M.l) / iw * (pts.length - 1));
    if (i < 0 || i >= pts.length) return;
    const p = pts[i];
    for (const [a, v] of [["x1", x(i)], ["x2", x(i)], ["visibility", "visible"]]) hair.setAttribute(a, v);
    for (const [a, v] of [["cx", x(i)], ["cy", y(p.value)], ["visibility", "visible"]]) dot.setAttribute(a, v);
    tip.textContent = "";
    tip.appendChild(el("div", "when", pointLabel(p)));
    tipRow(tip, css("--series-1"), fmt(p.value), "active users");
    if (hasBaseline && p.baseline != null)
      tipRow(tip, css("--baseline"), fmt(p.baseline), bucket === "hour" && p.z != null ? `expected · z ${p.z.toFixed(1)}` : "expected");
    if (hasSec) tipRow(tip, css("--series-2"), p.secondary == null ? "—" : fmt(p.secondary),
                       p.secondary == null ? "before this event existed" : opts.secondaryLabel);
    placeTip(tip, card, ev);
  });
  hit.addEventListener("pointerleave", () => {
    tip.style.display = "none";
    hair.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden");
  });
  return pts;
}

/** Per-minute columns for the realtime card. */
export function columnChart(svg, series, { tip, card, valueKey = "users", noun = "active users" } = {}) {
  svg.textContent = "";
  const W = svg.clientWidth || svg.parentElement?.clientWidth || 320, H = +svg.getAttribute("height");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const M = { l: 26, r: 4, t: 6, b: 16 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const maxV = Math.max(1, ...series.map(p => p[valueKey]));
  const ticks = niceTicks(maxV, 2), yMax = ticks[ticks.length - 1];
  const slot = iw / Math.max(1, series.length), bw = Math.max(1, Math.min(24, slot - 2));
  const x = i => M.l + i * slot + (slot - bw) / 2;
  const y = v => M.t + ih - (v / yMax) * ih;
  for (const t of ticks) {
    if (t === 0) continue;
    svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: y(t), y2: y(t), stroke: css("--grid") }));
    svg.appendChild(svgEl("text", { x: M.l - 4, y: y(t) + 3, "text-anchor": "end" })).textContent = fmt(t);
  }
  svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: y(0), y2: y(0), stroke: css("--axis") }));
  series.forEach((p, i) => {
    const v = p[valueKey], h = Math.max(v > 0 ? 2 : 0, (v / yMax) * ih);
    if (h > 0) svg.appendChild(svgEl("rect", { x: x(i), y: y(0) - h, width: bw, height: h, rx: 3, fill: css("--series-1"), class: "col" }));
    if (!tip) return;
    const hit = svgEl("rect", { x: M.l + i * slot, y: M.t, width: slot, height: ih, fill: "transparent" });
    hit.addEventListener("pointermove", ev => {
      tip.textContent = "";
      tip.appendChild(el("div", "when", pointLabel(p)));
      const row = el("div", "row");
      row.append(el("span", "v", fmt(v)), el("span", "n", noun));
      tip.appendChild(row);
      placeTip(tip, card, ev, 150);
    });
    hit.addEventListener("pointerleave", () => { tip.style.display = "none"; });
    svg.appendChild(hit);
  });
  for (const [i, label] of [[0, `${series.length} min ago`], [series.length - 1, "now"]])
    svg.appendChild(svgEl("text", { x: x(i) + bw / 2, y: H - 3, "text-anchor": i === 0 ? "start" : "end" })).textContent = label;
}

export function hbarRow(name, value, maxV, valueText = fmt(value)) {
  const row = el("div", "hbar-row");
  const nm = el("span", "name", name); nm.title = name;
  const track = el("div", "hbar-track"), fill = el("div", "hbar-fill");
  fill.style.width = `${maxV > 0 ? Math.max(0, value) / maxV * 100 : 0}%`;
  track.appendChild(fill);
  row.append(nm, track, el("span", "val", valueText));
  return row;
}

/** Two bars per row on ONE scale (a, the event series, above b, users), so lengths compare. */
export function hbarPairRow(name, a, b, maxV, { aNoun = "", bNoun = "users" } = {}) {
  const row = el("div", "hbar-row pair");
  const nm = el("span", "name", name); nm.title = name;
  const track = el("div", "hbar-track");
  for (const [v, cls] of [[a, "p2"], [b, "p1"]]) {
    const f = el("div", `hbar-fill ${cls}`);
    f.style.width = `${maxV > 0 ? v / maxV * 100 : 0}%`;
    track.appendChild(f);
  }
  const val = el("span", "val");
  val.append(el("span", "a", `${fmt(a)} ${aNoun}`.trim()), el("span", "b", `${fmt(b)} ${bNoun}`.trim()));
  row.append(nm, track, val);
  return row;
}

/** A tiny line for a plugin's per-row series. pts: numbers; null lifts the pen. */
export function sparkline(values, { width = 120, height = 24, color = "--series-2" } = {}) {
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "spark" });
  const vals = values.filter(v => v != null);
  if (vals.length < 2) return svg;
  const max = Math.max(1, ...vals);
  let d = "", pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${(i * (width - 2) / (values.length - 1) + 1).toFixed(1)},${(height - 1 - v / max * (height - 2)).toFixed(1)}`;
    pen = true;
  });
  svg.appendChild(svgEl("path", { d, fill: "none", stroke: css(color), "stroke-width": 1.5 }));
  return svg;
}

/** A plain table: cols [[heading, cls]], rows [[cell, ...]]. Cells may be nodes. */
export function dataTable(cols, rows, { cls = "data" } = {}) {
  const table = el("table", cls), thead = el("thead"), tr = el("tr");
  for (const [h, c] of cols) tr.appendChild(el("th", c || "", h));
  thead.appendChild(tr); table.appendChild(thead);
  const tbody = el("tbody");
  for (const r of rows) {
    const row = el("tr");
    r.forEach((cell, i) => {
      const td = el("td", cols[i]?.[1] || "");
      if (cell instanceof Node) td.appendChild(cell); else td.textContent = cell ?? "";
      row.appendChild(td);
    });
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}
