// RIPE Atlas (API v2) and RIPEstat calls, from the browser. Read-only calls
// need no key, and both send CORS headers (Atlas echoes the Origin, RIPEstat
// sends *). DOM-free (fetch is passed in), so node's tests import it.
//
// Politeness: responses are cached for the session (per page load, by URL),
// at most CONCURRENCY requests are in flight, probe ids go in batches of
// BATCH, and a 429 or 5xx waits (Retry-After, else 1 s, 2 s, 4 s) and tries
// again, up to RETRIES times. Every call takes an AbortSignal (ctx.signal).

export const ATLAS = 'https://atlas.ripe.net';
export const ATLAS_API = `${ATLAS}/api/v2`;
export const RIPESTAT = 'https://stat.ripe.net/data';
export const BATCH = 100;
export const CONCURRENCY = 2;
export const RETRIES = 3;

// The built-in measurements every probe runs (ids checked against
// /api/v2/measurements/?id__lt=7000, November 2026): pings every 240 s and
// traceroutes every 1800 s to the root servers, IPv4 and IPv6.
export const BUILTIN = {
  ping: { 4: { id: 1001, target: 'k.root-servers.net' }, 6: { id: 2001, target: 'k.root-servers.net' } },
  traceroute: { 4: { id: 5001, target: 'k.root-servers.net' }, 6: { id: 6001, target: 'k.root-servers.net' } },
  // to unicast targets everywhere (every 900 s): these cross Starlink's backbone
  topology: { 4: { id: 5051, target: 'topology4.dyndns.atlas.ripe.net' }, 6: { id: 6052, target: 'topology6.dyndns.atlas.ripe.net' } },
};
export const PING_INTERVAL_S = 240;

export const PROBE_FIELDS = 'id,geometry,address_v4,address_v6,prefix_v4,prefix_v6,asn_v4,asn_v6,status,tags,country_code,description,is_anchor';

export const measurementUrl = (id) => `${ATLAS}/measurements/${id}/`;
export const probeUrl = (id) => `${ATLAS}/probes/${id}/`;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason ?? new DOMException('aborted', 'AbortError'))), { once: true });
  });

export const chunks = (xs, n = BATCH) => {
  const out = [];
  for (let k = 0; k < xs.length; k += n) out.push(xs.slice(k, k + n));
  return out;
};

/**
 * A client: { json(url, signal), probes(signal), latest(msm, ids, signal),
 * results(msm, id, { start, stop }, signal), networkInfo(ip, signal),
 * cached(url) }. `fetch` and `sleep` are passed in for tests.
 */
export function createAtlasClient({ fetch = globalThis.fetch, wait = sleep, cache = new Map() } = {}) {
  let active = 0;
  const queue = [];
  const slot = () =>
    new Promise((resolve) => {
      if (active < CONCURRENCY) return active++, resolve();
      queue.push(resolve);
    });
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };

  async function get(url, signal) {
    for (let attempt = 0; ; attempt++) {
      await slot();
      let res;
      try {
        if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
        res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
      } finally {
        release();
      }
      if (res.ok) return res.json();
      const retry = res.status === 429 || res.status >= 500;
      if (!retry || attempt >= RETRIES) throw new Error(`${new URL(url).host} answered ${res.status}`);
      const after = Number(res.headers?.get?.('Retry-After'));
      await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt, signal);
    }
  }

  /** The JSON at a URL, once per session (a failed one is tried again next time). */
  function json(url, signal) {
    const had = cache.get(url);
    // one started by an app that has unmounted since is aborted: start again
    if (!had || (!had.done && had.signal?.aborted && had.signal !== signal)) {
      const e = { p: get(url, signal), signal, done: false };
      cache.set(url, e);
      e.p.then(() => (e.done = true), () => cache.get(url) === e && cache.delete(url));
    }
    return cache.get(url).p;
  }

  /** Every page of a paged Atlas list (results + next). */
  async function pages(url, signal) {
    const out = [];
    for (let next = url, n = 0; next && n < 20; n++) {
      const page = await json(next, signal);
      out.push(...(page.results ?? []));
      next = page.next;
    }
    return out;
  }

  return {
    json,
    cached: (url) => cache.has(url),
    /** The connected probes on AS14593 (asn_v4 or asn_v6), raw. */
    async probes(signal, asn = 14593) {
      const q = (k) => `${ATLAS_API}/probes/?${k}=${asn}&status=1&page_size=500&fields=${PROBE_FIELDS}`;
      const [v4, v6] = await Promise.all([pages(q('asn_v4'), signal), pages(q('asn_v6'), signal)]);
      const byId = new Map();
      for (const p of [...v4, ...v6]) if (!byId.has(p.id)) byId.set(p.id, p);
      return [...byId.values()].sort((a, b) => a.id - b.id);
    },
    /** The latest result of a measurement for each of these probes, batched. */
    async latest(msm, ids, signal) {
      const sorted = [...new Set(ids)].sort((a, b) => a - b);
      const parts = await Promise.all(chunks(sorted).map((b) => json(`${ATLAS_API}/measurements/${msm}/latest/?probe_ids=${b.join(',')}`, signal)));
      return parts.flat();
    },
    /** A probe's results of a measurement from start to stop (Unix s). */
    results(msm, id, { start, stop }, signal) {
      return json(`${ATLAS_API}/measurements/${msm}/results/?probe_ids=${id}&start=${start}&stop=${stop}`, signal);
    },
    /** RIPEstat network-info: { asns: [number], prefix } for an address. */
    async networkInfo(ip, signal) {
      const d = await json(`${RIPESTAT}/network-info/data.json?resource=${encodeURIComponent(ip)}&sourceapp=netmap`, signal);
      return { asns: (d?.data?.asns ?? []).map(Number).filter(Number.isFinite), prefix: d?.data?.prefix || null };
    },
  };
}
