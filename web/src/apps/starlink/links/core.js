// The model's message handler, the same on a worker and on the main thread:
// init builds the model; tick propagates to a time and answers for a dish, a
// selected satellite, the laser mesh and the traffic estimate. DOM-free.
// worker.js runs it in a Web Worker; engine.js falls back to calling it
// directly.

import { LinkModel } from './model.js';
import { temeAt, temeToEcef } from './orbit.js';

/**
 * How far the model's satellites are from where celestiary's Orbits layer
 * drew them: `anchors` [{ id: 'norad:<n>', lon, lat }] at `t`. The angle
 * between the two directions, times the model's radius: km on the sky,
 * mostly along the track (the layer's anchors are spherical, so altitude
 * isn't compared). Returns { n, maxKm, meanKm } or null.
 */
export function checkAnchors(model, { t, anchors }) {
  const D = Math.PI / 180;
  const km = [];
  for (const a of anchors ?? []) {
    const i = model.byNorad.get(Number(String(a.id).replace(/^norad:/, '')));
    if (i === undefined || !Number.isFinite(a.lon)) continue;
    const pv = temeAt(model.sats[i], t);
    if (!pv) continue;
    const p = temeToEcef(pv.position, t);
    const r = Math.hypot(p[0], p[1], p[2]);
    const u = [Math.cos(a.lat * D) * Math.cos(a.lon * D), Math.cos(a.lat * D) * Math.sin(a.lon * D), Math.sin(a.lat * D)];
    const c = Math.max(-1, Math.min(1, (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / r));
    km.push(Math.acos(c) * r);
  }
  return km.length ? { n: km.length, maxKm: Math.max(...km), meanKm: km.reduce((x, y) => x + y, 0) / km.length } : null;
}

/** The typed arrays in a tick's result, to transfer rather than copy. */
export function transferables(r) {
  const out = [];
  if (r?.mesh) out.push(r.mesh.seg.buffer, r.mesh.col.buffer, r.mesh.pts.buffer, r.mesh.pcol.buffer);
  if (r?.traffic) out.push(r.traffic.links.seg.buffer, r.traffic.links.load.buffer, r.traffic.feeders.seg.buffer, r.traffic.feeders.load.buffer);
  return out;
}

export function createCore() {
  let model = null;
  return {
    /** { omm, gateways, pops, regions } -> { timings } */
    init(msg) {
      model = new LinkModel(msg);
      return { timings: { ...model.timings } };
    },
    /**
     * { t, dish: { lon, lat } | null, sat: norad | null, opts, mesh, traffic,
     * view } -> { t, dish, sat, mesh, traffic, summary, timings }. The laser
     * mesh and the routes down are computed whenever a dish or the mesh or
     * traffic layer needs them; `mesh` and `traffic` are only drawn when asked.
     */
    tick(msg) {
      if (!model) throw new Error('tick before init');
      const t0 = performance.now();
      const o = { ...msg.opts };
      model.propagate(msg.t);
      model.gatewayViews(o.gwMask);
      const lasers = !!(msg.dish || msg.mesh || msg.traffic);
      if (lasers) {
        model.mesh(o);
        model.route();
      }
      const dish = msg.dish ? model.dish(msg.dish.lon, msg.dish.lat, { ...o, pin: msg.sat ?? null }) : null;
      let sat = null;
      const i = msg.sat != null ? model.byNorad.get(msg.sat) : undefined;
      if (i !== undefined) sat = { ...model.satInfo(i), gateways: model.gatewaysOf(i).map(({ g, range }) => model.gatewayLeg(g, range)) };
      const mesh = msg.mesh ? model.meshLines(msg.view ?? null) : null;
      let traffic = null;
      if (msg.traffic) {
        const t1 = performance.now();
        traffic = model.trafficLines(model.assign(o));
        model.timings.trafficLines = performance.now() - t1;
      }
      const check = msg.check ? checkAnchors(model, msg.check) : null;
      const timings = { ...model.timings, tick: performance.now() - t0 };
      return { t: msg.t, dish, sat, missingSat: msg.sat != null && i === undefined, mesh, traffic, check, summary: model.summary(), timings };
    },
  };
}
