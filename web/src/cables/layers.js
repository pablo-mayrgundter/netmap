// deck.gl layers for the cable network and the fibers pinned into it
// (net.js): each span a casing that carries its fibers side by side as
// coloured lanes, stations as white subway-map stops wide enough for the
// lanes through them, and from each station a fan of lines out to the
// fibers' own ends (the transmitters and receivers of a CWDM link, with the
// station as its mux).

import { PathStyleExtension } from '@deck.gl/extensions';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { lineColour } from './net.js';

const D2R = Math.PI / 180;
// Cables float this high over the globe's surface, under the floating
// networks: high enough that the globe's mesh can't z-fight a lane where it
// bends (a wide billboarded line's joins reach out past its centreline).
export const LIFT_M = 30000;
export const LANE_SPACING = 1.35; // lane pitch, in lane widths

const offsetExt = new PathStyleExtension({ offset: true });

// Data objects are memoised on what they're made from, so deck sees the same
// reference while only the camera moves.
const cache = new WeakMap();
function once(owner, key, make) {
  let m = cache.get(owner);
  if (!m) cache.set(owner, (m = new Map()));
  if (!m.has(key)) m.set(key, make());
  return m.get(key);
}

const withAlt = (path, z) => path.map(([x, y]) => [x, y, z]);

// A fan line from a fiber's end (at its altitude on the globe) down to its
// station, along the great circle so it doesn't dip under the globe.
function fanPath(end, node, globe) {
  const a = [end[0], end[1]];
  const b = [node.lon, node.lat];
  const ua = [Math.cos(a[1] * D2R) * Math.cos(a[0] * D2R), Math.cos(a[1] * D2R) * Math.sin(a[0] * D2R), Math.sin(a[1] * D2R)];
  const ub = node.u;
  const ang = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2])));
  const n = globe ? Math.max(1, Math.ceil(ang / (2 * D2R))) : 1;
  const s = Math.sin(ang);
  const z0 = globe ? end[2] || 0 : 0;
  const z1 = globe ? LIFT_M : 0;
  const out = [];
  let prev = a[0];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = s < 1e-9 ? 1 - t : Math.sin((1 - t) * ang) / s;
    const q = s < 1e-9 ? t : Math.sin(t * ang) / s;
    const x = p * ua[0] + q * ub[0], y = p * ua[1] + q * ub[1], zz = p * ua[2] + q * ub[2];
    let lon = Math.atan2(y, x) / D2R;
    lon += 360 * Math.round((prev - lon) / 360);
    prev = lon;
    // a gentle lift, so a fan from a floating network reads as one sweep
    const lift = globe ? Math.sin(Math.PI * t) * Math.min(ang * 6.371e6 * 0.05, 60e3) : 0;
    out.push([lon, Math.atan2(zz, Math.hypot(x, y)) / D2R, z0 + (z1 - z0) * t + lift]);
  }
  return out;
}

/** The data the layers draw, from a lane layout (net.js layoutLanes). */
export function cableScene(net, fibers, routes, L, globe) {
  return once(L, globe, () => {
    const z = globe ? LIFT_M : 0;
    // Each lane has two colours: its line's (a subway map's) and its links'
    // (their regions', as the plain links and fibers are drawn); cableLayers
    // mixes them by zoom. A corridor's glow is its lanes' links' colour.
    const lanes = [];
    const corridors = net.corridors.map((c) => {
      const path3 = withAlt(c.path, z);
      const glow = [0, 0, 0];
      for (const l of L.lanes[c.id]) {
        const f = fibers[l.fiber];
        lanes.push({ path: path3, offset: l.offset, fiber: l.fiber, c: c.id, line: lineColour(f), link: f.color });
        for (let k = 0; k < 3; k++) glow[k] += f.color[k] / L.lanes[c.id].length;
      }
      return { ...c, path3, lanes: L.width[c.id], overflow: L.overflow[c.id], glow };
    });
    const fans = [];
    const ends = [];
    const fanned = new Uint32Array(net.nodes.length); // fibers that leave the cables here
    for (let i = 0; i < fibers.length; i++) {
      if (!L.drawn[i]) continue;
      const r = routes[i];
      const line = lineColour(fibers[i]);
      const link = fibers[i].color;
      fanned[r.from]++, fanned[r.to]++;
      for (const [end, node] of [[fibers[i].source, r.from], [fibers[i].target, r.to]]) {
        fans.push({ path: fanPath(end, net.nodes[node], globe), fiber: i, line, link });
        ends.push({ position: globe ? end : [end[0], end[1], 0], fiber: i, line, link });
      }
    }
    // A stop is a mux (as wide as the lanes through it) where lines branch:
    // three or more spans meet, or fibers fan out to their ends. Elsewhere
    // the lanes run through a small stop, as an express train passes one.
    const lanesAt = net.nodes.map(() => 0);
    for (const c of net.corridors) if (L.width[c.id]) lanesAt[c.a]++, lanesAt[c.b]++;
    const stations = net.nodes.map((n, i) => ({ ...n, i, position: [n.lon, n.lat, z], lanes: L.nodeWidth[i], mux: L.nodeWidth[i] > 0 && (lanesAt[i] > 2 || fanned[i] > 0), fanned: fanned[i] }));
    const busy = stations.filter((s) => s.lanes > 0);
    return { corridors, lanes, fans, ends, stations, busy };
  });
}

// The stations of `scene[key]` that face the camera, as the same array while
// that set doesn't change (deck compares data by reference).
const facingCache = new WeakMap();
function visibleOf(scene, key, facing) {
  const all = scene[key];
  const mask = all.map((s) => (facing(s) ? 1 : 0)).join('');
  let m = facingCache.get(scene);
  if (!m) facingCache.set(scene, (m = {}));
  if (m[key]?.mask !== mask) m[key] = { mask, list: all.filter((_, i) => mask[i] === '1') };
  return m[key].list;
}

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * How much of the subway map's look the cables take at a zoom (0..1): about a
 * third at world scale, where they should read as the links do (glowing, in
 * their regions' colours), two thirds close up, where the lines and stops
 * help you follow them.
 */
export const subwayAt = (zoom) => Math.round(20 * Math.max(0.3, Math.min(0.7, 0.3 + (zoom - 2) * 0.1))) / 20;

/**
 * The layers. `laneW` is a lane's width in pixels; `labels` shows the busy
 * stations' names; `blend` is the links' blending (additive with glow on),
 * which the lanes, fans and glow share; `subway` is subwayAt(zoom).
 */
export function cableLayers(scene, { laneW, labels, globe, blend, subway = 0.5, showFibers = true, facing = null }) {
  const params = { depthWriteEnabled: false, depthCompare: globe ? 'less-equal' : 'always' };
  const glowParams = blend || params;
  // Stops and their names are billboards wider than the globe is flat under
  // them, so the depth test would cut them; on the globe they're drawn over
  // it, and those on the far side (`facing` false) left out.
  const top = { depthWriteEnabled: false, depthCompare: 'always' };
  const stations = facing ? visibleOf(scene, 'stations', facing) : scene.stations;
  const busy = facing ? visibleOf(scene, 'busy', facing) : scene.busy;
  const k = subway;
  const trunkW = (c) => c.lanes * laneW * LANE_SPACING;
  const common = { widthUnits: 'pixels', billboard: globe, parameters: params, jointRounded: true, capRounded: true };
  const trig = `${laneW}|${showFibers}|${k}`;
  const colour = (d, a) => [...mix(d.link, d.line, k), a];
  const carrying = (c) => showFibers && c.lanes > 0;
  const layers = [
    // The cable. Carrying fibers: a soft glow in its links' colour, over a
    // dark casing that firms up as you zoom in (the fibre run of a WDM
    // diagram). Empty: a faint line, blue at sea and amber overland.
    new PathLayer({
      ...common,
      id: 'cable-casing',
      data: scene.corridors,
      getPath: (c) => c.path3,
      getWidth: (c) => (carrying(c) ? trunkW(c) + 1.5 : 1),
      getColor: (c) => (carrying(c) ? [6, 9, 15, Math.round(230 * k)] : c.kind === 'sub' ? [70, 170, 225, 90] : [225, 170, 90, 75]),
      updateTriggers: { getWidth: trig, getColor: trig },
    }),
    new PathLayer({
      ...common,
      id: 'cable-corridors',
      data: scene.corridors,
      getPath: (c) => c.path3,
      getWidth: (c) => (carrying(c) ? trunkW(c) + 4 : 0),
      getColor: (c) => [...c.glow, Math.round(70 * (1 - k))],
      parameters: glowParams,
      pickable: true,
      updateTriggers: { getWidth: trig, getColor: trig },
    }),
  ];
  if (showFibers) {
    layers.push(
      new PathLayer({
        ...common,
        id: 'cable-fans',
        data: scene.fans,
        getPath: (f) => f.path,
        getWidth: Math.max(0.8, laneW * 0.7),
        getColor: (f) => colour(f, 140),
        parameters: glowParams,
        pickable: true,
        updateTriggers: { getWidth: trig, getColor: trig },
      }),
      new ScatterplotLayer({
        id: 'cable-ends',
        data: scene.ends,
        getPosition: (e) => e.position,
        getRadius: Math.max(1.2, laneW * 1.1),
        radiusUnits: 'pixels',
        getFillColor: (e) => colour(e, 230),
        stroked: k >= 0.5,
        getLineColor: [10, 13, 20, 200],
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        billboard: globe,
        parameters: params,
        updateTriggers: { getRadius: trig, getFillColor: trig },
      }),
      new PathLayer({
        ...common,
        id: 'cable-lanes',
        data: scene.lanes,
        getPath: (l) => l.path,
        getWidth: laneW,
        getColor: (l) => colour(l, Math.round(170 + 85 * k)),
        getOffset: (l) => l.offset * LANE_SPACING,
        extensions: [offsetExt],
        parameters: glowParams,
        pickable: true,
        updateTriggers: { getWidth: trig, getColor: trig },
      }),
    );
  }
  // A mux stop spans most of its widest trunk (its outer lanes show past it);
  // a stop the lanes run through shows only once you're close enough to read
  // the lines. Both firm up from a soft white as you zoom in.
  const stopR = (s) => {
    if (!showFibers) return 1.6;
    if (s.mux) return Math.max(2.5, 0.4 * trunkW(s) + 1.2);
    return s.lanes && k >= 0.45 ? 1.8 : 0;
  };
  layers.push(
    new ScatterplotLayer({
      id: 'cable-stations',
      data: stations,
      getPosition: (s) => s.position,
      getRadius: stopR,
      radiusUnits: 'pixels',
      getFillColor: (s) => (showFibers && s.lanes ? [248, 248, 245, Math.round(120 + 135 * k)] : [200, 210, 220, 150]),
      stroked: showFibers,
      getLineColor: [15, 18, 25, Math.round(255 * k)],
      lineWidthUnits: 'pixels',
      getLineWidth: 1.2,
      billboard: globe,
      parameters: top,
      pickable: true,
      updateTriggers: { getRadius: trig, getFillColor: trig, getLineColor: trig },
    }),
  );
  if (labels) {
    layers.push(
      new TextLayer({
        id: 'cable-labels',
        data: showFibers ? busy : stations,
        getPosition: (s) => s.position,
        getText: (s) => s.name,
        getSize: 11,
        sizeUnits: 'pixels',
        getColor: [235, 238, 245, 220],
        getPixelOffset: (s) => [stopR(s) + 4, 0],
        getTextAnchor: 'start',
        getAlignmentBaseline: 'center',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontWeight: 600,
        outlineWidth: 3,
        outlineColor: [4, 6, 11, 255],
        fontSettings: { sdf: true },
        characterSet: 'auto',
        billboard: true,
        parameters: top,
        updateTriggers: { getPixelOffset: trig },
      }),
    );
  }
  return layers;
}
