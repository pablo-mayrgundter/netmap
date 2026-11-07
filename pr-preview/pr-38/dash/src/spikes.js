// Robust spike detection over an hourly series. Mirrored in bizdash/spikes.py.
//
// Baseline: the median of the same hour of day over the previous `lookbackDays`
// days. Spread: the MAD of the same samples. A point spikes when its robust
// z-score clears `z` and it adds at least `minExtra` over the baseline.
// Consecutive spiking hours are one episode.

export const SPIKE_DEFAULTS = Object.freeze({ z: 4.0, minExtra: 15, lookbackDays: 14 });

export function median(a) {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** series: [{ts, value}] chronological, hourly. */
export function robustScores(series, { lookbackDays = SPIKE_DEFAULTS.lookbackDays } = {}) {
  const vals = series.map(p => p.value);
  return series.map((p, i) => {
    let samples = [];
    for (let j = i - 24; j >= 0 && samples.length < lookbackDays; j -= 24) samples.push(vals[j]);
    if (samples.length < 3) samples = vals.slice(Math.max(0, i - 24), i);
    if (!samples.length) samples = [p.value];
    const base = median(samples);
    const mad = median(samples.map(s => Math.abs(s - base))) || Math.max(base * 0.15, 1);
    return { ts: p.ts, value: p.value, baseline: Math.round(base * 10) / 10,
             z: Math.round((p.value - base) / (1.4826 * mad) * 100) / 100 };
  });
}

export function findEpisodes(scored, { z = SPIKE_DEFAULTS.z, minExtra = SPIKE_DEFAULTS.minExtra } = {}) {
  const episodes = [];
  let cur = null;
  for (const pt of scored) {
    const spiking = pt.z >= z && pt.value - pt.baseline >= minExtra;
    if (spiking) {
      if (!cur) cur = { start: pt.ts, end: pt.ts, peak: pt.value, peak_ts: pt.ts,
                        peak_z: pt.z, baseline: pt.baseline, extra: 0, hours: [] };
      cur.end = pt.ts;
      cur.hours.push(pt.ts);
      cur.extra += pt.value - pt.baseline;
      if (pt.value > cur.peak) Object.assign(cur, { peak: pt.value, peak_ts: pt.ts, peak_z: pt.z, baseline: pt.baseline });
    } else if (cur) { episodes.push(cur); cur = null; }
  }
  if (cur) episodes.push(cur);
  for (const e of episodes) e.extra = Math.round(e.extra);
  return episodes;
}

/**
 * Top movers between an episode's hours and a baseline set of hours.
 * rowsByKey: {key: [{ts, name, users}]}. Returns {key: [{name, spike, baseline, delta}]}.
 */
export function spikeMovers(windowHours, rowsByKey, top = 8) {
  const wset = new Set(windowHours);
  const movers = {};
  for (const [key, rows] of Object.entries(rowsByKey)) {
    const spike = {}, base = {};
    for (const r of rows) {
      const b = wset.has(r.ts) ? spike : base;
      b[r.name] = (b[r.name] || 0) + r.users;
    }
    movers[key] = [...new Set([...Object.keys(spike), ...Object.keys(base)])]
      .map(n => ({ name: n, spike: Math.round(spike[n] || 0), baseline: Math.round(base[n] || 0),
                   delta: Math.round((spike[n] || 0) - (base[n] || 0)) }))
      .sort((a, b) => b.delta - a.delta).slice(0, top);
  }
  return movers;
}
