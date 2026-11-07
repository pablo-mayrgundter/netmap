// The traffic estimate: demand from Starlink's customer regions, each served
// by the satellite the link model picks for it and carried to a gateway
// (straight down, or over the laser mesh first), summed into the relative
// load on each laser link, each feeder link (satellite → gateway) and each
// gateway. No measured traffic data is public: this is an estimate of where
// the load would fall if demand followed the geofeed's address counts.
// DOM-free.

import { site } from './geometry.js';

/**
 * Demand points from regions.json: each placed region weighted by its IPv4
 * addresses (a proxy for subscribers: the feed doesn't say how many use
 * each block), or by its prefixes where it has no IPv4 addresses.
 */
export function demandRegions(regions) {
  const out = [];
  for (const r of regions ?? []) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const w = r.v4_addresses > 0 ? r.v4_addresses : (r.v4_prefixes ?? 0) + (r.v6_prefixes ?? 0);
    if (!(w > 0)) continue;
    out.push({ id: r.id, lon: r.lon, lat: r.lat, w, label: r.city || r.region_name || r.country_name || r.country, s: site(r.lon, r.lat, 0) });
  }
  return out;
}

/**
 * Assign each demand point to its serving satellite and route, and sum the
 * loads. `serve(point)` -> { i, rule } | null (the link model's pick: a
 * satellite in view that sees a gateway, else the best laser path, else
 * none). `tree` is route.js's dijkstra from the gateways; `exitGw[i]` the
 * gateway a terminal satellite goes down at; `nLinks` and `nGateways` size
 * the outputs.
 *
 * Returns { link: Float64Array (load per mesh link), gateway: Float64Array,
 * feeder: Map("sat:gw" -> { sat, gw, load }), total, bent, laser, unserved,
 * hops: the demand-weighted mean laser hops }.
 */
export function assignTraffic(points, { serve, tree, exitGw, nLinks, nGateways }) {
  const link = new Float64Array(nLinks);
  const gateway = new Float64Array(nGateways);
  const feeder = new Map();
  let total = 0, bent = 0, laser = 0, unserved = 0, hopW = 0;
  const down = (sat, w) => {
    const g = exitGw[sat];
    if (g < 0) return false;
    gateway[g] += w;
    const k = `${sat}:${g}`;
    const f = feeder.get(k);
    if (f) f.load += w;
    else feeder.set(k, { sat, gw: g, load: w });
    return true;
  };
  for (const p of points) {
    total += p.w;
    const pick = serve(p);
    if (!pick) {
      unserved += p.w;
      continue;
    }
    if (pick.rule === 'bent-pipe') {
      if (down(pick.i, p.w)) bent += p.w;
      else unserved += p.w;
      continue;
    }
    if (pick.rule === 'laser' && tree && tree.root[pick.i] >= 0) {
      let u = pick.i, hops = 0;
      while (tree.prev[u] >= 0) {
        link[tree.prevEdge[u]] += p.w;
        u = tree.prev[u];
        hops++;
      }
      if (down(u, p.w)) (laser += p.w), (hopW += hops * p.w);
      else unserved += p.w;
      continue;
    }
    unserved += p.w;
  }
  return { link, gateway, feeder, total, bent, laser, unserved, hops: laser > 0 ? hopW / laser : 0 };
}
