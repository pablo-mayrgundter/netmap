// The link model: the constellation propagated to a time, which satellites a
// dish sees, the one that serves it, the gateways that satellite sees, the
// gateway the traffic comes down at and the PoP behind it, and the latency
// of each leg. DOM-free and synchronous: the worker (worker.js) runs it off
// the main thread, node's tests run it directly. Everything here is a model;
// the section labels it so, with these assumptions (MODEL, below).

import { ecefToGeodetic, propagateAll, satellites } from './orbit.js';
import { clusterPlanes, clusterShells, markOperational, orbitAngles } from './shells.js';
import { azimuth, coverageAngle, fibreMs, gcKm, lookAt, site, vacuumMs } from './geometry.js';
import { buildGrid, GRID, refreshGrid } from './grid.js';
import { adjacency, dijkstra, pathFrom } from './route.js';
import { assignTraffic, demandRegions } from './traffic.js';

export const MODEL = {
  userMask: 25, // ° minimum elevation from a dish (FCC 21-48, 2021: 40° → 25°)
  gwMask: 25, // ° minimum elevation from a gateway (assumed)
  slotMs: 15000, // the scheduler's 15 s slots (arXiv 2307.00402)
  slotOffsetMs: 12000, // they start at :12, :27, :42 and :57 past the minute
  ...GRID, // the lasers' reach and grazing height (grid.js)
};

// Shell colours by inclination, as celestiary's Orbits layer colours them.
export const SHELL_COLOURS = [
  { maxIncl: 48, rgb: [111, 224, 200] }, // 43°
  { maxIncl: 60, rgb: [127, 184, 255] }, // 53°
  { maxIncl: 80, rgb: [200, 160, 255] }, // 70°
  { maxIncl: 180, rgb: [255, 168, 216] }, // polar
];
export const shellColour = (incl) => (SHELL_COLOURS.find((c) => incl < c.maxIncl) ?? SHELL_COLOURS[SHELL_COLOURS.length - 1]).rgb;

/**
 * The time the model runs at: the Orbits layer's frame time while it's on
 * (so the modelled satellites, mesh and links sit on the satellites it draws,
 * from the same elements), else netmap's clock.
 */
export const modelTime = ({ orbitsActive, orbitsTime, now }) => (orbitsActive && Number.isFinite(orbitsTime) && orbitsTime > 0 ? orbitsTime : now);

/** The 15 s scheduling slot a time is in (an integer). */
export const slotOf = (ms, o = MODEL) => Math.floor((ms - o.slotOffsetMs) / o.slotMs);

/** The index of the placed PoP nearest lon/lat, and its distance (km). */
export function nearestPop(pops, lon, lat) {
  let best = -1, km = Infinity;
  for (let k = 0; k < pops.length; k++) {
    const p = pops[k];
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
    const d = gcKm(lon, lat, p.lon, p.lat);
    if (d < km) (km = d), (best = k);
  }
  return { pop: best, km: best >= 0 ? km : null };
}

/**
 * Pick the serving satellite from the satellites in view ([{ i, el, terminal
 * }], terminal: it sees a gateway). The rule: a satellite with a gateway in
 * view (a "bent pipe") if there is one, the highest of those; else the one
 * `laserCost(i)` (uplink plus laser path, ms) makes cheapest, if given; else
 * the highest. Returns { i, rule } or null.
 */
export function pickServing(visible, { laserCost = null } = {}) {
  let best = null;
  for (const v of visible) if (v.terminal && (!best || v.el > best.el)) best = v;
  if (best) return { i: best.i, rule: 'bent-pipe' };
  if (laserCost) {
    let c = Infinity;
    for (const v of visible) {
      const x = laserCost(v);
      if (x < c) (c = x), (best = v);
    }
    if (best) return { i: best.i, rule: 'laser' };
  }
  for (const v of visible) if (!best || v.el > best.el) best = v;
  return best ? { i: best.i, rule: 'no-gateway' } : null;
}

/**
 * The model, for one constellation and set of gateways. `omm`: OMM records;
 * `gateways`: gateways.json's rows; `pops`: pops.json's (placed or not).
 */
export class LinkModel {
  constructor({ omm, gateways = [], pops = [], regions = [] }) {
    const t0 = performance.now();
    this.sats = satellites(omm);
    const n = this.sats.length;
    this.n = n;
    const { shellOf, shells } = clusterShells(this.sats);
    this.shellOf = shellOf;
    this.shells = shells;
    this.pos = new Float64Array(3 * n);
    this.vel = new Float64Array(3 * n);
    this.ok = new Uint8Array(n);
    this.geo = new Float32Array(3 * n); // lon °, lat °, altitude m (drawing)
    this.raan = new Float64Array(n);
    this.u = new Float64Array(n);
    this.operational = new Uint8Array(n);
    this.opList = new Int32Array(0);
    this.planes = null;
    this.byNorad = new Map(this.sats.map((s, i) => [s.norad, i]));
    this.pops = pops.map((p, index) => ({ index, code: p.code, city: p.city || p.name || p.code, lon: p.lon, lat: p.lat }));
    this.gateways = gateways.map((g, index) => {
      const s = site(g.lon, g.lat, (g.alt_m ?? 0) / 1000);
      const np = nearestPop(this.pops, g.lon, g.lat);
      return { index, id: g.id, name: g.name, lon: g.lon, lat: g.lat, p: s.p, up: s.up, s, pop: np.pop, backhaulKm: np.km, backhaulMs: np.km === null ? Infinity : fibreMs(np.km) };
    });
    // Each satellite's gateways in view this tick (CSR), and its best exit.
    this.gwStart = new Int32Array(n + 1);
    this.gwIdx = new Int32Array(1024);
    this.gwRange = new Float32Array(1024);
    this.exitGw = new Int32Array(n).fill(-1);
    this.exitMs = new Float64Array(n).fill(Infinity);
    this.t = null;
    this.held = null; // { norad, slot, rule }
    // The laser mesh (rebuilt each slot), its links' state this tick, and the routes down.
    this.use = new Uint8Array(n); // laser-capable and in a shell in service
    this.grid = null;
    this.gridSlot = null;
    this.len = this.up = this.w = null;
    this.linksUp = 0;
    this.tree = null;
    this.demand = demandRegions(regions);
    this.traffic = null; // { slot, … } assigned once a slot
    this.trafficSlot = null;
    this.timings = { init: performance.now() - t0 };
  }

  /** Propagate to `ms` and refresh what every later step reads. */
  propagate(ms) {
    const t0 = performance.now();
    propagateAll(this.sats, ms, this.pos, this.vel, this.ok);
    const t1 = performance.now();
    if (!this.planes) this.classify();
    const g = this.geo, pos = this.pos;
    const tmp = [0, 0, 0];
    for (const i of this.opList) {
      if (!this.ok[i]) continue;
      ecefToGeodetic(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], tmp);
      g[3 * i] = tmp[0];
      g[3 * i + 1] = tmp[1];
      g[3 * i + 2] = tmp[2] * 1000;
    }
    this.t = ms;
    this.timings.propagate = t1 - t0;
    this.timings.geodetic = performance.now() - t1;
  }

  /** Planes (from the first propagated state) and so the operational set. */
  classify() {
    orbitAngles(this.pos, this.vel, this.ok, this.raan, this.u);
    const pl = clusterPlanes(this.shellOf, this.shells.length, this.raan, this.u, this.ok);
    const inPlanes = new Array(this.shells.length).fill(0);
    for (let i = 0; i < this.n; i++) if (pl.planeOf[i] >= 0) inPlanes[this.shellOf[i]]++;
    markOperational(this.shells, inPlanes);
    const list = [];
    for (let i = 0; i < this.n; i++) {
      const s = this.shellOf[i];
      this.operational[i] = s >= 0 && this.shells[s].operational ? 1 : 0;
      this.use[i] = this.operational[i] && this.sats[i].laser ? 1 : 0;
      if (this.operational[i]) list.push(i);
    }
    this.opList = Int32Array.from(list);
    this.planes = pl;
  }

  /**
   * The gateways each operational satellite sees above `gwMask`, and its
   * exit: the one with the least downlink plus backhaul (fibre to the
   * gateway's PoP).
   */
  gatewayViews(gwMask = MODEL.gwMask) {
    const t0 = performance.now();
    const { pos, gateways } = this;
    let m = 0;
    const start = this.gwStart;
    start.fill(0);
    this.exitGw.fill(-1);
    this.exitMs.fill(Infinity);
    const sinMask = Math.sin((gwMask * Math.PI) / 180);
    for (const i of this.opList) {
      start[i] = m;
      if (!this.ok[i]) continue;
      const k = 3 * i;
      for (const g of gateways) {
        // Cheap reject: the satellite must be above the gateway's horizon plane by sin(mask).
        const dx = pos[k] - g.p[0], dy = pos[k + 1] - g.p[1], dz = pos[k + 2] - g.p[2];
        const up = dx * g.up[0] + dy * g.up[1] + dz * g.up[2];
        if (up <= 0) continue;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (up < sinMask * r) continue;
        if (m >= this.gwIdx.length) this.grow();
        this.gwIdx[m] = g.index;
        this.gwRange[m] = r;
        m++;
        const c = vacuumMs(r) + g.backhaulMs;
        if (c < this.exitMs[i]) (this.exitMs[i] = c), (this.exitGw[i] = g.index);
      }
      start[i + 1] = m;
    }
    // Close the CSR for satellites after the last operational one.
    let last = 0;
    for (let i = 0; i <= this.n; i++) (start[i] = Math.max(start[i], last)), (last = start[i]);
    this.gwCount = m;
    this.timings.gateways = performance.now() - t0;
  }

  grow() {
    const a = new Int32Array(this.gwIdx.length * 2);
    a.set(this.gwIdx);
    this.gwIdx = a;
    const b = new Float32Array(this.gwRange.length * 2);
    b.set(this.gwRange);
    this.gwRange = b;
  }

  /** The gateways satellite i sees: [{ g, range }] (after gatewayViews). */
  gatewaysOf(i) {
    const out = [];
    for (let k = this.gwStart[i]; k < this.gwStart[i + 1]; k++) out.push({ g: this.gwIdx[k], range: this.gwRange[k] });
    return out;
  }

  /** The operational satellites a site sees above `mask`: [{ i, el, range, terminal }], highest first. */
  inView(s, mask = MODEL.userMask) {
    const out = [];
    const look = [0, 0];
    const pos = this.pos;
    const sinMask = Math.sin((mask * Math.PI) / 180);
    for (const i of this.opList) {
      if (!this.ok[i]) continue;
      const k = 3 * i;
      const dx = pos[k] - s.p[0], dy = pos[k + 1] - s.p[1], dz = pos[k + 2] - s.p[2];
      const up = dx * s.up[0] + dy * s.up[1] + dz * s.up[2];
      if (up <= 0 || up * up < sinMask * sinMask * (dx * dx + dy * dy + dz * dz)) continue;
      lookAt(s, pos, k, look);
      out.push({ i, el: look[0], range: look[1], terminal: this.exitGw[i] >= 0 });
    }
    return out.sort((a, b) => b.el - a.el);
  }

  /**
   * The +Grid: rebuilt at each 15 s slot (planes re-clustered from the
   * current orbits), and each tick its links' lengths and whether they're up
   * (in range, clear of the Earth), with their light time as weights.
   */
  mesh(opts = {}) {
    const o = { ...MODEL, ...opts };
    const slot = slotOf(this.t, o);
    if (slot !== this.gridSlot || !this.grid) {
      const t0 = performance.now();
      orbitAngles(this.pos, this.vel, this.ok, this.raan, this.u);
      const ok = this.ok.map((x, i) => (x && this.operational[i] ? 1 : 0));
      this.planes = clusterPlanes(this.shellOf, this.shells.length, this.raan, this.u, ok);
      const use = this.use.map((x, i) => (x && this.ok[i] ? 1 : 0));
      this.grid = buildGrid(this.planes, use, this.pos, o);
      this.gridSlot = slot;
      this.len = new Float64Array(this.grid.n);
      this.up = new Uint8Array(this.grid.n);
      this.w = new Float64Array(this.grid.n);
      this.timings.meshBuild = performance.now() - t0;
    }
    const t1 = performance.now();
    this.linksUp = refreshGrid(this.grid, this.pos, this.len, this.up, o);
    for (let e = 0; e < this.grid.n; e++) this.w[e] = vacuumMs(this.len[e]);
    this.timings.meshRefresh = performance.now() - t1;
  }

  /**
   * Routes down: Dijkstra over the links that are up, from every satellite
   * with lasers that sees a gateway (starting at its downlink plus backhaul).
   */
  route() {
    const t0 = performance.now();
    const adj = adjacency(this.n, this.grid.a, this.grid.b, this.up, this.grid.n);
    const src = [];
    for (const i of this.opList) if (this.use[i] && this.ok[i] && this.exitGw[i] >= 0) src.push([i, this.exitMs[i]]);
    this.tree = dijkstra(adj, this.w, src);
    this.terminals = src.length;
    this.timings.route = performance.now() - t0;
  }

  /** The cost (ms) of serving from satellite v (in view) over lasers: uplink plus its path down. */
  laserCost = (v) => (this.tree && this.use[v.i] && Number.isFinite(this.tree.dist[v.i]) ? vacuumMs(v.range) + this.tree.dist[v.i] : Infinity);

  /** The serving pick for a site (no slot hold): the traffic estimate's. */
  serve(s, mask) {
    return pickServing(this.inView(s, mask), { laserCost: this.tree ? this.laserCost : null });
  }

  /**
   * The traffic estimate, assigned once a slot: each customer region's
   * demand on its serving satellite, down a bent pipe or over the lasers,
   * summed per link, feeder and gateway.
   */
  assign(opts = {}) {
    const o = { ...MODEL, ...opts };
    const slot = slotOf(this.t, o);
    if (this.traffic && this.trafficSlot === slot && this.traffic.gridSlot === this.gridSlot) return this.traffic;
    const t0 = performance.now();
    const r = assignTraffic(this.demand, { serve: (p) => this.serve(p.s, o.userMask), tree: this.tree, exitGw: this.exitGw, nLinks: this.grid.n, nGateways: this.gateways.length });
    r.gridSlot = this.gridSlot;
    this.traffic = r;
    this.trafficSlot = slot;
    this.timings.traffic = performance.now() - t0;
    return r;
  }

  /**
   * The mesh for drawing, from this tick's positions: its line segments
   * { seg: Float32Array (lon, lat, alt m at each end), col: Uint8Array (RGBA
   * at each end), n }, and a point for every satellite at an end of one,
   * { pts: Float32Array (lon, lat, alt m), pcol: Uint8Array (RGBA), np },
   * written from the very same numbers, so every segment starts and ends on
   * a drawn satellite. Links that are down are left out; with `view` ({ lon,
   * lat, radius }, degrees) so are links whose middle is farther than
   * `radius` from it (the globe's far side, or off screen when zoomed in).
   * `view.flat` (the 2D map): altitudes 0, and longitudes unwrapped to within
   * 180° of `view.ref` (the dish's, or the camera's), each link's second end
   * to within 180° of its first, so lines take the short way and meet the
   * section's other points in the same copy of the world.
   */
  meshLines(view = null) {
    const flat = !!view?.flat;
    const ref = flat && Number.isFinite(view.ref) ? view.ref : null;
    if (view && !(view.radius < 180)) view = null; // nothing to cull
    const g = this.grid, geo = this.geo;
    const seg = new Float32Array(6 * g.n), col = new Uint8Array(8 * g.n);
    const cosR = view ? Math.cos((view.radius * Math.PI) / 180) : -2;
    const vx = view ? Math.cos((view.lat * Math.PI) / 180) * Math.cos((view.lon * Math.PI) / 180) : 0;
    const vy = view ? Math.cos((view.lat * Math.PI) / 180) * Math.sin((view.lon * Math.PI) / 180) : 0;
    const vz = view ? Math.sin((view.lat * Math.PI) / 180) : 0;
    const pal = this.shells.map((sh) => shellColour(sh.incl));
    const near = (lon, to) => lon + 360 * Math.round((to - lon) / 360);
    // One point per (satellite, copy of the world) at an end of a drawn link.
    const pts = new Float32Array(3 * 2 * g.n), pcol = new Uint8Array(4 * 2 * g.n);
    const seen = new Map();
    let np = 0;
    const point = (i, lon, lat, alt) => {
      const key = i * 16 + 8 + Math.round((lon - geo[3 * i]) / 360);
      if (seen.has(key)) return;
      seen.set(key, np);
      pts[3 * np] = lon;
      pts[3 * np + 1] = lat;
      pts[3 * np + 2] = alt;
      const c = pal[this.shellOf[i]];
      pcol.set([c[0], c[1], c[2], 230], 4 * np);
      np++;
    };
    let k = 0;
    for (let e = 0; e < g.n; e++) {
      if (!this.up[e]) continue;
      const i = g.a[e], j = g.b[e];
      if (view) {
        const mx = this.pos[3 * i] + this.pos[3 * j], my = this.pos[3 * i + 1] + this.pos[3 * j + 1], mz = this.pos[3 * i + 2] + this.pos[3 * j + 2];
        if ((mx * vx + my * vy + mz * vz) / Math.sqrt(mx * mx + my * my + mz * mz) < cosR) continue;
      }
      const lon0 = ref === null ? geo[3 * i] : near(geo[3 * i], ref);
      const lon1 = near(geo[3 * j], lon0);
      const q = 6 * k;
      seg[q] = lon0;
      seg[q + 1] = geo[3 * i + 1];
      seg[q + 2] = flat ? 0 : geo[3 * i + 2];
      seg[q + 3] = lon1;
      seg[q + 4] = geo[3 * j + 1];
      seg[q + 5] = flat ? 0 : geo[3 * j + 2];
      point(i, seg[q], seg[q + 1], seg[q + 2]);
      point(j, seg[q + 3], seg[q + 4], seg[q + 5]);
      const c = pal[this.shellOf[i]];
      const a = g.kind[e] === 1 ? 84 : 132;
      col.set([c[0], c[1], c[2], a, c[0], c[1], c[2], a], 8 * k); // per vertex
      k++;
    }
    return { seg, col, n: k, pts, pcol, np, t: this.t };
  }

  /**
   * The traffic estimate's lines for drawing: loaded laser links and feeder
   * links (satellite → gateway), with their load relative to the most loaded
   * link of their kind (0..1]: { links: { seg, load, n }, feeders: { seg,
   * load, n }, gateways: [{ g, load (share of all), rel }], stats }.
   */
  trafficLines(tr) {
    const g = this.grid, geo = this.geo;
    let maxL = 0, nL = 0;
    for (let e = 0; e < g.n; e++) if (tr.link[e] > 0 && this.up[e]) (nL++, tr.link[e] > maxL && (maxL = tr.link[e]));
    const lseg = new Float32Array(6 * nL), lload = new Float32Array(nL);
    let k = 0;
    const put = (seg, at, lon, lat, alt) => {
      seg[at] = lon;
      seg[at + 1] = lat;
      seg[at + 2] = alt;
    };
    for (let e = 0; e < g.n; e++) {
      if (!(tr.link[e] > 0) || !this.up[e]) continue;
      const i = g.a[e], j = g.b[e];
      let lon1 = geo[3 * j];
      if (lon1 - geo[3 * i] > 180) lon1 -= 360;
      else if (lon1 - geo[3 * i] < -180) lon1 += 360;
      put(lseg, 6 * k, geo[3 * i], geo[3 * i + 1], geo[3 * i + 2]);
      put(lseg, 6 * k + 3, lon1, geo[3 * j + 1], geo[3 * j + 2]);
      lload[k++] = tr.link[e] / maxL;
    }
    const feeders = [...tr.feeder.values()].filter((f) => this.ok[f.sat]);
    let maxF = 0;
    for (const f of feeders) maxF = Math.max(maxF, f.load);
    const fseg = new Float32Array(6 * feeders.length), fload = new Float32Array(feeders.length);
    feeders.forEach((f, m) => {
      const gw = this.gateways[f.gw];
      let lon = gw.lon;
      if (lon - geo[3 * f.sat] > 180) lon -= 360;
      else if (lon - geo[3 * f.sat] < -180) lon += 360;
      put(fseg, 6 * m, geo[3 * f.sat], geo[3 * f.sat + 1], geo[3 * f.sat + 2]);
      put(fseg, 6 * m + 3, lon, gw.lat, 9e3);
      fload[m] = f.load / maxF;
    });
    let maxG = 0;
    for (const x of tr.gateway) maxG = Math.max(maxG, x);
    const gws = [];
    const served = tr.bent + tr.laser;
    tr.gateway.forEach((x, gi) => x > 0 && gws.push({ g: gi, name: this.gateways[gi].name, lon: this.gateways[gi].lon, lat: this.gateways[gi].lat, share: x / served, rel: x / maxG }));
    gws.sort((a, b) => b.share - a.share);
    return {
      links: { seg: lseg, load: lload, n: nL },
      feeders: { seg: fseg, load: fload, n: feeders.length },
      gateways: gws,
      stats: { total: tr.total, bent: tr.bent / tr.total, laser: tr.laser / tr.total, unserved: tr.unserved / tr.total, hops: tr.hops, regions: this.demand.length, loadedLinks: nL },
    };
  }

  /** A satellite for the panel and the map. */
  satInfo(i) {
    const s = this.sats[i];
    const sh = this.shells[this.shellOf[i]];
    return {
      i,
      norad: s.norad,
      name: s.name,
      cospar: s.id,
      laser: s.laser,
      shell: sh ? sh.label : null,
      plane: this.planes?.planeOf[i] ?? -1,
      operational: !!this.operational[i],
      lon: this.geo[3 * i],
      lat: this.geo[3 * i + 1],
      alt: this.geo[3 * i + 2],
      epoch: s.epoch,
    };
  }

  /**
   * The modelled links for a dish at lon/lat at time `ms`: { t, slot, user,
   * visible, serving, gateways (in the serving satellite's view), exit,
   * latency } (see the section for the fields). `opts`: userMask, gwMask,
   * pin (a catalog number to serve from if it's in view).
   */
  dish(lon, lat, opts = {}) {
    const o = { ...MODEL, ...opts };
    const s = site(lon, lat, 0);
    const slot = slotOf(this.t, o);
    const visible = this.inView(s, o.userMask);
    const pinned = o.pin != null ? visible.find((v) => this.sats[v.i].norad === o.pin) : null;
    let pick = null;
    if (pinned) pick = { i: pinned.i, rule: 'pinned' };
    else {
      const h = this.held;
      const keep = h && h.slot === slot && h.lon === lon && h.lat === lat && visible.find((v) => this.sats[v.i].norad === h.norad);
      // Held for its slot while it stays in view and keeps its way down.
      const still = keep && (h.rule === 'bent-pipe' ? keep.terminal : h.rule === 'laser' ? Number.isFinite(this.laserCost(keep)) : !keep.terminal);
      if (still) pick = { i: keep.i, rule: h.rule, held: true };
      else pick = pickServing(visible, { laserCost: this.tree ? this.laserCost : null });
    }
    if (pick && pick.rule !== 'pinned') this.held = { norad: this.sats[pick.i].norad, slot, rule: pick.rule, lon, lat };
    const out = { t: this.t, slot, user: { lon, lat }, mask: o.userMask, gwMask: o.gwMask, visible: visible.slice(0, 60).map((v) => ({ ...v, norad: this.sats[v.i].norad, name: this.sats[v.i].name, shell: this.shells[this.shellOf[v.i]]?.label ?? null, lon: this.geo[3 * v.i], lat: this.geo[3 * v.i + 1], alt: this.geo[3 * v.i + 2] })), nVisible: visible.length, nTerminal: visible.filter((v) => v.terminal).length, serving: null, gateways: [], exit: null, latency: null };
    if (!pick) return out;
    const v = visible.find((x) => x.i === pick.i);
    out.serving = { ...this.satInfo(pick.i), el: v.el, range: v.range, az: azimuth(s, this.pos, 3 * pick.i), rule: pick.rule, held: !!pick.held, footprint: coverageAngle(this.geo[3 * pick.i + 2] / 1000, o.gwMask) };
    out.gateways = this.gatewaysOf(pick.i).map(({ g, range }) => this.gatewayLeg(g, range));
    out.gateways.sort((a, b) => a.ms - b.ms);
    const up = vacuumMs(v.range);
    // Where the traffic goes down: here (a bent pipe), or at the end of its laser path.
    let down = pick.i, isl = 0, islKm = 0, hops = 0;
    if (this.tree && this.tree.root[pick.i] >= 0 && !(out.gateways.length && pick.rule !== 'laser')) {
      const p = pathFrom(this.tree, pick.i);
      down = p.nodes[p.nodes.length - 1];
      hops = p.edges.length;
      for (const e of p.edges) (isl += this.w[e]), (islKm += this.len[e]);
      if (hops) out.route = { hops, km: islKm, ms: isl, sats: p.nodes.map((i) => ({ ...this.satInfo(i), terminal: i === down })) };
    }
    const legs = down === pick.i ? out.gateways : this.gatewaysOf(down).map(({ g, range }) => this.gatewayLeg(g, range)).sort((a, b) => a.ms - b.ms);
    if (legs.length) {
      const e = legs[0];
      out.exit = { ...e, sat: down === pick.i ? null : this.satInfo(down) };
      out.latency = { up, isl, down: vacuumMs(e.range), backhaul: e.backhaulMs, total: up + isl + vacuumMs(e.range) + e.backhaulMs, hops };
      // Compared with fibre at c/1.47 along the great circle, to the PoP and to a destination.
      if (e.popLon !== null) {
        out.fibre = { pop: { km: gcKm(lon, lat, e.popLon, e.popLat), ms: fibreMs(gcKm(lon, lat, e.popLon, e.popLat)) } };
        const dst = o.dest != null ? this.pops[o.dest] : null;
        if (dst && Number.isFinite(dst.lon)) {
          const onward = gcKm(e.popLon, e.popLat, dst.lon, dst.lat);
          const direct = gcKm(lon, lat, dst.lon, dst.lat);
          out.fibre.dest = { code: dst.code, city: dst.city, onwardKm: onward, viaMs: out.latency.total + fibreMs(onward), directKm: direct, directMs: fibreMs(direct) };
        }
      }
    }
    return out;
  }

  /** A gateway seen at `range` km: the downlink leg and its backhaul to the PoP. */
  gatewayLeg(g, range) {
    const gw = this.gateways[g];
    const p = this.pops[gw.pop];
    return { g, id: gw.id, name: gw.name, lon: gw.lon, lat: gw.lat, range, pop: gw.pop, popCode: p?.code ?? null, popCity: p?.city ?? null, popLon: p?.lon ?? null, popLat: p?.lat ?? null, backhaulKm: gw.backhaulKm, backhaulMs: gw.backhaulMs, ms: vacuumMs(range) + gw.backhaulMs };
  }

  /** Counts for the panel. */
  summary() {
    let laser = 0, op = 0;
    for (const i of this.opList) (op++, this.sats[i].laser && laser++);
    return {
      sats: this.n,
      operational: op,
      laser,
      links: this.grid?.n ?? 0,
      linksUp: this.linksUp,
      terminals: this.terminals ?? 0,
      demand: this.demand.length,
      shells: this.shells.map((s) => ({ ...s, inService: !!s.operational })),
      planes: this.planes?.planes.length ?? 0,
      gateways: this.gateways.length,
    };
  }
}
