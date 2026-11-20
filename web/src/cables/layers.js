// deck.gl layers for the cable network and the fibers pinned into it
// (net.js): each span a casing that carries its fibers side by side as
// coloured lanes, stations as white subway-map stops wide enough for the
// lanes through them, and from each station a fan of lines out to the
// fibers' own ends (the transmitters and receivers of a CWDM link, with the
// station as its mux).

import { PathStyleExtension } from '@deck.gl/extensions';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { lineColour, OVERFLOW_COLOUR } from './net.js';

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
    const corridors = net.corridors.map((c) => ({ ...c, path3: withAlt(c.path, z), lanes: L.width[c.id], overflow: L.overflow[c.id] }));
    const lanes = [];
    for (const c of net.corridors) {
      const path = corridors[c.id].path3;
      for (const l of L.lanes[c.id]) lanes.push({ path, offset: l.offset, fiber: l.fiber, c: c.id, color: lineColour(fibers[l.fiber]) });
      if (L.overflow[c.id]) {
        const n = L.width[c.id];
        lanes.push({ path, offset: (n - 1) / 2, fiber: -1, c: c.id, color: OVERFLOW_COLOUR, overflow: L.overflow[c.id] });
      }
    }
    const fans = [];
    const ends = [];
    const fanned = new Uint32Array(net.nodes.length); // fibers that leave the cables here
    for (let i = 0; i < fibers.length; i++) {
      if (!L.drawn[i]) continue;
      const r = routes[i];
      const color = lineColour(fibers[i]);
      fanned[r.from]++, fanned[r.to]++;
      for (const [end, node] of [[fibers[i].source, r.from], [fibers[i].target, r.to]]) {
        fans.push({ path: fanPath(end, net.nodes[node], globe), fiber: i, color });
        ends.push({ position: globe ? end : [end[0], end[1], 0], fiber: i, color });
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

/**
 * The layers. `laneW` is a lane's width in pixels; `labels` shows the busy
 * stations' names; `depthCompare` and `opacity` follow the other links'.
 */
export function cableLayers(scene, { laneW, labels, globe, opacity = 1, showFibers = true, facing = null }) {
  const params = { depthWriteEnabled: false, depthCompare: globe ? 'less-equal' : 'always' };
  // Stops and their names are billboards wider than the globe is flat under
  // them, so the depth test would cut them; on the globe they're drawn over
  // it, and those on the far side (`facing` false) left out.
  const top = { depthWriteEnabled: false, depthCompare: 'always' };
  const stations = facing ? visibleOf(scene, 'stations', facing) : scene.stations;
  const busy = facing ? visibleOf(scene, 'busy', facing) : scene.busy;
  const casingW = (c) => (showFibers && c.lanes ? c.lanes * laneW * LANE_SPACING + 2 : 1.2);
  const common = { widthUnits: 'pixels', billboard: globe, parameters: params, jointRounded: true, capRounded: true };
  const trig = `${laneW}|${showFibers}`;
  const layers = [
    // the cable: a light rim and a dark casing, like the fibre run in a WDM diagram
    new PathLayer({
      ...common,
      id: 'cable-rim',
      data: scene.corridors,
      getPath: (c) => c.path3,
      getWidth: (c) => casingW(c) + 1.5,
      getColor: (c) => (showFibers && c.lanes ? [150, 165, 190, 150] : c.kind === 'sub' ? [70, 160, 210, 70] : [215, 160, 80, 60]),
      opacity,
      updateTriggers: { getWidth: trig, getColor: trig },
    }),
    new PathLayer({
      ...common,
      id: 'cable-corridors',
      data: scene.corridors,
      getPath: (c) => c.path3,
      getWidth: casingW,
      getColor: (c) => (showFibers && c.lanes ? [10, 13, 20, 235] : c.kind === 'sub' ? [70, 170, 225, 150] : [225, 170, 90, 130]),
      opacity,
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
        getColor: (f) => [...f.color, 170],
        opacity,
        pickable: true,
        updateTriggers: { getWidth: trig },
      }),
      new ScatterplotLayer({
        id: 'cable-ends',
        data: scene.ends,
        getPosition: (e) => e.position,
        getRadius: Math.max(1.5, laneW * 1.2),
        radiusUnits: 'pixels',
        getFillColor: (e) => e.color,
        stroked: true,
        getLineColor: [10, 13, 20, 220],
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        billboard: globe,
        parameters: params,
        opacity,
        updateTriggers: { getRadius: trig },
      }),
      new PathLayer({
        ...common,
        id: 'cable-lanes',
        data: scene.lanes,
        getPath: (l) => l.path,
        getWidth: laneW,
        getColor: (l) => l.color,
        getOffset: (l) => l.offset * LANE_SPACING,
        extensions: [offsetExt],
        pickable: true,
        updateTriggers: { getWidth: trig },
      }),
    );
  }
  // a mux stop spans most of its widest trunk; its outer lanes show past it
  const stopR = (s) => (showFibers && s.mux ? Math.max(3, 0.4 * s.lanes * laneW * LANE_SPACING + 1.5) : showFibers && s.lanes ? 2 : 1.8);
  layers.push(
    new ScatterplotLayer({
      id: 'cable-stations',
      data: stations,
      getPosition: (s) => s.position,
      getRadius: stopR,
      radiusUnits: 'pixels',
      getFillColor: (s) => (showFibers && s.lanes ? [248, 248, 245, 255] : [200, 210, 220, 200]),
      stroked: true,
      getLineColor: [15, 18, 25, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: (s) => (showFibers && s.lanes ? 1.5 : 0.8),
      billboard: globe,
      parameters: top,
      pickable: true,
      updateTriggers: { getRadius: trig, getFillColor: trig, getLineWidth: trig },
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
        getColor: [235, 238, 245, 230],
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
