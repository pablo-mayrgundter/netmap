// Latency from RIPE Atlas pings: per probe, by PoP and by region, and a
// probe's RTT over time. DOM-free, so node's tests import it.

/** The q-quantile (0..1) of sorted numbers, linearly interpolated; null if none. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const x = (sorted.length - 1) * q;
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

/** { n, median, p90, min, max } of numbers (non-finite ones dropped). */
export function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { n: v.length, median: quantile(v, 0.5), p90: quantile(v, 0.9), min: v.length ? v[0] : null, max: v.length ? v[v.length - 1] : null };
}

/**
 * One Atlas ping result (/measurements/<id>/latest/ or /results/) as
 * { probe, msm, ts (Unix s), dst, from, rtts: [ms], rtt (the median reply),
 * min, sent, rcvd } or null if it isn't a ping. `rtt` is null when nothing
 * came back.
 */
export function parsePing(r) {
  if (!r || r.type !== 'ping') return null;
  const rtts = (r.result ?? []).map((x) => x?.rtt).filter(Number.isFinite);
  const s = stats(rtts);
  return {
    probe: r.prb_id,
    msm: r.msm_id,
    ts: r.timestamp,
    dst: r.dst_name ?? r.dst_addr ?? null,
    dstAddr: r.dst_addr ?? null,
    from: r.from ?? null,
    af: r.af ?? null,
    rtts,
    rtt: s.median,
    min: Number.isFinite(r.min) && r.min >= 0 ? r.min : s.min,
    sent: r.sent ?? null,
    rcvd: r.rcvd ?? rtts.length,
  };
}

/**
 * Latency grouped by a key of each probe: [{ key, n, median, p90, min, max,
 * probes: [id] }], fastest median first. `probes` are { id, … }, `keyOf(p)`
 * their group (null: left out), `rttOf(id)` a probe's RTT (ms) or null.
 */
export function latencyBy(probes, keyOf, rttOf) {
  const groups = new Map();
  for (const p of probes) {
    const k = keyOf(p);
    const rtt = rttOf(p.id);
    if (k === null || k === undefined || !Number.isFinite(rtt)) continue;
    if (!groups.has(k)) groups.set(k, { rtts: [], probes: [] });
    const g = groups.get(k);
    g.rtts.push(rtt);
    g.probes.push(p.id);
  }
  return [...groups]
    .map(([key, g]) => ({ key, ...stats(g.rtts), probes: g.probes }))
    .sort((a, b) => a.median - b.median || String(a.key).localeCompare(String(b.key)));
}

/** A probe's region for grouping: its geofeed row's country and subdivision ("US-WA"), or its Atlas country. */
export function regionKey(match, probe) {
  const r = match?.region;
  if (r && r[0]) return r[1] ? (r[1].startsWith(`${r[0]}-`) ? r[1] : `${r[0]}-${r[1]}`) : r[0];
  return probe?.country ?? null;
}

/**
 * A probe's RTTs over time from /results/: [{ ts, rtt, min, max, rtts }],
 * oldest first, results with no reply left out.
 */
export function rttSeries(results) {
  return (results ?? [])
    .map(parsePing)
    .filter((p) => p && p.rtt !== null)
    .map((p) => ({ ts: p.ts, rtt: p.rtt, min: Math.min(...p.rtts), max: Math.max(...p.rtts), rtts: p.rtts, msm: p.msm }))
    .sort((a, b) => a.ts - b.ts);
}

// Starlink reassigns a dish's satellite every 15 s, at seconds 12, 27, 42 and
// 57 of each minute (Tanveer et al., "Making Sense of Constellations",
// arXiv 2307.00402). RTT steps line up with these boundaries.
export const RECONFIG_SECONDS = [12, 27, 42, 57];
export const RECONFIG_PERIOD_S = 15;

/** The reconfiguration boundaries (Unix s) from t0 to t1. */
export function reconfigBoundaries(t0, t1) {
  const out = [];
  if (!(t1 >= t0)) return out;
  let t = Math.floor(t0 / 60) * 60;
  for (; t <= t1; t += 60) for (const s of RECONFIG_SECONDS) if (t + s >= t0 && t + s <= t1) out.push(t + s);
  return out;
}

/** The median spacing of a series' samples, s (null for fewer than 2). */
export function resolutionS(series) {
  const d = [];
  for (let k = 1; k < series.length; k++) d.push(series[k].ts - series[k - 1].ts);
  return stats(d).median;
}

/** Can a series show the 15 s steps? Only with at least two samples per slot. */
export const resolvesReconfig = (series) => {
  const r = resolutionS(series);
  return r !== null && r <= RECONFIG_PERIOD_S / 2;
};
