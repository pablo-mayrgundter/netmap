// RIPE Atlas probes on Starlink (AS14593), and the PoP each one is behind.
// DOM-free, so node's tests import it.
//
// A probe's PoP comes from its public address: the longest prefix of
// Starlink's pops.csv (prefixes.json) that holds it. Atlas hides the address
// of a probe whose owner made it private, so the order is: the probe's
// address_v4, the source address of its latest built-in result (`from`), its
// address_v6, then its announced prefix (prefix_v4/v6: when that prefix is
// wider than pops.csv's, the PoP its pops.csv prefixes share, or most of
// them). Last, its geometry: the geofeed region nearest the probe's
// (user-set, fuzzed) location, and the PoP that region's prefixes go to.

import { prefixTable } from './ip.js';

export const STARLINK_ASN = 14593;
// How far a probe may be from a geofeed region's point to take its PoP by geometry.
export const GEO_MATCH_KM = 400;

/** A probe from the Atlas API (/api/v2/probes/) as the app keeps it. */
export function normalizeProbe(p) {
  const [lon, lat] = p?.geometry?.coordinates ?? [null, null];
  return {
    id: p.id,
    lon: Number.isFinite(lon) ? lon : null,
    lat: Number.isFinite(lat) ? lat : null,
    country: p.country_code ?? null,
    v4: p.address_v4 ?? null,
    v6: p.address_v6 ?? null,
    prefixV4: p.prefix_v4 ?? null,
    prefixV6: p.prefix_v6 ?? null,
    asnV4: p.asn_v4 ?? null,
    asnV6: p.asn_v6 ?? null,
    status: p.status?.name ?? null,
    since: p.status?.since ?? null,
    anchor: !!p.is_anchor,
    description: p.description ?? '',
    tags: (p.tags ?? []).map((t) => (typeof t === 'string' ? t : t.slug)).filter(Boolean),
  };
}

/** Probes from several pages or queries (asn_v4 and asn_v6), once each, by id. */
export function mergeProbes(...lists) {
  const byId = new Map();
  for (const list of lists) for (const p of list ?? []) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

const R_KM = 6371;
export function distanceKm(lon1, lat1, lon2, lat2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The PoP most of these table rows go to: { pop, share } or null. */
function majority(rows) {
  const n = new Map();
  for (const r of rows) if (r.pop) n.set(r.pop, (n.get(r.pop) ?? 0) + 1);
  let best = null;
  for (const [pop, k] of n) if (!best || k > best.k) best = { pop, k };
  return best && { pop: best.pop, share: best.k / rows.length };
}

/**
 * The geofeed region nearest a point, with a PoP: { region, pop, km } or
 * null. `regions` is regions.json ({ lat, lon, pops: [{ code, prefixes }] }).
 */
export function nearestRegion(regions, lon, lat, maxKm = GEO_MATCH_KM) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  let best = null;
  for (const r of regions ?? []) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || !r.pops?.length) continue;
    const km = distanceKm(lon, lat, r.lon, r.lat);
    if (km <= maxKm && (!best || km < best.km)) best = { region: r, km };
  }
  if (!best) return null;
  const top = [...best.region.pops].sort((a, b) => b.prefixes - a.prefixes)[0];
  return { region: best.region, pop: top.code, km: best.km };
}

/**
 * Probe -> PoP. `table` is prefixTable(prefixes.json) (or prefixes.json),
 * `from` the probe's source address in its latest Atlas result, if known.
 * Returns { pop, via, address, prefix, region: [country, region, city] |
 * null, geo: { pop, km, region } | null, agrees } where `via` is 'address',
 * 'result', 'address_v6', 'prefix', 'geometry' or null (no PoP), and
 * `agrees` says whether the geometry's PoP is the same (null if either is
 * unknown).
 */
export function matchProbe(probe, table, { regions = [], from = null } = {}) {
  const t = typeof table?.lookup === 'function' ? table : prefixTable(table);
  const geo = nearestRegion(regions, probe.lon, probe.lat);
  const geoOut = geo && { pop: geo.pop, km: Math.round(geo.km), region: geo.region.id ?? null };
  const out = (pop, via, address, hit) => ({
    pop,
    via,
    address,
    prefix: hit?.prefix ?? null,
    region: hit?.region ?? null,
    geo: geoOut,
    agrees: pop && geoOut ? pop === geoOut.pop : null,
  });
  for (const [via, addr] of [['address', probe.v4], ['result', from], ['address_v6', probe.v6]]) {
    if (!addr) continue;
    const hit = t.lookup(addr);
    if (hit?.pop) return out(hit.pop, via, addr, hit);
  }
  for (const pfx of [probe.prefixV4, probe.prefixV6]) {
    if (!pfx) continue;
    const hit = t.lookup(pfx); // pops.csv has a wider prefix holding it
    if (hit?.pop) return out(hit.pop, 'prefix', null, hit);
    const rows = t.inside(pfx); // or several narrower ones inside it
    const m = majority(rows);
    if (m) return { ...out(m.pop, 'prefix', null, rows.find((r) => r.pop === m.pop)), prefix: pfx, share: m.share };
  }
  if (geoOut) return { ...out(geoOut.pop, 'geometry', null, null), agrees: null };
  return out(null, null, null, null);
}

/**
 * Distinct colours for PoPs, by their order in `codes` (golden-angle hues):
 * code -> [r, g, b]. Stable for one list of PoPs.
 */
export function popColours(codes) {
  const out = new Map();
  [...codes].sort().forEach((c, k) => out.set(c, hsl(((k * 137.508) % 360) / 360, 0.72, 0.58)));
  return out;
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
