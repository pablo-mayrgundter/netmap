// RIPEstat's data API (https://stat.ripe.net/docs/data-api/) for AS14593:
// the calls the looking glass makes from the browser (stat.ripe.net sends
// Access-Control-Allow-Origin: *), a per-session cache of their shaped
// results, and the shaping: from each call's `data` to the few numbers and
// lists the panel shows. DOM-free; fetch and storage are passed in.

export const RIPESTAT = 'https://stat.ripe.net';
export const SOURCE_APP = 'netmap';
/** RIPEstat's page for an AS (the "measured" label links to it). */
export const ripestatPage = (asn) => `${RIPESTAT}/resource/AS${asn}`;

/** The data call's URL: /data/<call>/data.json?resource=AS<asn>&sourceapp=netmap&… */
export function ripestatUrl(call, params = {}) {
  const q = new URLSearchParams({ ...params, sourceapp: SOURCE_APP });
  return `${RIPESTAT}/data/${call}/data.json?${q}`;
}

/**
 * Fetch one data call: { data, time } (time: the call's server time, Unix
 * ms). Throws an Error with RIPEstat's message when the call fails or
 * answers with an error status.
 */
export async function fetchRipestat(call, params, { fetch: f = globalThis.fetch, signal } = {}) {
  const res = await f(ripestatUrl(call, params), { signal, headers: { Accept: 'application/json' } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: the status says */
  }
  if (!res.ok || !body || body.status !== 'ok' || !body.data) {
    const msg = body?.messages?.find?.((m) => m[0] === 'error')?.[1] ?? body?.message ?? `HTTP ${res.status}`;
    throw new Error(`RIPEstat ${call}: ${msg}`);
  }
  return { data: body.data, time: parseUtc(body.time) };
}

/** RIPEstat's times ("2026-11-06T16:00:00", UTC without a zone) -> Unix ms, or null. */
export function parseUtc(s) {
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * A cache of shaped results for the page session: in memory, and in
 * sessionStorage when there is one (a reload in the same tab skips the
 * calls). Entries older than `ttl` are refetched.
 */
export function createStatCache({ storage = null, ttl = 30 * 60_000, now = () => Date.now(), prefix = 'netmap.ripestat.' } = {}) {
  const mem = new Map();
  const fresh = (e) => e && now() - e.at < ttl;
  return {
    get(key) {
      let e = mem.get(key);
      if (!e && storage) {
        try {
          e = JSON.parse(storage.getItem(prefix + key) ?? 'null');
          if (e) mem.set(key, e);
        } catch {
          e = null;
        }
      }
      return fresh(e) ? e : null;
    },
    set(key, value) {
      const e = { at: now(), value };
      mem.set(key, e);
      try {
        storage?.setItem(prefix + key, JSON.stringify(e));
      } catch {
        /* full or blocked: memory still has it */
      }
      return e;
    },
    delete(key) {
      mem.delete(key);
      try {
        storage?.removeItem(prefix + key);
      } catch {
        /* blocked */
      }
    },
  };
}

const isV6 = (p) => p.includes(':');

/**
 * announced-prefixes -> { v4, v6, prefixes (announced at the latest time),
 * windowCount (announced at all in the window), byPop: [{ code, v4, v6 }]
 * most first, inFeed, noPop, notInFeed, time, window: [start, end] }.
 * `table` (prefixes.js) attributes each prefix to a PoP; a prefix covering
 * feed rows of several PoPs counts for its main one.
 */
export function shapeAnnounced(data, table = null) {
  const latest = data?.latest_time ?? data?.query_endtime ?? null;
  const all = Array.isArray(data?.prefixes) ? data.prefixes : [];
  const current = all
    .filter((p) => typeof p?.prefix === 'string' && (!latest || (p.timelines ?? []).some((t) => t.endtime >= latest)))
    .map((p) => p.prefix);
  const byPop = new Map();
  let inFeed = 0, noPop = 0, notInFeed = 0;
  for (const p of current) {
    const hit = table?.lookup(p) ?? null;
    if (!hit) {
      notInFeed++;
      continue;
    }
    inFeed++;
    if (!hit.pop) {
      noPop++;
      continue;
    }
    const e = byPop.get(hit.pop) ?? { code: hit.pop, v4: 0, v6: 0 };
    e[isV6(p) ? 'v6' : 'v4']++;
    byPop.set(hit.pop, e);
  }
  return {
    v4: current.filter((p) => !isV6(p)).length,
    v6: current.filter(isV6).length,
    prefixes: current,
    windowCount: all.length,
    byPop: [...byPop.values()].sort((a, b) => b.v4 + b.v6 - (a.v4 + a.v6) || (a.code < b.code ? -1 : 1)),
    inFeed,
    noPop,
    notInFeed,
    time: parseUtc(latest),
    window: [parseUtc(data?.query_starttime), parseUtc(data?.query_endtime)],
  };
}

/**
 * asn-neighbours -> { counts: { left, right, uncertain, unique }, left,
 * right, uncertain: [{ asn, power, v4, v6 }] most power first, time }.
 * "left" are the ASes next to it towards the RIS peers (its upstreams and
 * peers, mostly), "right" the ones it carries routes for (customers);
 * `power` is how many RIS peers saw the adjacency.
 */
export function shapeNeighbours(data) {
  const list = Array.isArray(data?.neighbours) ? data.neighbours : [];
  const side = (type) =>
    list
      .filter((n) => n?.type === type && Number.isFinite(Number(n.asn)))
      .map((n) => ({ asn: Number(n.asn), power: Number(n.power) || 0, v4: Number(n.v4_peers) || 0, v6: Number(n.v6_peers) || 0 }))
      .sort((a, b) => b.power - a.power || a.asn - b.asn);
  const left = side('left'), right = side('right'), uncertain = side('uncertain');
  const c = data?.neighbour_counts ?? {};
  return {
    counts: { left: c.left ?? left.length, right: c.right ?? right.length, uncertain: c.uncertain ?? uncertain.length, unique: c.unique ?? left.length + right.length + uncertain.length },
    left,
    right,
    uncertain,
    time: parseUtc(data?.latest_time ?? data?.query_endtime),
  };
}

/**
 * routing-status -> { visibility: { v4: { seeing, total }, v6 }, announced:
 * { v4, v6 } (prefix counts), neighbours (observed), firstSeen, time }.
 */
export function shapeRoutingStatus(data) {
  const vis = (v) => {
    const x = data?.visibility?.[v];
    return x ? { seeing: Number(x.ris_peers_seeing) || 0, total: Number(x.total_ris_peers) || 0 } : null;
  };
  return {
    visibility: { v4: vis('v4'), v6: vis('v6') },
    announced: { v4: data?.announced_space?.v4?.prefixes ?? null, v6: data?.announced_space?.v6?.prefixes ?? null },
    neighbours: data?.observed_neighbours ?? null,
    firstSeen: parseUtc(data?.first_seen?.time),
    time: parseUtc(data?.query_time),
  };
}

/**
 * visibility -> { collectors, fullTable: { v4, v6 } (full-table peers
 * counted), missing: { v4, v6 } (of those, peers not seeing some prefix),
 * worst: [{ name, city, v4, v6 }] the collectors with the most missing, time }.
 */
export function shapeVisibility(data) {
  const list = Array.isArray(data?.visibilities) ? data.visibilities : [];
  const fullTable = { v4: 0, v6: 0 }, missing = { v4: 0, v6: 0 };
  const rows = [];
  for (const c of list) {
    const m4 = c.ipv4_full_table_peers_not_seeing?.length ?? 0;
    const m6 = c.ipv6_full_table_peers_not_seeing?.length ?? 0;
    fullTable.v4 += Number(c.ipv4_full_table_peer_count) || 0;
    fullTable.v6 += Number(c.ipv6_full_table_peer_count) || 0;
    missing.v4 += m4;
    missing.v6 += m6;
    if (m4 || m6) rows.push({ name: c.probe?.name ?? '?', city: c.probe?.city ?? '', v4: m4, v6: m6 });
  }
  rows.sort((a, b) => b.v4 + b.v6 - (a.v4 + a.v6) || (a.name < b.name ? -1 : 1));
  return { collectors: list.length, fullTable, missing, worst: rows.slice(0, 5), time: parseUtc(data?.query_time ?? data?.latest_time) };
}

/**
 * prefix-count (the sparkline; routing-history's whole history for AS14593
 * is 7 MB, this is 5 KB) -> { v4: [{ t, n }], v6, resolution }, oldest first.
 */
export function shapePrefixCount(data) {
  const series = (k) =>
    (Array.isArray(data?.[k]) ? data[k] : [])
      .map((p) => ({ t: parseUtc(p.timestamp), n: Number(p.prefixes) }))
      .filter((p) => p.t !== null && Number.isFinite(p.n))
      .sort((a, b) => a.t - b.t);
  return { v4: series('ipv4'), v6: series('ipv6'), resolution: data?.resolution ?? null };
}

/**
 * An SVG path ("M…L…") for a sparkline of `values` in a w × h box (y down),
 * scaled from 0 when `zero`, else from the minimum. '' for fewer than 2.
 */
export function sparkPath(values, w, h, { zero = false, pad = 1 } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return '';
  const lo = zero ? Math.min(0, ...v) : Math.min(...v);
  const hi = Math.max(...v);
  const span = hi - lo || 1;
  const x = (i) => (pad + (i * (w - 2 * pad)) / (v.length - 1)).toFixed(1);
  const y = (n) => (h - pad - ((n - lo) * (h - 2 * pad)) / span).toFixed(1);
  return v.map((n, i) => `${i ? 'L' : 'M'}${x(i)} ${y(n)}`).join('');
}
