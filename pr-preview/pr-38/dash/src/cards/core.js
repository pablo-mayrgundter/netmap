// The core cards. Each is an ordinary card definition, registered through the
// same defineCard() a plugin uses: the plugin API is the one the core runs on.

import { DASH, delta, el, fmt, fmtPct, fmtSeconds, pctText, plural, tileValue } from "../format.js";
import {
  MINUTES_PER_DAY, REALTIME_MINUTES, bucketFits, fmtDH, isRealtimeRange, pointLabel, rangeLabel, relativeDH,
} from "../time.js";
import { columnChart, dataTable, hbarPairRow, hbarRow, mainChart } from "../ui/charts.js";

const BUCKET_NOUN = { hour: "hour", day: "day", week: "week" };

function setDelta(node, current, previous, rangeText) {
  const d = delta(current, previous);
  node.hidden = !d;
  if (!d) return;
  node.className = `delta ${d.cls}`;
  node.textContent = d.text;
  node.title = d.cls === "na" ? "nothing in the previous period to compare against"
    : `${fmt(current)} vs ${fmt(previous)} in the previous ${rangeText}`;
}

function valueRow(cls = "value") {
  const v = el("div", cls), num = el("span", "num", "–"), d = el("span", "delta");
  d.hidden = true;
  v.append(num, d);
  return { v, num, d };
}

export function registerCoreCards(dash) {
  const cfg = dash.config;
  const sec = cfg.chart.secondary;

  // ---- tiles ---------------------------------------------------------------------
  dash.defineCard({
    id: "users", title: "Users", kind: "tile", span: 4, order: 100, followsSegment: true,
    load: ctx => ctx.core.timeseries(),
    render(body, data, ctx) {
      const v = ctx.segments.view(data), t = v.totals, prev = v.previous;
      const rangeText = ctx.range.label.replace("last ", "");
      body.textContent = "";
      const head = valueRow();
      head.num.id = "t-users";
      head.num.textContent = tileValue(t.users);
      setDelta(head.d, t.users, prev?.users, rangeText);
      body.append(head.v, el("div", "note", ctx.range.tileLabel));
      const split = el("div", "split");
      for (const [k, key] of [["New", "newUsers"], ["Returning", "returningUsers"]]) {
        const row = el("div", "split-row"), val = el("span", "v", tileValue(t[key])), d = el("span", "delta");
        val.dataset.k = key;
        setDelta(d, t[key], prev?.[key], rangeText);
        row.append(el("span", "k", k), val, d);
        split.appendChild(row);
      }
      body.appendChild(split);
      const haveSplit = t.newUsers != null || t.returningUsers != null;
      body.appendChild(el("div", "note small", !haveSplit ? "new vs returning is not reported over this window"
        : "each de-duplicated on its own, so the two need not add to the total"
          + (prev ? ` · arrows vs the previous ${rangeText}` : "")));
    },
    snapshot: (data, ctx) => {
      const t = ctx.segments.view(data).totals;
      return `${tileValue(t.users)} users (${ctx.range.tileLabel}); new ${tileValue(t.newUsers)}, returning ${tileValue(t.returningUsers)}`;
    },
  });

  dash.defineCard({
    id: "sessions", title: "Sessions", kind: "tile", span: 2, order: 110, followsSegment: true,
    load: ctx => ctx.core.timeseries(),
    render(body, data, ctx) {
      const t = ctx.segments.view(data).totals;
      body.textContent = "";
      const v = el("div", "value", tileValue(t.sessions)); v.id = "t-sessions";
      body.append(v, el("div", "note", t.sessions != null ? `${fmt(t.views)} page views · ${ctx.range.tileLabel}`
        : ctx.range.isRealtime ? `${tileValue(t.views)} page views · sessions are not reported in realtime`
        : `${tileValue(t.views)} page views · sessions unavailable`));
    },
    snapshot: (data, ctx) => { const t = ctx.segments.view(data).totals; return `${tileValue(t.sessions)} sessions, ${tileValue(t.views)} page views`; },
  });

  if (sec) dash.defineCard({
    id: "secondary", title: sec.label, kind: "tile", span: 2, order: 115, followsSegment: true,
    load: ctx => ctx.core.timeseries(),
    render(body, data, ctx) {
      const t = ctx.segments.view(data).totals;
      body.textContent = "";
      body.append(el("div", "value", tileValue(t.secondary)),
        el("div", "note", t.secondaryClipped && sec.since ? `since ${sec.since}` : ctx.range.tileLabel));
    },
    snapshot: (data, ctx) => `${tileValue(ctx.segments.view(data).totals.secondary)} ${sec.label.toLowerCase()}`,
  });

  cfg.tiles.forEach((tile, i) => dash.defineCard({
    id: `tile:${tile.event}`, title: tile.label, kind: "tile", span: 2, order: 120 + i, followsSegment: true,
    load: ctx => ctx.core.tiles(),
    render(body, data, ctx) {
      const t = ctx.segments.view(data).tiles[i];
      body.textContent = "";
      body.append(el("div", "value", tileValue(t.value)));
      const unit = tile.metric === "eventCount" ? "events" : "people";
      const note = t.error ? `unavailable: ${t.error}` : `${unit} · ${ctx.range.daySpan}`;
      body.append(el("div", "note", note));
      const last = ctx.core.latest ? relativeDH(t.last, ctx.core.latest) : null;
      body.append(el("div", "note small", t.last ? `last: ${fmtDH(t.last)}${last ? ` (${last})` : ""}`
        : t.lastError ? "" : "none in the lookback"));
    },
    snapshot: (data, ctx) => { const t = ctx.segments.view(data).tiles[i]; return `${tile.label}: ${tileValue(t.value)} (last ${t.last ? fmtDH(t.last) : "none"})`; },
  }));

  // ---- the main chart ------------------------------------------------------------------
  dash.defineCard({
    id: "chart", title: "Active users per hour", span: 8, order: 200, followsSegment: true,
    load: ctx => ctx.core.timeseries(),
    render(body, data, ctx) {
      const v = ctx.segments.view(data);
      const byMinute = data.source === "realtime";
      // The bucket toggle sits in the card's head: it changes only this card.
      const tools = ctx.card.tools;
      tools.textContent = "";
      let bucket = ctx.state.bucket;
      if (!byMinute) {
        const group = el("div", "bucket");
        group.setAttribute("role", "group"); group.setAttribute("aria-label", "Sum over"); group.id = "bucketToggle";
        group.appendChild(el("span", "label", "Sum over"));
        if (bucket !== "hour" && !bucketFits(bucket, ctx.range.minutes)) bucket = "hour";
        for (const b of ["hour", "day", "week"]) {
          const btn = el("button", "", b);
          btn.type = "button"; btn.dataset.bucket = b;
          const fits = b === "hour" || bucketFits(b, ctx.range.minutes);
          btn.disabled = !fits;
          btn.title = fits ? "" : `The ${ctx.range.label} is under two ${b}s long`;
          btn.setAttribute("aria-pressed", String(b === bucket));
          btn.addEventListener("click", () => { if (!btn.disabled && b !== ctx.state.bucket) ctx.dashboard.setState({ bucket: b }); });
          group.appendChild(btn);
        }
        tools.appendChild(group);
      }
      ctx.card.setTitle(byMinute ? "Active users per minute" : `Active users per ${BUCKET_NOUN[bucket]}`);
      body.textContent = "";
      const secText = sec ? ` ${sec.label} use the right axis, because they usually run far below the user count`
        + (sec.since ? `, and begin ${sec.since}: earlier hours are unknown, not zero.` : ".") : "";
      body.appendChild(el("p", "sub", byMinute
        ? `Straight from GA4's realtime report, which reaches back ${REALTIME_MINUTES} minutes and answers a smaller `
          + "schema than the rest of this page: no expected baseline (spike scoring compares an hour against the same "
          + "hour over the prior 14 days) and no sessions. Minutes are counted back from the request, not from the "
          + `property's clock.${secText}`
        : bucket === "hour"
          ? `${cfg.timezoneNote} Shaded regions are detected spikes (robust z ≥ ${cfg.spikes.z} vs the same hour over `
            + `the prior ${cfg.spikes.lookbackDays} days).${secText}`
          : `${bucket === "week" ? "Weeks (starting Monday)" : "Days"} in the property's timezone, summed from the hourly `
            + "report. Active users are hourly distinct counts added up, so somebody who returns later in the "
            + `${bucket} counts once per hour they were here: this is traffic volume, not distinct people per ${bucket}. `
            + `Spike shading is hourly and is left to the hour view.${secText}`));
      const hasBaseline = v.points.some(p => p.baseline != null);
      const legend = el("div", "legend");
      const key = (cls, color, text, id) => {
        const k = el("span", "key"); if (id) k.id = id;
        const sw = el("span", cls); sw.style[cls === "swatch-dot" ? "background" : "borderColor"] = color;
        k.append(sw, document.createTextNode(text));
        legend.appendChild(k);
        return k;
      };
      key("swatch-line", "var(--series-1)", "Active users");
      key("swatch-line", "var(--baseline)", "Expected baseline", "legendBaseline").hidden = !hasBaseline;
      if (sec) key("swatch-line", "var(--series-2)", `${sec.label} (right axis)`, "legendSecondary");
      key("swatch-dot", "var(--critical)", "Spike peak", "legendSpike").hidden = !hasBaseline || bucket !== "hour";
      body.appendChild(legend);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = "mainSvg"; svg.setAttribute("width", "100%"); svg.setAttribute("height", "260");
      body.appendChild(svg);
      const pts = mainChart(svg, v.points, { bucket, episodes: v.episodes, secondaryLabel: sec?.label.toLowerCase(),
        withinDay: ctx.range.minutes <= MINUTES_PER_DAY, tip: ctx.card.tip, card: ctx.card.el }) || [];
      const hasZ = hasBaseline && bucket === "hour";
      const cols = [[byMinute ? "Minute" : bucket === "hour" ? "Hour" : bucket === "day" ? "Day" : "Week", ""],
        ["Active users", "num"], ...(hasBaseline ? [["Expected", "num"]] : []), ...(hasZ ? [["z", "num"]] : []),
        ...(sec ? [[sec.label, "num"]] : [])];
      const rowsOut = [...pts].reverse().map(p => [pointLabel(p), fmt(p.value),
        ...(hasBaseline ? [fmt(p.baseline)] : []), ...(hasZ ? [p.z.toFixed(1)] : []),
        ...(sec ? [p.secondary == null ? DASH : fmt(p.secondary)] : [])]);
      const det = el("details", "tableview");
      det.appendChild(el("summary", "", "Data table"));
      const scroll = el("div", "scroll");
      const table = dataTable(cols, rowsOut); table.id = "mainTable";
      scroll.appendChild(table); det.appendChild(scroll);
      body.appendChild(det);
      if (v.gaps?.length) ctx.ui.notice(`Not available over the ${ctx.range.label}: `
        + v.gaps.map(g => `${g.field} (${g.reason})`).join("; "));
      else if (cfg.traffic && data.segmentsError && data.source !== "realtime")
        ctx.ui.notice(`Traffic filter off: GA did not answer the comparisons (${data.segmentsError}).`);
      else ctx.ui.notice("");
    },
    snapshot(data, ctx) {
      const v = ctx.segments.view(data);
      const lines = v.points.map(p => `${pointLabel(p)}\t${fmt(p.value)}`
        + (p.baseline != null ? `\texpected ${fmt(p.baseline)}\tz ${p.z}` : "")
        + (sec ? `\t${sec.label.toLowerCase()} ${p.secondary == null ? "unknown" : p.secondary}` : ""));
      return lines.join("\n");
    },
  });

  // ---- realtime ---------------------------------------------------------------------
  dash.defineCard({
    id: "realtime", title: `Realtime — last ${REALTIME_MINUTES} minutes`, span: 4, order: 210, refresh: "realtime",
    load: ctx => ctx.core.realtime(),
    render(body, data, ctx) {
      const seg = data.segments && ctx.state.segment !== "all" ? data.segments[ctx.state.segment] : null;
      const head = seg || data;
      if (ctx.segments.enabled) {
        ctx.card.setSubtitle(seg ? `Traffic filter: ${ctx.segments.label(ctx.state.segment)}${data.partial ? " (partial rule)" : ""}`
          : `Traffic filter: ${ctx.segments.label("all")}`);
        if (!seg && ctx.state.segment !== "all") ctx.card.el.querySelector(".seg-sub").title =
          `Not filtered: ${data.segmentsError || "realtime has no form of this rule"}`;
      }
      body.textContent = "";
      const sub = el("p", "sub", `Active users per minute · ${fmt(head.active30)} in the last ${REALTIME_MINUTES} min, `
        + `${fmt(head.active5)} in the last 5 min` + (seg ? " (bars are all traffic)" : ""));
      sub.id = "rtSub";
      body.appendChild(sub);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = "rtSvg"; svg.setAttribute("width", "100%"); svg.setAttribute("height", "110");
      body.appendChild(svg);
      columnChart(svg, data.minutes, { tip: ctx.card.tip, card: ctx.card.el });
      for (const t of cfg.realtime.tops) {
        const rows = data.tops[t.key];
        if (!rows || rows.error || !rows.length) continue;
        body.appendChild(el("h3", "", t.title));
        const maxV = Math.max(...rows.map(r => r.users), 1);
        for (const r of rows.slice(0, 5)) body.appendChild(hbarRow(r.name, r.users, maxV));
      }
    },
    snapshot: data => `${data.active30} active in the last 30 min, ${data.active5} in the last 5 min\n`
      + Object.entries(data.tops).filter(([, r]) => Array.isArray(r))
        .map(([k, r]) => `${k}: ${r.slice(0, 5).map(x => `${x.name} ${x.users}`).join(", ")}`).join("\n"),
  });

  // ---- breakdowns ---------------------------------------------------------------------
  cfg.breakdowns.forEach((b, i) => dash.defineCard({
    id: `breakdown:${b.key}`, title: b.title, span: 4, order: 300 + i, followsSegment: true,
    load: ctx => ctx.core.breakdowns(),
    render(body, data, ctx) {
      const item = ctx.segments.view(data).items[b.key];
      body.textContent = "";
      // activeUsers has no honest hourly form, so these are whole days, and say so
      const sub = el("p", "sub", `${ctx.range.daySpan}${ctx.range.minutes < MINUTES_PER_DAY ? " (whole days: user counts have no hourly form)" : ""}`);
      if (b.pairEvent) {
        sub.append(el("span", "swatch s2"), document.createTextNode(b.pairLabel.toLowerCase()),
                   el("span", "swatch s1"), document.createTextNode("users"));
      }
      body.appendChild(sub);
      if (!item || item.error) { body.appendChild(el("div", "empty", `unavailable: ${item?.error || "no data"}`)); return; }
      if (!item.rows.length) { body.appendChild(el("div", "empty", "no data in this range")); return; }
      const maxV = Math.max(1, ...item.rows.map(r => Math.max(r.users, r.pair || 0)));
      for (const r of item.rows) body.appendChild(b.pairEvent && r.pair != null
        ? hbarPairRow(r.name, r.pair, r.users, maxV, { aNoun: "", bNoun: "" }) : hbarRow(r.name, r.users, maxV));
      if (item.pairError) body.appendChild(el("p", "sub", `${b.pairLabel} unavailable: ${item.pairError}`));
    },
    snapshot: (data, ctx) => (ctx.segments.view(data).items[b.key]?.rows || [])
      .map(r => `${r.name}\t${r.users} users${r.pair != null ? `\t${r.pair} ${b.pairLabel.toLowerCase()}` : ""}`).join("\n"),
  }));

  // ---- conversions --------------------------------------------------------------------
  if (cfg.conversions) dash.defineCard({
    id: "conversions", title: cfg.conversions.title, span: 12, order: 450,
    load: ctx => ctx.core.conversions(),
    render(body, data, ctx) {
      body.textContent = "";
      const c = cfg.conversions;
      const sub = el("p", "sub", `Every ${c.events.join(", ")} in the last ${c.lookbackDays} days, newest first`
        + ` (${data.rows.length} of ${fmt(data.total)}${data.truncated ? "+" : ""})`
        + (data.internal ? `; ${data.internal} ${cfg.internalUsers.label} rows are labelled` : ""));
      body.appendChild(sub);
      if (ctx.segments.enabled) ctx.card.setSubtitle(`Traffic filter: ${ctx.segments.label("all")}`);
      if (!data.rows.length) { body.appendChild(el("div", "empty", "none in the lookback")); return; }
      const cell = r => {
        const what = el("span", "", r.label);
        if (r.count > 1) what.append(` \u00d7${r.count}`);
        if (r.internal) what.appendChild(el("span", "tag", r.internal));
        if (r.traffic === "nonstandard" || r.traffic === "both")
          what.appendChild(el("span", "tag", ctx.segments.label("nonstandard").toLowerCase()));
        return what;
      };
      const table = dataTable([["When", ""], ["Event", ""], ["First source", ""], ["Campaign", ""], ["Country", ""]],
        data.rows.map(r => [`${fmtDH(r.dateHour)}${ctx.core.latest ? ` (${relativeDH(r.dateHour, ctx.core.latest)})` : ""}`,
          cell(r), r.source, r.campaign, r.country]));
      table.id = "conversionsTable";
      const wrap = el("div", "scroll conv-scroll");
      wrap.appendChild(table);
      body.appendChild(wrap);
    },
    snapshot: data => data.rows.slice(0, 20).map(r => `${r.dateHour}\t${r.event}\t${r.source}\t${r.country}${r.internal ? "\t(internal)" : ""}`).join("\n"),
  });

  // ---- funnel ----------------------------------------------------------------------------
  if (cfg.funnel) dash.defineCard({
    id: "funnel", title: cfg.funnel.title, span: 12, order: 400, followsSegment: true,
    load: ctx => ctx.core.funnel(),
    render(body, data, ctx) {
      const f = ctx.segments.view(data);
      body.textContent = "";
      body.appendChild(el("p", "sub", `People (GA's distinct totalUsers) by the channel they first arrived through, `
        + `${ctx.range.daySpan}. Under each count, the step from the column to its left. Total is GA's own `
        + "de-duplicated count, not the sum of the rows. A step can pass 100%: the steps are not nested."
        + (cfg.internalUsers.dimension && Object.keys(cfg.internalUsers.ids).length
          ? ` ${cfg.internalUsers.label[0].toUpperCase()}${cfg.internalUsers.label.slice(1)} ids are left out of every step after Visitors.` : "")));
      const wrap = el("div", "scroll-x"), table = el("table", "funnel");
      table.id = "funnelTable";
      const thead = el("thead"), hr = el("tr");
      hr.appendChild(el("th", "", "First channel"));
      for (const s of f.stages) {
        const th = el("th");
        th.dataset.stage = s.key;
        th.append(el("span", "long", s.label), el("span", "short", s.short || s.label));
        if (s.note) { const n = el("span", "stage-note", s.note); th.appendChild(n); }
        if (s.error) th.title = s.error;
        hr.appendChild(th);
      }
      thead.appendChild(hr); table.appendChild(thead);
      const tbody = el("tbody");
      for (const r of f.rows) {
        const tr = el("tr", r.channel === "Total" ? "total" : "");
        tr.appendChild(el("td", "", r.channel));
        r.cells.forEach((c, i) => {
          const td = el("td");
          td.appendChild(document.createTextNode(c.value == null ? DASH : fmt(c.value)));
          if (i && c.rate != null) td.appendChild(el("span", "rate", pctText(c.rate)));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody); wrap.appendChild(table); body.appendChild(wrap);
      if (f.gaps?.length) body.appendChild(ctx.ui.gapList(f.gaps.map(g => ({ field: g.part, reason: g.reason }))));
    },
    snapshot: (data, ctx) => {
      const f = ctx.segments.view(data);
      return [["channel", ...f.stages.map(s => s.label)].join("\t"),
        ...f.rows.map(r => [r.channel, ...r.cells.map(c => (c.value == null ? "-" : c.value))].join("\t"))].join("\n");
    },
  });

  // ---- spikes and the drill-down ------------------------------------------------------------
  dash.defineCard({
    id: "spikes", title: "Detected spikes", span: 12, order: 500, followsSegment: true,
    load: ctx => ctx.core.timeseries(),
    render(body, data, ctx) {
      const v = ctx.segments.view(data);
      body.textContent = "";
      if (data.source === "realtime") {
        body.appendChild(el("div", "empty", `Spike detection needs ${cfg.spikes.lookbackDays} days of the same hour to `
          + "compare against, so it does not run over the realtime window. Pick 24 h or wider."));
        return;
      }
      body.appendChild(el("p", "sub", "Click an episode to see what drove it: its hours compared with the same hours one week earlier."));
      if (!v.episodes.length) { body.appendChild(el("div", "empty", "No spikes detected in this range.")); return; }
      const table = dataTable([["Start", ""], ["Duration", ""], ["Peak users/h", "num"], ["Expected", "num"],
        ["Peak z", "num"], ["Extra users (summed hourly)", "num"]],
        [...v.episodes].reverse().map(e => [fmtDH(e.start), `${e.hours.length} h`, fmt(e.peak), fmt(e.baseline),
          e.peak_z.toFixed(1), `+${fmt(e.extra)}`]));
      table.id = "spikesTable";
      const drill = el("div", "drill"); drill.hidden = true; drill.id = "drill";
      [...table.tBodies[0].rows].forEach((row, i) => {
        const e = [...v.episodes].reverse()[i];
        row.className = "spike-row"; row.tabIndex = 0; row.setAttribute("role", "button");
        const open = () => selectSpike(e, row, drill, ctx);
        row.addEventListener("click", open);
        row.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
      });
      const wrap = el("div", "scroll-x");
      wrap.appendChild(table);
      body.append(wrap, drill);
      if (selected && v.episodes.some(e => e.start === selected.start)) {
        const idx = [...v.episodes].reverse().findIndex(e => e.start === selected.start);
        selectSpike(selected, table.tBodies[0].rows[idx], drill, ctx);
      }
    },
    snapshot: (data, ctx) => ctx.segments.view(data).episodes
      .map(e => `${e.start}..${e.end}\tpeak ${e.peak} (expected ${e.baseline}, z ${e.peak_z})\t+${e.extra}`).join("\n") || "none",
  });
  let selected = null;
  async function selectSpike(e, row, drill, ctx) {
    selected = e;
    for (const r of row.parentElement.rows) r.removeAttribute("aria-selected");
    row.setAttribute("aria-selected", "true");
    drill.hidden = false;
    drill.textContent = "";
    const headline = el("div", "headline", `Loading what drove ${fmtDH(e.start)} → ${fmtDH(e.end)}…`);
    drill.appendChild(headline);
    try {
      const d = await ctx.core.spike(e.start, e.end);
      const seg = d.segments ? ctx.state.segment : "all";
      const view = d.segments ? d.segments[seg] : d;
      headline.textContent = `${fmtDH(e.start)} → ${fmtDH(e.end)} vs the same hours one week earlier: top movers`
        + (seg === "all" ? "" : ` · ${ctx.segments.label(seg).toLowerCase()} traffic only`);
      if (d.segments) {
        const sign = n => (n >= 0 ? "+" : "−") + fmt(Math.abs(n));
        drill.appendChild(el("p", "sub", `Extra users vs a week earlier: ${ctx.segments.label("standard").toLowerCase()} `
          + `${sign(d.segments.standard.extra)} · ${ctx.segments.label("nonstandard").toLowerCase()} `
          + `${sign(d.segments.nonstandard.extra)} (each its own count, summed over the episode's hours)`));
      }
      for (const b of cfg.breakdowns) {
        const movers = (view.movers[b.key] || []).filter(m => m.delta > 0).slice(0, 5);
        drill.appendChild(el("h3", "", b.title.replace(/^Users by /, "").replace(/^\w/, c => c.toUpperCase())));
        if (!movers.length) { drill.appendChild(el("div", "empty", "no increase")); continue; }
        const list = el("div", "mini-list"), maxD = Math.max(...movers.map(m => m.delta));
        for (const m of movers) list.appendChild(hbarRow(m.name, m.delta, maxD, `+${fmt(m.delta)} (${fmt(m.baseline)}→${fmt(m.spike)})`));
        drill.appendChild(list);
      }
    } catch (err) {
      headline.textContent = `Could not load the drill-down: ${err.message}`;
    }
  }

  // ---- the non-standard traffic card ------------------------------------------------------------
  if (cfg.traffic) dash.defineCard({
    id: "traffic", title: `${cfg.traffic.labels.nonstandard} traffic`, span: 12, order: 600,
    async load(ctx) {
      const [profile, ts, fn] = await Promise.all([ctx.core.trafficProfile(),
        ctx.core.timeseries().catch(() => null), ctx.core.funnel().catch(() => null)]);
      return { profile, ts, fn };
    },
    render(body, data, ctx) {
      const L = cfg.traffic.labels;
      body.textContent = "";
      body.appendChild(el("p", "sub", `The rule: ${cfg.traffic.label} (${cfg.traffic.rev}). It says what the traffic did, `
        + `not who sent it. This card shows the segments side by side, so the traffic filter does not change it; `
        + `${ctx.range.daySpan}.`));
      const ts = data.ts;
      if (ts?.segments) {
        const all = ts.segments.all.totals.users, non = ts.segments.nonstandard.totals.users;
        body.appendChild(el("h3", "", "Size of the segment"));
        body.appendChild(el("p", "", all ? `${fmt(non)} of ${fmt(all)} users (${fmtPct(non / all)}) were ${L.nonstandard.toLowerCase()} over the ${ctx.range.label}.`
          : "No users in this window."));
      }
      const grid = el("div", "tc-grid");
      const eng = data.profile.engagement;
      const engBox = el("div"); engBox.appendChild(el("h3", "", "Engagement"));
      if (eng.error) engBox.appendChild(el("div", "empty", `unavailable: ${eng.error}`));
      else engBox.appendChild(dataTable([["", ""], [L.all, "num"], [L.standard, "num"], [L.nonstandard, "num"]], [
        ["users", ...["all", "standard", "nonstandard"].map(s => fmt(eng[s].users))],
        ["engagement time per user", ...["all", "standard", "nonstandard"].map(s => fmtSeconds(eng[s].secondsPerUser))],
        ["engagement rate", ...["all", "standard", "nonstandard"].map(s => fmtPct(eng[s].engagementRate))],
        ["views per session", ...["all", "standard", "nonstandard"].map(s => (eng[s].viewsPerSession == null ? DASH : eng[s].viewsPerSession.toFixed(1)))],
      ], { cls: "tc-table" }));
      grid.appendChild(engBox);
      // Leakage: people the rule calls non-standard who reached a funnel step. It should read zero.
      const leakBox = el("div"); leakBox.appendChild(el("h3", "", "Leakage"));
      const steps = data.fn?.segments ? data.fn.segments.nonstandard.stages.filter(s => s.key !== "visitors"
        && (!cfg.traffic.leakEvents.length || s.events.some(e => cfg.traffic.leakEvents.includes(e)))) : null;
      if (!steps) leakBox.appendChild(el("div", "empty", cfg.funnel ? "unavailable: the funnel has no segments" : "no funnel configured"));
      else {
        const leaked = steps.filter(s => s.total > 0);
        leakBox.appendChild(el("p", leaked.length ? "leak-bad" : "leak-ok", leaked.length
          ? `${leaked.map(s => `${plural(s.total, "person", "people")} ${s.label.toLowerCase()}`).join(", ")}: worth a look; the rule may be catching real visitors.`
          : `No ${L.nonstandard.toLowerCase()} visitor reached a funnel step. That is what a sound rule looks like.`));
      }
      grid.appendChild(leakBox);
      body.appendChild(grid);
      body.appendChild(el("h3", "", "Fingerprint"));
      const fp = el("div", "tc-fp");
      for (const [dim, rowsFp] of Object.entries(data.profile.fingerprint)) {
        const box = el("div"); box.appendChild(el("h4", "", dim));
        if (rowsFp.error) box.appendChild(el("div", "empty", `unavailable: ${rowsFp.error}`));
        else if (!rowsFp.length) box.appendChild(el("div", "empty", "none"));
        else box.appendChild(dataTable([["value", ""], ["users", "num"], ["time/user", "num"]],
          rowsFp.map(r => [r.value, fmt(r.users), fmtSeconds(r.secondsPerUser)]), { cls: "tc-table" }));
        fp.appendChild(box);
      }
      body.appendChild(fp);
    },
    snapshot: data => Object.entries(data.profile.fingerprint)
      .map(([d, r]) => `${d}: ${Array.isArray(r) ? r.map(x => `${x.value} ${x.users}`).join(", ") : r.error}`).join("\n"),
  });
}

export const rangeButtonLabel = m => (m < 60 ? `${m} m` : m < MINUTES_PER_DAY ? `${m / 60} h`
  : m === MINUTES_PER_DAY ? "24 h" : `${m / MINUTES_PER_DAY} days`);
export { isRealtimeRange, rangeLabel };
