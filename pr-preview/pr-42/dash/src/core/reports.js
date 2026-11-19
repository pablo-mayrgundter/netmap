// The core cards' data, built from GA4 reports through a `ga` client
// (ga/client.js). No DOM here, so Node tests can drive every function against
// the synthetic Data API. See README "Window semantics" for the rules these
// functions keep; the comments here say where each one applies.

import {
  SEGMENTS, aggregateTotal, and, comparedLimit, comparisonTotals, events, gaRows, gaRowsByComparison, gaTotalsRow,
  inList, not, capSegments, isCompared, shortSegments, splitByComparison, withFilter, withSegmentRows,
} from "../ga/rows.js";
import { classifyHosts, realtimeRule, trafficComparisons, trafficFilterExpression } from "../rules.js";
import { findEpisodes, robustScores, spikeMovers } from "../spikes.js";
import {
  MINUTES_PER_DAY, REALTIME_MINUTES, anchoredWindow, dateToDH, hoursIn, isoDay, parseDH, previousWindow,
  rangeStart, shiftDH, toDH,
} from "../time.js";

export const NO_SEGMENTS = "this data source returns no traffic segments";
const dims = names => names.map(name => ({ name }));
const mets = names => names.map(name => ({ name }));
const roundOrNull = v => (v == null ? null : Math.round(v));

export const comparisonsFor = cfg => (cfg.traffic ? trafficComparisons(cfg.traffic.rule) : null);

/** NOT the deployment's own ids, on the dimension that carries them; null when there are none. */
export function internalExclusion(cfg) {
  const ids = Object.keys(cfg.internalUsers?.ids || {});
  const dim = cfg.internalUsers?.dimension;
  return ids.length && dim ? not(inList(dim, ids)) : null;
}
export const internalLabel = (cfg, id) => (id && cfg.internalUsers?.ids?.[id]) || null;

/**
 * Ranked top-N reports under the traffic comparisons, `{key: body}` in and
 * `{key: payload | {error}}` out like ga.parts. Each body's `limit` is the
 * rows wanted per segment. GA's limit counts every segment's rows together,
 * so each asks for limit × comparisons; a segment that still comes back short
 * while GA held more rows (larger segments crowd it out of the shared
 * ranking) is asked for again alone, its comparison's filter folded into the
 * body's, and its rows spliced back in. Every segment is then cut to its
 * limit. With no comparisons, plain parts.
 */
export async function rankedParts(ga, requests, comparisons) {
  if (!comparisons) return ga.parts(requests);
  const per = k => +(requests[k].limit || 10000);
  const out = await ga.parts(Object.fromEntries(Object.entries(requests).map(([k, b]) =>
    [k, { ...b, comparisons, limit: comparedLimit(per(k), comparisons) }])));
  const again = {}, SEP = "\u0001";
  for (const k of Object.keys(requests)) {
    if (!out[k] || out[k].error) continue;
    for (const c of shortSegments(out[k], per(k), comparisons))
      again[`${k}${SEP}${c.name}`] = { ...requests[k], ...withFilter(and(requests[k].dimensionFilter, c.dimensionFilter)) };
  }
  if (Object.keys(again).length) {
    for (const [key, q] of Object.entries(await ga.parts(again))) {
      const [k, name] = key.split(SEP);
      if (!q.error) out[k] = withSegmentRows(out[k], name, q);   // a refused re-ask leaves the segment short, not wrong
    }
  }
  for (const k of Object.keys(requests))
    if (out[k] && !out[k].error && isCompared(out[k])) out[k] = capSegments(out[k], per(k));
  return out;
}

/** One ranked report: `body.limit` rows in every segment (see rankedParts). Throws GA's error. */
export async function rankedReport(ga, body, comparisons) {
  const { only } = await rankedParts(ga, { only: body }, comparisons);
  if (only.error) throw new Error(only.error);
  return only;
}

/** A segmented result's view for one segment, or the result itself when it has none. */
export const segmentView = (data, seg) => (data && data.segments ? data.segments[seg] || data.segments.all : data);
/** Which segment a card's numbers actually reflect. */
export const appliedSegment = (data, seg) => (data && data.segments && data.segments[seg] ? seg : "all");

// ---- timeseries --------------------------------------------------------------

/**
 * Hourly rows from `first` to `latest` with no holes. GA omits an hour nobody
 * visited; the spike scorer indexes "the same hour yesterday" as 24 rows back,
 * so a hole would shift every comparison after it.
 */
function fillHours(byHour, hours, blank) {
  return hours.map(ts => byHour.get(ts) || { ts, ...blank });
}

async function hourlySeries(ga, cfg, days, comparisons) {
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "today" }];
  const metrics = ["activeUsers", "sessions", "screenPageViews"];
  const cmp = comparisons ? { comparisons } : {};
  const sec = cfg.chart.secondary;
  const [p, o] = await Promise.all([
    ga.runReport({ dateRanges, dimensions: dims(["dateHour"]), metrics: mets(metrics), limit: 250000, ...cmp }),
    sec ? ga.runReport({ dateRanges, dimensions: dims(["dateHour"]), metrics: mets(["eventCount"]),
                         dimensionFilter: events([sec.event]), limit: 250000, ...cmp }) : null,
  ]);
  const since = sec?.since ? dateToDH(sec.since) : null;
  const build = (rows, secRows, hours) => {
    const by = new Map(rows.map(r => [r.dateHour, { ts: r.dateHour, users: r.activeUsers, sessions: r.sessions,
                                                     views: r.screenPageViews }]));
    const secBy = new Map((secRows || []).map(r => [r.dateHour, r.eventCount]));
    return fillHours(by, hours, { users: 0, sessions: 0, views: 0 }).map(r => ({
      ...r, secondary: !sec ? null : since && r.ts < since ? null : secBy.get(r.ts) || 0 }));
  };
  const span = rows => {
    const ts = rows.map(r => r.dateHour).sort();
    return ts.length ? hoursIn({ start: ts[0], end: ts[ts.length - 1] }) : [];
  };
  if (!comparisons) {
    const rows = gaRows(p, ["dateHour"], metrics);
    return build(rows, o && gaRows(o, ["dateHour"], ["eventCount"]), span(rows));
  }
  const rows = gaRowsByComparison(p, ["dateHour"], metrics);
  const secRows = o ? gaRowsByComparison(o, ["dateHour"], ["eventCount"]) : {};
  const hours = span(rows.all);           // every segment on `all`'s hours
  return Object.fromEntries(SEGMENTS.map(seg => [seg, build(rows[seg], secRows[seg], hours)]));
}

/**
 * The window's own de-duplicated users and sessions: activeUsers summed over
 * dateHour rows counts a person once per hour they visited. The hours go in as
 * a dateHour inList filter with no dateHour dimension, so GA de-duplicates over
 * exactly the hours the chart shows. New vs returning is its own report and its
 * own failure, de-duplicated within each group, so the two need not add up.
 */
export async function windowTotals(ga, win, comparisons = null) {
  const hours = hoursIn(win);
  const dateRanges = [{ startDate: isoDay(win.start), endDate: isoDay(win.end) }];
  const dimensionFilter = inList("dateHour", hours);
  const cmp = comparisons ? { comparisons, metricAggregations: ["TOTAL"] } : {};
  const p = await ga.runReport({ dateRanges, dimensionFilter, metrics: mets(["activeUsers", "sessions"]),
                                 limit: comparedLimit(1, comparisons), ...cmp });
  let splits;
  try {
    const q = await ga.runReport({ dateRanges, dimensionFilter, dimensions: dims(["newVsReturning"]),
      metrics: mets(["activeUsers"]), limit: comparedLimit(10, comparisons), ...(comparisons ? { comparisons } : {}) });
    const fold = rows => {
      const by = Object.fromEntries(rows.map(r => [String(r.newVsReturning).toLowerCase(), r.activeUsers]));
      return { newUsers: by.new ?? 0, returningUsers: by.returning ?? 0 };
    };
    splits = comparisons
      ? Object.fromEntries(Object.entries(gaRowsByComparison(q, ["newVsReturning"], ["activeUsers"]))
          .map(([seg, rows]) => [seg, fold(rows)]))
      : { all: fold(gaRows(q, ["newVsReturning"], ["activeUsers"])) };
  } catch (e) {
    const failed = { newUsers: null, returningUsers: null, error: e.message };
    splits = Object.fromEntries(SEGMENTS.map(seg => [seg, failed]));
  }
  if (!comparisons) {
    const t = gaTotalsRow(p, ["activeUsers", "sessions"]);
    return { all: { users: t.activeUsers, sessions: t.sessions, ...splits.all } };
  }
  const t = comparisonTotals(p, ["activeUsers", "sessions"]);
  return Object.fromEntries(SEGMENTS.map(seg => [seg, { users: t[seg].activeUsers, sessions: t[seg].sessions,
                                                         ...splits[seg] }]));
}

/**
 * The chart, the spikes and the tiles above them, once per segment. The
 * window is anchored to the latest hour GA returned and cut ONCE, from `all`;
 * each segment is then scored on its own series.
 */
export async function timeseries(ga, cfg, minutes) {
  const days = Math.ceil(minutes / MINUTES_PER_DAY);
  const lookback = Math.min(days + cfg.spikes.lookbackDays, 118);
  const comparisons = comparisonsFor(cfg);
  let bySeg = null, segmentsError = null;
  if (comparisons) {
    try { bySeg = await hourlySeries(ga, cfg, lookback, comparisons); } catch (e) { segmentsError = e.message; }
  }
  const rows = bySeg ? bySeg.all : await hourlySeries(ga, cfg, lookback, null);
  const latest = rows.length ? rows[rows.length - 1].ts : null;
  const win = anchoredWindow(latest, minutes);
  const prevWin = previousWindow(win);
  const totalsFor = async w => (bySeg ? windowTotals(ga, w, comparisons) : windowTotals(ga, w));
  let deduped = null, totalsError = null, previous = null;
  if (win) {
    // A failure nulls the tiles rather than falling back to the sum.
    try { deduped = await totalsFor(win); } catch (e) { totalsError = e.message; }
    // The window before, for the arrows. Non-fatal: it costs the arrows only.
    try { previous = await totalsFor(prevWin); } catch (e) { previous = null; }
  }
  const view = (segRows, seg) => {
    const scored = robustScores(segRows.map(r => ({ ts: r.ts, value: r.users })), cfg.spikes);
    const secBy = new Map(segRows.map(r => [r.ts, r.secondary]));
    const cut = win ? win.start : "";
    const points = scored.filter(p => p.ts >= cut).map(p => ({ ...p, secondary: secBy.get(p.ts) ?? null }));
    const episodes = findEpisodes(scored, cfg.spikes).filter(e => e.end >= cut);
    const inRange = segRows.filter(r => r.ts >= cut);
    const sum = f => Math.round(inRange.reduce((s, r) => s + (f(r) || 0), 0));
    const d = deduped?.[seg], p = previous?.[seg];
    const gaps = [];
    if (totalsError) gaps.push({ field: "users and sessions", reason: totalsError });
    if (d?.error) gaps.push({ field: "new vs returning users", reason: d.error });
    return {
      points, episodes, gaps,
      totals: { users: d ? Math.round(d.users) : null, sessions: d ? Math.round(d.sessions) : null,
                newUsers: d ? roundOrNull(d.newUsers) : null, returningUsers: d ? roundOrNull(d.returningUsers) : null,
                views: sum(r => r.views),                 // a plain count: it really does add up
                secondary: cfg.chart.secondary ? sum(r => r.secondary) : null,
                secondaryClipped: inRange.some(r => r.secondary == null) && !!cfg.chart.secondary },
      previous: p ? { users: Math.round(p.users), sessions: Math.round(p.sessions),
                      newUsers: roundOrNull(p.newUsers), returningUsers: roundOrNull(p.returningUsers) } : null,
    };
  };
  const all = view(rows, "all");
  const segments = bySeg ? Object.fromEntries(SEGMENTS.map(seg => [seg, view(bySeg[seg], seg)])) : null;
  return { ...all, window: win, previousWindow: prevWin, latest, segments, segmentsError, source: "report" };
}

// ---- realtime ------------------------------------------------------------------

/**
 * The 30 m range, from runRealtimeReport, shaped like timeseries() with two
 * honest holes: no baseline (scoring needs 14 days of the same hour) and any
 * total realtime will not answer comes back null, with the refusal in `gaps`.
 */
export async function realtimeRange(ga, cfg) {
  const gaps = [];
  const ask = async (label, body) => {
    try { return gaRows(await ga.runRealtimeReport(body), (body.dimensions || []).map(d => d.name),
                        body.metrics.map(m => m.name)); }
    catch (e) { gaps.push({ field: label, reason: e.message }); return null; }
  };
  const sec = cfg.chart.secondary;
  const secFilter = sec ? events([sec.event]) : null;
  const [minuteRows, totalRows, secRows, secMinutes, views] = await Promise.all([
    ask("active users per minute", { dimensions: dims(["minutesAgo"]), metrics: mets(["activeUsers"]) }),
    ask("active users", { metrics: mets(["activeUsers"]) }),
    sec ? ask(sec.label, { metrics: mets(["eventCount"]), dimensionFilter: secFilter }) : null,
    sec ? ask(`${sec.label} per minute`, { dimensions: dims(["minutesAgo"]), metrics: mets(["eventCount"]),
                                           dimensionFilter: secFilter }) : null,
    ask("page views", { metrics: mets(["screenPageViews"]) }),
  ]);
  const byMin = new Map((minuteRows || []).map(r => [+r.minutesAgo, r.activeUsers]));
  const secByMin = new Map((secMinutes || []).map(r => [+r.minutesAgo, r.eventCount]));
  const points = [];
  if (minuteRows) for (let m = REALTIME_MINUTES - 1; m >= 0; m--)
    points.push({ minutesAgo: m, ts: null, value: byMin.get(m) || 0, baseline: null, z: 0,
                  secondary: !sec || secMinutes === null ? null : secByMin.get(m) || 0 });
  const only = (rows, m) => (rows === null ? null : rows.length ? rows[0][m] : 0);
  return { points, episodes: [], gaps, previous: null, window: null, segments: null,
           segmentsError: "realtime reports have no comparisons", source: "realtime",
           totals: { users: only(totalRows, "activeUsers"), views: only(views, "screenPageViews"),
                     secondary: sec ? only(secRows, "eventCount") : null, newUsers: null, returningUsers: null,
                     sessions: null, secondaryClipped: false } };
}

/**
 * The always-on realtime card. Both headlines are their own query: activeUsers
 * is de-duplicated over whatever minuteRange it is asked for, so neither is
 * the sum of the bars, and five minutes is not a slice of thirty.
 */
export async function realtime(ga, cfg) {
  const users = async (minutes, dimensionFilter) => {
    const p = await ga.runRealtimeReport({ metrics: mets(["activeUsers"]), ...withFilter(dimensionFilter),
      minuteRanges: [{ startMinutesAgo: minutes - 1, endMinutesAgo: 0 }] });
    return Math.round(gaTotalsRow(p, ["activeUsers"]).activeUsers);
  };
  const [minutes, u30, u5] = await Promise.all([
    ga.runRealtimeReport({ dimensions: dims(["minutesAgo"]), metrics: mets(["activeUsers"]) }),
    users(REALTIME_MINUTES), users(5)]);
  const byMin = new Map(gaRows(minutes, ["minutesAgo"], ["activeUsers"]).map(r => [+r.minutesAgo, r.activeUsers]));
  const series = [];
  for (let m = REALTIME_MINUTES - 1; m >= 0; m--) series.push({ minutesAgo: m, users: byMin.get(m) || 0 });
  const tops = await ga.parts(Object.fromEntries(cfg.realtime.tops.map(t => [t.key,
    { dimensions: dims([t.dimension]), metrics: mets(["activeUsers"]), limit: 8,
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }] }])), { method: "runRealtimeReport" });
  const topRows = Object.fromEntries(cfg.realtime.tops.map(t => [t.key, tops[t.key].error ? { error: tops[t.key].error }
    : gaRows(tops[t.key], [t.dimension], ["activeUsers"]).map(r => ({ name: r[t.dimension], users: r.activeUsers }))]));
  // Segments: realtime has no comparisons, so the headlines run again under
  // the part of the rule realtime can express; a host rule has none.
  let segments = null, segmentsError = null, partial = false;
  const rt = cfg.traffic ? realtimeRule(cfg.traffic.rule) : null;
  if (rt) {
    const expr = trafficFilterExpression(rt);
    try {
      const [n30, n5, s30, s5] = await Promise.all([users(REALTIME_MINUTES, expr), users(5, expr),
        users(REALTIME_MINUTES, not(expr)), users(5, not(expr))]);
      segments = { nonstandard: { active30: n30, active5: n5 }, standard: { active30: s30, active5: s5 } };
      partial = rt.partial;
    } catch (e) { segmentsError = e.message; }
  } else if (cfg.traffic) segmentsError = "the traffic rule has no realtime form";
  return { minutes: series, active30: u30, active5: u5, tops: topRows, segments, segmentsError, partial };
}

// ---- breakdowns -------------------------------------------------------------------

/** Rows per breakdown, in every segment. */
export const BREAKDOWN_ROWS = 10;

/**
 * Whole-day breakdowns. activeUsers has no honest hourly form (summing it over
 * hours counts a person once per hour), so these cover whole days, and under
 * the short ranges the same two days the 24 h view does.
 */
export async function breakdowns(ga, cfg, minutes) {
  const m = Math.max(minutes, MINUTES_PER_DAY);
  const dateRanges = [{ startDate: rangeStart(m), endDate: "today" }];
  const comparisons = comparisonsFor(cfg);
  // Each limit is per segment: rankedParts asks GA for room for all of them.
  const reqs = {};
  for (const b of cfg.breakdowns) {
    reqs[b.key] = { dateRanges, dimensions: dims([b.dimension]), metrics: mets(["activeUsers"]), limit: BREAKDOWN_ROWS,
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }] };
    if (b.pairEvent) reqs[`${b.key}:pair`] = { dateRanges, dimensions: dims([b.dimension]), metrics: mets(["eventCount"]),
      dimensionFilter: and(events([b.pairEvent]), internalExclusion(cfg)), limit: 50,
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }] };
  }
  const build = (payloads, compared) => {
    const per = Object.fromEntries((compared ? SEGMENTS : ["all"]).map(s => [s, { items: {} }]));
    for (const b of cfg.breakdowns) {
      const p = payloads[b.key], q = b.pairEvent ? payloads[`${b.key}:pair`] : null;
      const split = compared ? splitByComparison(p) : { all: p };
      const splitQ = q ? (compared ? splitByComparison(q) : { all: q }) : null;
      for (const seg of Object.keys(per)) {
        if (split[seg]?.error) { per[seg].items[b.key] = { error: split[seg].error }; continue; }
        const pair = splitQ && !splitQ[seg]?.error
          ? Object.fromEntries(gaRows(splitQ[seg], [b.dimension], ["eventCount"]).map(r => [r[b.dimension], r.eventCount])) : null;
        const rows = gaRows(split[seg], [b.dimension], ["activeUsers"]).slice(0, BREAKDOWN_ROWS)
          .map(r => ({ name: r[b.dimension], users: r.activeUsers, ...(pair ? { pair: pair[r[b.dimension]] || 0 } : {}) }));
        per[seg].items[b.key] = { rows, pairError: splitQ?.[seg]?.error || null };
      }
    }
    return per;
  };
  if (comparisons) {
    const payloads = await rankedParts(ga, reqs, comparisons);
    const answered = cfg.breakdowns.some(b => payloads[b.key] && !payloads[b.key].error);
    if (answered) {
      try {
        const per = build(payloads, true);
        return { ...per.all, segments: per, segmentsError: null, minutes: m };
      } catch (e) { /* comparisons not honoured: fall through to plain */ }
    }
  }
  const per = build(await ga.parts(reqs), false);
  return { ...per.all, segments: null, segmentsError: comparisons ? NO_SEGMENTS : null, minutes: m };
}

// ---- funnel -----------------------------------------------------------------------

export const channelBucket = (f, name) => f.channelBuckets[String(name || "").trim()] || "Other";

export function funnelRequests(cfg, minutes) {
  const f = cfg.funnel;
  const range = [{ startDate: rangeStart(Math.max(minutes, MINUTES_PER_DAY)), endDate: "today" }];
  const lookback = [{ startDate: `${f.lookbackDays - 1}daysAgo`, endDate: "today" }];
  const ours = internalExclusion(cfg);
  const people = filter => ({ dateRanges: range, dimensions: dims([f.channelDimension]), metrics: mets(["totalUsers"]),
                              metricAggregations: ["TOTAL"], limit: 100, ...withFilter(filter) });
  const reqs = { visitors: people(null) };
  for (const s of f.steps) {
    reqs[`step:${s.key}`] = people(and(events(s.events), s.filter || null, ours));
    if (s.fallback) reqs[`fallback:${s.key}`] = people(and(events(s.fallback.events), s.fallback.filter || null, ours));
  }
  const seenEvents = [...new Set(f.steps.flatMap(s => [...s.events, ...(s.fallback?.events || [])]))];
  reqs.seen = { dateRanges: lookback, dimensions: dims(["eventName"]), metrics: mets(["eventCount"]),
                dimensionFilter: events(seenEvents), limit: 1000 };
  return reqs;
}
const COMPARED_PART = k => k === "visitors" || k.startsWith("step:") || k.startsWith("fallback:");

/**
 * Fold the funnel's reports into the grid. Each cell is one of:
 *   a number  GA reported the step in range (0 where a channel had none)
 *   0         GA has seen these events in the lookback, just not in range
 *   null      GA has never reported them in the lookback: "not seen in GA yet".
 *             GA cannot tell a missing event from an unused one, so the page
 *             does not guess "not instrumented".
 * A failed report is null too, with the reason. Totals are GA's own
 * de-duplicated TOTAL, never the sum of the channel rows.
 */
export function summarizeFunnel(cfg, payloads) {
  const f = cfg.funnel;
  const gaps = [];
  const seenOk = payloads.seen && !payloads.seen.error;
  const seen = {};
  if (seenOk) for (const r of gaRows(payloads.seen, ["eventName"], ["eventCount"])) seen[r.eventName] = r.eventCount;
  else if (payloads.seen) gaps.push({ part: "seen", reason: payloads.seen.error });
  const everSeen = evs => !seenOk || evs.some(e => (seen[e] || 0) > 0);
  const byChannel = p => {
    const out = Object.fromEntries(f.channels.map(c => [c, 0]));
    for (const r of gaRows(p, [f.channelDimension], ["totalUsers"])) out[channelBucket(f, r[f.channelDimension])] += Math.round(r.totalUsers);
    return out;
  };
  const stageOf = (key, label, short, p, evs) => {
    const out = { key, label, short, events: evs, byChannel: null, total: null, inRange: false,
                  instrumented: true, note: "", error: null };
    if (!p || p.error) { out.error = p?.error || "not asked"; out.note = "unavailable"; return out; }
    out.byChannel = byChannel(p);
    out.total = roundOrNull(aggregateTotal(p));
    out.inRange = (p.rows || []).length > 0;
    return out;
  };
  const stages = [stageOf("visitors", "Visitors", "Visits", payloads.visitors, null)];
  for (const s of f.steps) {
    let p = payloads[`step:${s.key}`], usedFallback = false;
    if ((!p || p.error) && s.fallback && payloads[`fallback:${s.key}`] && !payloads[`fallback:${s.key}`].error) {
      p = payloads[`fallback:${s.key}`]; usedFallback = true;
    }
    const st = stageOf(s.key, s.label, s.short, p, s.events);
    if (usedFallback) st.note = s.fallback.note || "fallback query (the main one failed)";
    if (!st.error) {
      if (!st.inRange && !everSeen(usedFallback ? s.fallback.events : s.events)) {
        st.instrumented = false; st.byChannel = null; st.total = null; st.note = "not seen in GA yet";
      } else if (!st.inRange && !st.note) st.note = "none in this range";
    }
    if (s.note && !st.note) st.note = s.note;
    stages.push(st);
  }
  for (const st of stages) if (st.error) gaps.push({ part: st.key, reason: st.error });
  const rate = (cur, prev) => (cur == null || prev == null || prev <= 0 ? null : cur / prev);
  const rows = [...f.channels, "Total"].map(ch => {
    const cells = stages.map(s => (ch === "Total" ? s.total : s.byChannel ? s.byChannel[ch] : null));
    return { channel: ch, cells: cells.map((v, i) => ({ value: v, rate: i ? rate(v, cells[i - 1]) : null })) };
  });
  return { stages, rows, channels: f.channels, gaps, seen: seenOk ? seen : null };
}

export async function funnel(ga, cfg, minutes) {
  const reqs = funnelRequests(cfg, minutes);
  const comparisons = comparisonsFor(cfg);
  if (comparisons) {
    const withCmp = Object.fromEntries(Object.entries(reqs).map(([k, b]) => [k, COMPARED_PART(k)
      ? { ...b, comparisons, limit: comparedLimit(b.limit, comparisons) } : b]));
    const payloads = await ga.parts(withCmp);
    try {
      const per = Object.fromEntries(SEGMENTS.map(s => [s, {}]));
      let answered = 0;
      for (const [k, p] of Object.entries(payloads)) {
        if (COMPARED_PART(k)) {
          if (p && !p.error) answered++;
          const split = splitByComparison(p);
          for (const s of SEGMENTS) per[s][k] = split[s];
        } else for (const s of SEGMENTS) per[s][k] = p;
      }
      if (!answered) throw new Error("no funnel part answered the comparisons");
      const segments = Object.fromEntries(SEGMENTS.map(s => [s, summarizeFunnel(cfg, per[s])]));
      return { ...segments.all, segments, segmentsError: null };
    } catch (e) {
      const plain = summarizeFunnel(cfg, await ga.parts(reqs));
      return { ...plain, segments: null, segmentsError: e.message };
    }
  }
  return { ...summarizeFunnel(cfg, await ga.parts(reqs)), segments: null, segmentsError: null };
}

// ---- conversions and key-event tiles ---------------------------------------------

/**
 * Every configured conversion over the lookback, newest first. A list is not a
 * comparison, so each row is classified by the traffic rule in the page, and
 * internal rows are listed and labelled rather than hidden.
 */
export async function conversions(ga, cfg) {
  const c = cfg.conversions;
  const intDim = cfg.internalUsers?.dimension;
  const cols = ["dateHour", "eventName", "firstUserSource", "firstUserCampaignName", "country",
                ...(intDim ? [intDim] : []), "hostName"];
  const p = await ga.runReport({ dateRanges: [{ startDate: `${c.lookbackDays - 1}daysAgo`, endDate: "today" }],
    dimensions: dims(cols), metrics: mets(["eventCount"]), dimensionFilter: events(c.events),
    orderBys: [{ dimension: { dimensionName: "dateHour" }, desc: true }], limit: 1000 });
  const rule = cfg.traffic?.rule;
  const all = gaRows(p, cols, ["eventCount"]).map(r => ({
    dateHour: r.dateHour, event: r.eventName, label: cfg.events[r.eventName]?.label || r.eventName,
    source: r.firstUserSource, campaign: r.firstUserCampaignName, country: r.country,
    id: intDim ? r[intDim] : null, internal: intDim ? internalLabel(cfg, r[intDim]) : null,
    host: r.hostName || null, traffic: rule ? classifyHosts([r.hostName], rule) : null, count: Math.round(r.eventCount) || 1,
  })).sort((a, b) => (b.dateHour > a.dateHour ? 1 : b.dateHour < a.dateHour ? -1 : 0));
  const last = {};
  for (const r of all) if (!r.internal && !(r.event in last)) last[r.event] = r.dateHour;
  return { rows: all.slice(0, c.cap), total: all.length, truncated: (p.rowCount || 0) > all.length, last,
           internal: all.filter(r => r.internal).length,
           traffic: { nonstandard: all.filter(r => r.traffic === "nonstandard").length,
                      unknown: all.filter(r => r.traffic == null).length } };
}

/** People (or events) per key event over the range, plus when each last happened. */
export async function keyEventTiles(ga, cfg, minutes) {
  if (!cfg.tiles.length) return { tiles: [], segments: null };
  const range = [{ startDate: rangeStart(Math.max(minutes, MINUTES_PER_DAY)), endDate: "today" }];
  const ours = internalExclusion(cfg);
  const comparisons = comparisonsFor(cfg);
  const lookbackDays = cfg.conversions?.lookbackDays || cfg.funnel?.lookbackDays || 90;
  const reqs = {};
  cfg.tiles.forEach((t, i) => {
    reqs[`v${i}`] = { dateRanges: range, metrics: mets([t.metric]), dimensionFilter: and(events([t.event]), ours),
                      ...(comparisons ? { comparisons, metricAggregations: ["TOTAL"] } : {}) };
  });
  reqs.last = { dateRanges: [{ startDate: `${lookbackDays - 1}daysAgo`, endDate: "today" }],
                dimensions: dims(["eventName", "dateHour"]), metrics: mets(["eventCount"]),
                dimensionFilter: and(events(cfg.tiles.map(t => t.event)), ours),
                orderBys: [{ dimension: { dimensionName: "dateHour" }, desc: true }], limit: 1000 };
  const parts = await ga.parts(reqs);
  const last = {};
  if (!parts.last.error) for (const r of gaRows(parts.last, ["eventName", "dateHour"], ["eventCount"]))
    if (!(r.eventName in last)) last[r.eventName] = r.dateHour;
  const value = (p, metric, seg) => {
    if (!p || p.error) return null;
    if (!comparisons) return Math.round(gaTotalsRow(p, [metric])[metric]);
    try { return Math.round(comparisonTotals(p, [metric])[seg][metric]); } catch (e) { return seg === "all" ? null : undefined; }
  };
  const tilesFor = seg => cfg.tiles.map((t, i) => ({
    ...t, value: value(parts[`v${i}`], t.metric, seg) ?? null, error: parts[`v${i}`].error || null,
    last: last[t.event] || null, lastError: parts.last.error || null }));
  const segments = comparisons && cfg.tiles.every((t, i) => !parts[`v${i}`].error)
    ? Object.fromEntries(SEGMENTS.map(s => [s, { tiles: tilesFor(s) }])) : null;
  return { tiles: tilesFor("all"), segments };
}

// ---- spike drill-down ----------------------------------------------------------------

/** What drove an episode: its hours against the same hours one week earlier, per breakdown. */
export async function spikeDrill(ga, cfg, start, end) {
  const win = hoursIn({ start, end });
  const baseline = win.map(h => toDH(new Date(parseDH(h).getTime() - 7 * 24 * 3600e3)));
  const hours = [...baseline, ...win];
  const dateRanges = [{ startDate: isoDay(hours[0]), endDate: isoDay(hours[hours.length - 1]) }];
  const comparisons = comparisonsFor(cfg);
  const body = (b, cmp) => ({ dateRanges, dimensions: dims(["dateHour", b.dimension]), metrics: mets(["activeUsers"]),
                              dimensionFilter: inList("dateHour", hours), limit: comparedLimit(10000, cmp),
                              ...(cmp ? { comparisons: cmp } : {}) });
  const read = (p, b, compared) => {
    if (!compared) return gaRows(p, ["dateHour", b.dimension], ["activeUsers"])
      .map(r => ({ ts: r.dateHour, name: r[b.dimension], users: r.activeUsers, segment: "all" }));
    const by = gaRowsByComparison(p, ["dateHour", b.dimension], ["activeUsers"]);
    return SEGMENTS.flatMap(seg => by[seg].map(r => ({ ts: r.dateHour, name: r[b.dimension], users: r.activeUsers, segment: seg })));
  };
  let rowsBy = {}, segmentsError = null;
  if (comparisons) {
    try {
      for (const b of cfg.breakdowns) rowsBy[b.key] = read(await ga.runReport(body(b, comparisons)), b, true);
    } catch (e) { segmentsError = e.message; rowsBy = {}; }
  }
  if (!Object.keys(rowsBy).length)
    for (const b of cfg.breakdowns) rowsBy[b.key] = read(await ga.runReport(body(b, null)), b, false);
  const segs = segmentsError || !comparisons ? ["all"] : SEGMENTS;
  const wset = new Set(win);
  const per = Object.fromEntries(segs.map(seg => [seg, {
    movers: spikeMovers(win, Object.fromEntries(Object.entries(rowsBy).map(([k, rows]) => [k, rows.filter(r => r.segment === seg)]))),
    extra: Math.round((rowsBy[cfg.breakdowns[0].key] || [])
      .filter(r => r.segment === seg).reduce((n, r) => n + (wset.has(r.ts) ? r.users : -r.users), 0)) }]));
  return { window: { start, end }, ...per.all, segments: segmentsError || !comparisons ? null : per, segmentsError };
}

// ---- the non-standard traffic profile ------------------------------------------------

export async function trafficProfile(ga, cfg, minutes) {
  const t = cfg.traffic;
  const dateRanges = [{ startDate: rangeStart(Math.max(minutes, MINUTES_PER_DAY)), endDate: "today" }];
  const expr = trafficFilterExpression(t.rule);
  const reqs = {};
  for (const d of t.fingerprint) reqs[`fp:${d}`] = { dateRanges, dimensionFilter: expr, dimensions: dims([d]),
    metrics: mets(["activeUsers", "userEngagementDuration"]),
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }], limit: 6 };
  const EM = ["activeUsers", "sessions", "engagementRate", "userEngagementDuration", "screenPageViewsPerSession"];
  reqs.engagement = { dateRanges, metrics: mets(EM), comparisons: trafficComparisons(t.rule), metricAggregations: ["TOTAL"] };
  const parts = await ga.parts(reqs);
  const fingerprint = Object.fromEntries(t.fingerprint.map(d => {
    const p = parts[`fp:${d}`];
    return [d, p.error ? { error: p.error } : gaRows(p, [d], ["activeUsers", "userEngagementDuration"]).map(r => ({
      value: r[d], users: Math.round(r.activeUsers),
      secondsPerUser: r.activeUsers ? r.userEngagementDuration / r.activeUsers : null }))];
  }));
  let engagement;
  try {
    if (parts.engagement.error) throw new Error(parts.engagement.error);
    const tot = comparisonTotals(parts.engagement, EM);
    engagement = Object.fromEntries(SEGMENTS.map(s => [s, {
      users: Math.round(tot[s].activeUsers), sessions: Math.round(tot[s].sessions),
      engagementRate: tot[s].sessions ? tot[s].engagementRate : null,
      secondsPerUser: tot[s].activeUsers ? tot[s].userEngagementDuration / tot[s].activeUsers : null,
      viewsPerSession: tot[s].sessions ? tot[s].screenPageViewsPerSession : null }]));
  } catch (e) { engagement = { error: e.message }; }
  return { fingerprint, engagement };
}
