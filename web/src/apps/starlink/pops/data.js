// Starlink's PoPs and customer regions, shaped for the map and the panel:
// marker sizes and colours, which PoP serves each region and how far away it
// is, a PoP's detail, and the layers param. DOM-free, so node's tests import
// it. Input is `python -m netmap starlink`'s pops.json and regions.json
// (README, "Starlink data").

export const EARTH_KM = 6371.0088;
const D2R = Math.PI / 180;

/** Great-circle distance in km between two lon/lat points (haversine). */
export function haversineKm(lon0, lat0, lon1, lat1) {
  const dLat = (lat1 - lat0) * D2R;
  const dLon = (lon1 - lon0) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat0 * D2R) * Math.cos(lat1 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const placed = (p) => Number.isFinite(p?.lon) && Number.isFinite(p?.lat);

// Marker radii in pixels: area follows the measure, between these.
export const POP_RADIUS = { min: 4, max: 15 };
export const REGION_RADIUS = { min: 2, max: 7 };

/** A marker's radius for `value` of `max` (area proportional; 0 or less: min). */
export function markerRadius(value, max, { min, max: top } = POP_RADIUS) {
  if (!(value > 0) || !(max > 0)) return min;
  return min + (top - min) * Math.sqrt(Math.min(1, value / max));
}

/** What a PoP's marker is sized by: its IPv4 addresses, else its prefix count. */
export const popWeight = (p) => (p.v4_addresses > 0 ? p.v4_addresses : (p.v4_prefixes ?? 0) + (p.v6_prefixes ?? 0));

/**
 * A colour for the PoP at `index`: hues a golden angle apart, so neighbours in
 * the (alphabetical) list differ, and every PoP keeps its colour between loads.
 * [r, g, b], bright enough for the dark map.
 */
export function popColour(index) {
  const h = (index * 137.508) % 360;
  const s = 0.72;
  const l = 0.6 + 0.08 * ((index % 3) - 1);
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}
export const NO_POP_COLOUR = [140, 148, 160];

/**
 * pops.json and regions.json as the app uses them:
 *
 * * `pops`: each PoP with `index`, `prefixes` (v4 + v6), `colour`, `radius`,
 *   `placed`, and `regions` as given (most prefixes first).
 * * `regions`: each region with `pop` (the index of the PoP serving most of
 *   its prefixes, or -1), `colour` (that PoP's), `radius`, `km` (to that PoP,
 *   or null), `placed`.
 * * `assignments`: one per (region, serving PoP) with both placed:
 *   `{ region, pop, prefixes, km }`, farthest first.
 * * `byCode`: PoP code -> PoP.
 */
export function shapeStarlink(popsJson, regionsJson) {
  const maxPop = Math.max(0, ...popsJson.map(popWeight));
  const pops = popsJson.map((p, index) => ({
    ...p,
    index,
    prefixes: (p.v4_prefixes ?? 0) + (p.v6_prefixes ?? 0),
    colour: popColour(index),
    radius: markerRadius(popWeight(p), maxPop, POP_RADIUS),
    placed: placed(p),
  }));
  const maxRegion = Math.max(0, ...regionsJson.map((r) => r.v4_addresses ?? 0));
  const assignments = [];
  const regions = regionsJson.map((r) => {
    const served = (r.pops ?? []).filter((s) => pops[s.pop]);
    const main = served.length ? served.reduce((a, b) => (b.prefixes > a.prefixes ? b : a)) : null;
    const pop = main ? pops[main.pop] : null;
    const isPlaced = placed(r);
    for (const s of served) {
      const p = pops[s.pop];
      if (isPlaced && p.placed) assignments.push({ region: r.id, pop: p.index, prefixes: s.prefixes, km: haversineKm(r.lon, r.lat, p.lon, p.lat) });
    }
    return {
      ...r,
      pop: pop ? pop.index : -1,
      colour: pop ? pop.colour : NO_POP_COLOUR,
      radius: markerRadius(r.v4_addresses ?? 0, maxRegion, REGION_RADIUS),
      km: pop && isPlaced && pop.placed ? haversineKm(r.lon, r.lat, pop.lon, pop.lat) : null,
      placed: isPlaced,
    };
  });
  assignments.sort((a, b) => b.km - a.km);
  const byCode = new Map(pops.map((p) => [p.code, p]));
  return { pops, regions, assignments, byCode };
}

/** A region's name for people: "Sana'a, Yemen", or the country alone. */
export function regionLabel(r) {
  const country = r.country_name || r.country || '';
  const place = r.city || r.region_name || '';
  return place && place !== country ? `${place}, ${country}` : country || place || '?';
}

/** A PoP's name for people: its city and code. */
export const popLabel = (p) => `${p.city || p.name || p.airport || '?'} · ${p.code}`;

/**
 * The farthest assignments: [{ region, pop, prefixes, km }] with the region
 * and PoP records, up to `n`, at least `minKm` away. Regions placed only at a
 * country or region point are kept but flagged by their `precision`.
 */
export function farthest(shaped, { n = 10, minKm = 0 } = {}) {
  const out = [];
  for (const a of shaped.assignments) {
    if (a.km < minKm || out.length >= n) break;
    out.push({ ...a, regionRec: shaped.regions[a.region], popRec: shaped.pops[a.pop] });
  }
  return out;
}

/**
 * A PoP's detail for the panel: { pop, prefixes, regions: [{ region, prefixes,
 * share, km }], more }, its regions most prefixes first, up to `n`. `share`
 * is the region's part of the PoP's prefixes (0..1).
 */
export function popDetail(shaped, code, { n = 8 } = {}) {
  const pop = shaped.byCode.get(code);
  if (!pop) return null;
  const list = pop.regions ?? [];
  const total = list.reduce((s, r) => s + r.prefixes, 0) || 1;
  const regions = list.slice(0, n).map((x) => {
    const region = shaped.regions[x.id];
    const km = region?.placed && pop.placed ? haversineKm(region.lon, region.lat, pop.lon, pop.lat) : null;
    return { region, prefixes: x.prefixes, share: x.prefixes / total, km };
  });
  return { pop, prefixes: pop.prefixes, regions, more: Math.max(0, list.length - n), countries: new Set(list.map((r) => r.country)).size };
}

/** The ids of the regions a PoP serves (any of their prefixes), as a Set. */
export const servedBy = (pop) => new Set((pop?.regions ?? []).map((r) => r.id));

/**
 * A great-circle path from `a` to `b` ([lon, lat]) in `segs` steps, as
 * [lon, lat, alt] points with longitudes kept continuous across the
 * antimeridian (so the 2D map draws it the short way round). `lift` raises the
 * middle (metres, for the globe).
 */
export function greatCircle(a, b, { segs = null, alt = 0, lift = 0 } = {}) {
  const [lo0, la0, lo1, la1] = [a[0] * D2R, a[1] * D2R, b[0] * D2R, b[1] * D2R];
  const p0 = [Math.cos(la0) * Math.cos(lo0), Math.cos(la0) * Math.sin(lo0), Math.sin(la0)];
  const p1 = [Math.cos(la1) * Math.cos(lo1), Math.cos(la1) * Math.sin(lo1), Math.sin(la1)];
  const ang = Math.acos(Math.max(-1, Math.min(1, p0[0] * p1[0] + p0[1] * p1[1] + p0[2] * p1[2])));
  const n = segs ?? Math.max(1, Math.min(32, Math.ceil(ang / (3 * D2R))));
  const so = Math.sin(ang);
  const out = [];
  let prev = a[0];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w0 = so < 1e-9 ? 1 - t : Math.sin((1 - t) * ang) / so;
    const w1 = so < 1e-9 ? t : Math.sin(t * ang) / so;
    const x = w0 * p0[0] + w1 * p1[0], y = w0 * p0[1] + w1 * p1[1], z = w0 * p0[2] + w1 * p1[2];
    let lon = Math.atan2(y, x) / D2R;
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    prev = lon;
    out.push([lon, Math.atan2(z, Math.hypot(x, y)) / D2R, alt + lift * Math.sin(Math.PI * t)]);
  }
  return out;
}

/**
 * The bounding box around a PoP and the regions it serves, for ctx.flyTo:
 * [west, south, east, north], west > east when it crosses the antimeridian.
 * Longitudes are taken the short way round from the PoP; a box wider than
 * 300° is no use, so it's null then (fly to the PoP instead).
 */
export function boundsAround(center, points, { pad = 2 } = {}) {
  if (!placed(center)) return null;
  let w = center.lon, e = center.lon, s = center.lat, n = center.lat;
  for (const p of points) {
    if (!placed(p)) continue;
    let lon = p.lon;
    while (lon - center.lon > 180) lon -= 360;
    while (lon - center.lon < -180) lon += 360;
    w = Math.min(w, lon), e = Math.max(e, lon), s = Math.min(s, p.lat), n = Math.max(n, p.lat);
  }
  w -= pad, e += pad, s = Math.max(-85, s - pad), n = Math.min(85, n + pad);
  if (e - w > 300) return null;
  const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
  return [wrap(w), s, wrap(e), n];
}

// The map layers the app can show, and which are on by default. One
// `starlink.layer` param holds every section's: this one's (POPS_LAYERS) and
// the links section's (links/).
export const POPS_LAYERS = ['pops', 'regions', 'peering', 'backbone'];
export const LAYERS = [...POPS_LAYERS, 'gateways', 'links'];
export const DEFAULT_LAYERS = [...POPS_LAYERS, 'gateways', 'links'];

/** The `starlink.layer` param -> a Set of known layer names (null: the default). */
export function parseLayers(param) {
  if (param === null || param === undefined) return new Set(DEFAULT_LAYERS);
  if (param === 'none' || param === '') return new Set();
  return new Set(String(param).split(',').filter((x) => LAYERS.includes(x)));
}

/** A Set of layer names -> the `starlink.layer` param (null for the default). */
export function layersParam(set) {
  const on = LAYERS.filter((l) => set.has(l));
  if (on.length === DEFAULT_LAYERS.length && DEFAULT_LAYERS.every((l) => set.has(l))) return null;
  return on.length ? on.join(',') : 'none';
}

/** 1234.4 -> "1,234 km". */
export const km = (x) => (Number.isFinite(x) ? `${Math.round(x).toLocaleString('en-US')} km` : '—');
