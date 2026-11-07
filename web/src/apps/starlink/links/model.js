// The link model: the constellation propagated to a time, which satellites a
// dish sees, the one that serves it, the gateways that satellite sees, the
// gateway the traffic comes down at and the PoP behind it, and the latency
// of each leg. DOM-free and synchronous: the worker (worker.js) runs it off
// the main thread, node's tests run it directly. Everything here is a model;
// the section labels it so, with these assumptions (MODEL, below).

import { ecefToGeodetic, propagateAll, satellites } from './orbit.js';
import { clusterPlanes, clusterShells, markOperational, orbitAngles } from './shells.js';
import { azimuth, coverageAngle, fibreMs, gcKm, lookAt, site, vacuumMs } from './geometry.js';

export const MODEL = {
  userMask: 25, // ° minimum elevation from a dish (FCC 21-48, 2021: 40° → 25°)
  gwMask: 25, // ° minimum elevation from a gateway (assumed)
  slotMs: 15000, // the scheduler's 15 s slots (arXiv 2307.00402)
  slotOffsetMs: 12000, // they start at :12, :27, :42 and :57 past the minute
};

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
  constructor({ omm, gateways = [], pops = [] }) {
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
   * pin (a NORAD id to serve from if it's in view).
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
      // Held for its slot while it stays in view (and keeps its gateway, if it went down to one).
      if (keep && (h.rule !== 'bent-pipe' || keep.terminal)) pick = { i: keep.i, rule: h.rule, held: true };
      else pick = pickServing(visible, { laserCost: o.laserCost ?? null });
    }
    if (pick && pick.rule !== 'pinned') this.held = { norad: this.sats[pick.i].norad, slot, rule: pick.rule, lon, lat };
    const out = { t: this.t, slot, user: { lon, lat }, mask: o.userMask, gwMask: o.gwMask, visible: visible.slice(0, 60).map((v) => ({ ...v, norad: this.sats[v.i].norad, lon: this.geo[3 * v.i], lat: this.geo[3 * v.i + 1], alt: this.geo[3 * v.i + 2] })), nVisible: visible.length, nTerminal: visible.filter((v) => v.terminal).length, serving: null, gateways: [], exit: null, latency: null };
    if (!pick) return out;
    const v = visible.find((x) => x.i === pick.i);
    out.serving = { ...this.satInfo(pick.i), el: v.el, range: v.range, az: azimuth(s, this.pos, 3 * pick.i), rule: pick.rule, held: !!pick.held, footprint: coverageAngle(this.geo[3 * pick.i + 2] / 1000, o.gwMask) };
    out.gateways = this.gatewaysOf(pick.i).map(({ g, range }) => this.gatewayLeg(g, range));
    out.gateways.sort((a, b) => a.ms - b.ms);
    const up = vacuumMs(v.range);
    if (out.gateways.length) {
      const e = out.gateways[0];
      out.exit = e;
      out.latency = { up, isl: 0, down: vacuumMs(e.range), backhaul: e.backhaulMs, total: up + vacuumMs(e.range) + e.backhaulMs, hops: 0 };
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
      shells: this.shells.map((s) => ({ ...s, inService: !!s.operational })),
      planes: this.planes?.planes.length ?? 0,
      gateways: this.gateways.length,
    };
  }
}
