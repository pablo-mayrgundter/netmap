// Starlink's PoP-to-PoP backbone: a hook, since no source is in netmap yet.
//
// arXiv 2412.18243 maps 33 PoPs and 70 links between them, but its dataset
// (ki3.org.cn) couldn't be reached to check its licence, so nothing is baked.
// The panel says "not yet published" until one of these supplies links:
//
// * a section calling `publishBackbone(...)` at runtime, e.g. links inferred
//   from RIPE Atlas traceroutes between Starlink probes (#33);
// * a data file at `<data base>/starlink/backbone.json` (BACKBONE_FILE),
//   written by the pipeline, read when the app opens.
//
// Both take the same shape:
//   { source: 'RIPE Atlas traceroutes (#33)', kind: 'measured' | 'modelled',
//     measured_at: ISO time or null, url?: where it's from,
//     links: [{ from: 'lsancax1', to: 'sttlwax1', rtt_ms?, samples? }] }
// PoPs are named by their pops.json code. DOM-free.

export const BACKBONE_FILE = 'starlink/backbone.json';

let current = null;
const subs = new Set();

/**
 * The backbone as the map draws it: the links between known, placed PoPs,
 * each pair once (the lower code first, the most samples kept), or null when
 * there are none. `byCode` is shapeStarlink's.
 */
export function normaliseBackbone(raw, byCode) {
  if (!raw || !Array.isArray(raw.links)) return null;
  const seen = new Map();
  for (const l of raw.links) {
    const a = byCode?.get(l?.from), b = byCode?.get(l?.to);
    if (!a || !b || a === b || !a.placed || !b.placed) continue;
    const [p, q] = a.code < b.code ? [a, b] : [b, a];
    const key = `${p.code}|${q.code}`;
    const link = { from: p.code, to: q.code, a: p, b: q, rtt_ms: Number.isFinite(l.rtt_ms) ? l.rtt_ms : null, samples: Number.isFinite(l.samples) ? l.samples : null };
    const old = seen.get(key);
    if (!old || (link.samples ?? 0) > (old.samples ?? 0)) seen.set(key, link);
  }
  if (!seen.size) return null;
  return {
    source: String(raw.source || 'unnamed source'),
    kind: raw.kind === 'measured' ? 'measured' : 'modelled',
    measured_at: raw.measured_at || null,
    url: raw.url || null,
    links: [...seen.values()],
  };
}

/** Hand the app a backbone (the shape above), or null to clear it. */
export function publishBackbone(raw) {
  current = raw ?? null;
  for (const fn of [...subs]) fn(current);
}

/** The last backbone published (raw, not normalised), or null. */
export const publishedBackbone = () => current;

/** Call `fn(raw)` on each publishBackbone; returns an off(). */
export function onBackbone(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** BACKBONE_FILE under `base`, or null if it isn't there. */
export async function loadBackboneFile({ base, fetch = globalThis.fetch, signal }) {
  try {
    const res = await fetch(`${base}/${BACKBONE_FILE}`, { signal });
    if (!res.ok || !/json/.test(res.headers?.get?.('content-type') ?? 'json')) return null;
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  }
}
