// The RIPE Atlas section's deck.gl layers (ctx.layers): the probes, coloured
// by PoP, each with a line to its PoP, and the selected probe's traceroute.
// Probes are places, so they show only in the geo layout (env.geographic).

import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { greatCircle } from './arc.js';

const GLOBE = { depthCompare: 'less-equal', depthWriteEnabled: false };
const FLAT = { depthCompare: 'always' };
const PROBE_ALT = 3000; // m: just off the globe's surface
export const ROLE_COLOURS = {
  lan: [200, 200, 210],
  pop: [255, 210, 80],
  starlink: [90, 200, 255],
  internet: [190, 140, 255],
  dest: [120, 230, 140],
};

/** Paths for both views, made once: { flat: [[lon, lat]...], globe: [[lon, lat, alt]...] }. */
export function bothPaths(points, lift = 0.06) {
  const flat = points.map(([lon, lat]) => [lon, lat]);
  const globe = [];
  for (let k = 1; k < points.length; k++) {
    const seg = greatCircle(points[k - 1], points[k], { stepDeg: 1.5, lift });
    globe.push(...(k > 1 ? seg.slice(1) : seg));
  }
  return { flat, globe: globe.length ? globe : points };
}

/**
 * The probes' group: (env) => layers. `probes` [{ id, lon, lat, colour,
 * pop: { lon, lat } | null }], `selected` an id or null, `onPick(id)`.
 * Data arrays are built once per call, so deck sees the same objects
 * between renders.
 */
export function probeGroup({ probes, selected, onPick }) {
  const located = probes.filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  const links = located
    .filter((p) => p.pop && Number.isFinite(p.pop.lon))
    .map((p) => ({ id: p.id, colour: p.colour, ...bothPaths([[p.lon, p.lat, PROBE_ALT], [p.pop.lon, p.pop.lat, PROBE_ALT]], 0.03) }));
  const pops = [...new Map(located.filter((p) => p.pop && Number.isFinite(p.pop.lon)).map((p) => [p.pop.code, { ...p.pop, colour: p.colour }])).values()];
  const sel = located.filter((p) => p.id === selected);
  return (env) => {
    if (!env.geographic) return [];
    const parameters = env.globe ? GLOBE : FLAT;
    const at = (lon, lat) => [lon, lat, env.globe ? PROBE_ALT : 0];
    return [
      new PathLayer({
        id: 'links',
        data: links,
        getPath: env.globe ? (d) => d.globe : (d) => d.flat,
        getColor: (d) => [...d.colour, d.id === selected ? 230 : 110],
        getWidth: (d) => (d.id === selected ? 2.5 : 1),
        widthUnits: 'pixels',
        updateTriggers: { getColor: selected, getWidth: selected, getPath: env.globe },
        parameters,
      }),
      new ScatterplotLayer({
        id: 'pops',
        data: pops,
        getPosition: (d) => at(d.lon, d.lat),
        getRadius: 5,
        radiusUnits: 'pixels',
        stroked: true,
        filled: true,
        getFillColor: [10, 12, 18, 220],
        getLineColor: (d) => d.colour,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        pickable: true,
        updateTriggers: { getPosition: env.globe },
        parameters,
      }),
      new ScatterplotLayer({
        id: 'probes',
        data: located,
        getPosition: (d) => at(d.lon, d.lat),
        getRadius: (d) => (d.id === selected ? 6 : 3.5),
        radiusUnits: 'pixels',
        stroked: true,
        getFillColor: (d) => [...d.colour, 235],
        getLineColor: (d) => (d.id === selected ? [255, 255, 255, 255] : [0, 0, 0, 160]),
        lineWidthUnits: 'pixels',
        getLineWidth: (d) => (d.id === selected ? 2 : 1),
        pickable: true,
        onClick: (info) => info.object && onPick(info.object.id),
        updateTriggers: { getRadius: selected, getLineColor: selected, getLineWidth: selected, getPosition: env.globe },
        parameters,
      }),
      sel.length &&
        new ScatterplotLayer({
          id: 'halo',
          data: sel,
          getPosition: (d) => at(d.lon, d.lat),
          getRadius: 14,
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          getLineColor: [255, 255, 255, 200],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          updateTriggers: { getPosition: env.globe },
          parameters,
        }),
    ];
  };
}

/**
 * The traceroute's group: (env) => layers. `stops(env)` -> [{ pos: [lon,
 * lat, alt], role, hops, label }] (cached by the caller per layout), drawn
 * as a path of segments coloured by the role they lead to.
 */
export function traceGroup(stops) {
  const cache = new Map(); // stops array -> { segs, globe }
  return (env) => {
    if (!env.geographic) return [];
    const s = stops(env);
    if (!s?.length) return [];
    if (!cache.has(s)) {
      cache.clear();
      const segs = [];
      for (let k = 1; k < s.length; k++) {
        const a = [s[k - 1].pos[0], s[k - 1].pos[1], s[k - 1].pos[2] ?? PROBE_ALT];
        const b = [s[k].pos[0], s[k].pos[1], s[k].pos[2] ?? PROBE_ALT];
        segs.push({ colour: ROLE_COLOURS[s[k].role] ?? [255, 255, 255], ...bothPaths([a, b], 0.08) });
      }
      cache.set(s, segs);
    }
    const segs = cache.get(s);
    const parameters = env.globe ? GLOBE : FLAT;
    return [
      new PathLayer({
        id: 'casing',
        data: segs,
        getPath: env.globe ? (d) => d.globe : (d) => d.flat,
        getColor: [0, 0, 0, 170],
        getWidth: 7,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getPath: env.globe },
        parameters,
      }),
      new PathLayer({
        id: 'path',
        data: segs,
        getPath: env.globe ? (d) => d.globe : (d) => d.flat,
        getColor: (d) => [...d.colour, 230],
        getWidth: 3,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getPath: env.globe },
        parameters,
      }),
      new ScatterplotLayer({
        id: 'stops',
        data: s,
        getPosition: (d) => (env.globe ? [d.pos[0], d.pos[1], d.pos[2] ?? PROBE_ALT] : [d.pos[0], d.pos[1], 0]),
        getRadius: 6,
        radiusUnits: 'pixels',
        stroked: true,
        getFillColor: (d) => [...(ROLE_COLOURS[d.role] ?? [255, 255, 255]), 255],
        getLineColor: [0, 0, 0, 220],
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        pickable: true,
        updateTriggers: { getPosition: env.globe },
        parameters,
      }),
    ];
  };
}
