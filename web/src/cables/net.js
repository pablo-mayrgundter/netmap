// The cable network (data.js) as a graph, the fiber bundles routed over it,
// and the lanes each bundle takes along each span: a multiplex, the way a
// CWDM link carries its channels side by side between a mux and a demux, or a
// subway map runs its lines side by side down a shared trunk.
//
// Pure (no deck, no DOM), so `npm test` checks it in node. main.js draws it.

import { CITIES, CABLES } from './data.js';

const D2R = Math.PI / 180;
const R_KM = 6371;
const STEP = 1.5 * D2R; // the most arc between two vertices of a drawn span
// Routing prefers the sea a little: long-haul traffic between continents
// rides the submarine systems, and overland routes carry the backhaul.
const LAND_COST = 1.25;

const unit = (lon, lat) => {
  const la = lat * D2R, lo = lon * D2R;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Great-circle distance in km between two [lon, lat]. */
export function gcKm(a, b) {
  return R_KM * Math.acos(Math.max(-1, Math.min(1, dot(unit(a[0], a[1]), unit(b[0], b[1])))));
}

// Points along the great circle from p to q, p excluded, q included, at most
// STEP apart; longitudes continue from `lon0` (no jump at the antimeridian),
// so a span drawn on the 2D map stays one piece.
function slerpInto(out, p, q) {
  const u = unit(p[0], p[1]);
  const v = unit(q[0], q[1]);
  const ang = Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
  const n = Math.max(1, Math.ceil(ang / STEP));
  const s = Math.sin(ang);
  let prevLon = out.length ? out[out.length - 1][0] : p[0];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const a = s < 1e-9 ? 1 - t : Math.sin((1 - t) * ang) / s;
    const b = s < 1e-9 ? t : Math.sin(t * ang) / s;
    const x = a * u[0] + b * v[0], y = a * u[1] + b * v[1], z = a * u[2] + b * v[2];
    let lon = Math.atan2(y, x) / D2R;
    const lat = Math.atan2(z, Math.hypot(x, y)) / D2R;
    lon += 360 * Math.round((prevLon - lon) / 360);
    out.push([lon, lat]);
    prevLon = lon;
  }
  return ang * R_KM;
}

/**
 * The network: stations (cities on any cable) and corridors. A corridor is
 * the span between two stations next to each other on a cable; cables that
 * run between the same two stations share it (as several subway lines share a
 * trunk), and its `cables` lists them. `path` is [lon, lat] points from
 * station `a` to `b`, through the cable's waypoints at sea.
 */
export function buildCableNet(cities = CITIES, cables = CABLES) {
  const nodes = [];
  const nodeIndex = new Map();
  const station = (key) => {
    if (!nodeIndex.has(key)) {
      const c = cities[key];
      if (!c) throw new Error(`cables: unknown city "${key}"`);
      nodeIndex.set(key, nodes.length);
      nodes.push({ key, name: c[0], lon: c[1], lat: c[2], u: unit(c[1], c[2]) });
    }
    return nodeIndex.get(key);
  };
  const corridors = [];
  const byPair = new Map();
  const pointOf = (w) => (typeof w === 'string' ? [cities[w][1], cities[w][2]] : w);
  const same = (p, q) => typeof p !== 'string' && typeof q !== 'string' && p[0] === q[0] && p[1] === q[1];
  for (const cable of cables) {
    const raw = cable.paths || [cable.path];
    const branches = [];
    for (const br0 of raw) {
      // A branch may start (or end) at a waypoint of an earlier branch, where
      // it splits off at sea: it runs from the earlier branch's station before
      // that point (or on to the one after it).
      let br = br0;
      if (typeof br[0] !== 'string') br = [...splice(branches, br[0], -1), ...br];
      if (typeof br[br.length - 1] !== 'string') br = [...br, ...splice(branches, br[br.length - 1], 1)];
      branches.push(br);
    }
    function splice(prior, w, dir) {
      for (const b of prior) {
        const j = b.findIndex((x) => same(x, w));
        if (j < 0) continue;
        let k = j + dir;
        while (k >= 0 && k < b.length && typeof b[k] !== 'string') k += dir;
        if (k < 0 || k >= b.length) continue;
        return dir < 0 ? b.slice(k, j) : b.slice(j + 1, k + 1);
      }
      throw new Error(`cables: ${cable.name}: a branch starts or ends at sea, off any earlier branch`);
    }
    for (const br of branches) {
      if (typeof br[0] !== 'string') throw new Error(`cables: ${cable.name}: a branch must start at a station`);
      let from = station(br[0]);
      let pts = [pointOf(br[0])];
      let km = 0;
      for (let i = 1; i < br.length; i++) {
        const w = br[i];
        const p = pointOf(w);
        km += slerpInto(pts, pointOf(br[i - 1]), p);
        if (typeof w !== 'string') continue;
        const s = station(w);
        if (from !== s) {
          const lo = Math.min(from, s), hi = Math.max(from, s);
          const path = rebase(from === lo ? pts : pts.slice().reverse(), nodes[lo].lon);
          const pk = `${lo}|${hi}`;
          let c = byPair.get(pk);
          if (c === undefined) {
            c = corridors.length;
            byPair.set(pk, c);
            corridors.push({ id: c, a: lo, b: hi, kind: cable.kind, cables: [], years: [], path, km });
          }
          const cc = corridors[c];
          if (!cc.cables.includes(cable.name)) cc.cables.push(cable.name), cc.years.push(cable.year ?? null);
          if (cable.kind === 'sub') cc.kind = 'sub';
          if (km < cc.km) cc.km = km, cc.path = path; // the shortest of the cables sharing it draws it
        }
        from = s;
        pts = [p];
        km = 0;
      }
    }
  }
  const adj = nodes.map(() => []);
  for (const c of corridors) {
    adj[c.a].push(c.id);
    adj[c.b].push(c.id);
  }
  return { nodes, nodeIndex, corridors, adj };
}

// Longitudes of a path shifted by whole turns so it starts within 180° of lon0.
function rebase(path, lon0) {
  const k = 360 * Math.round((lon0 - path[0][0]) / 360);
  return k ? path.map(([x, y]) => [x + k, y]) : path;
}

/** The station nearest [lon, lat]: { node, km }. */
export function nearestNode(net, lon, lat) {
  const u = unit(lon, lat);
  let best = -1, bd = -2;
  for (let i = 0; i < net.nodes.length; i++) {
    const d = dot(u, net.nodes[i].u);
    if (d > bd) bd = d, best = i;
  }
  return { node: best, km: R_KM * Math.acos(Math.max(-1, Math.min(1, bd))) };
}

// Dijkstra from one station over corridor lengths: { dist, prev } where
// prev[v] is the corridor the shortest path arrives at v by.
function shortestFrom(net, src) {
  const n = net.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[src] = 0;
  // n is a few hundred: a linear scan beats a heap's bookkeeping.
  for (;;) {
    let u = -1, du = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < du) du = dist[i], u = i;
    if (u < 0) break;
    done[u] = 1;
    for (const c of net.adj[u]) {
      const cor = net.corridors[c];
      const v = cor.a === u ? cor.b : cor.a;
      const d = du + cor.km * (cor.kind === 'land' ? LAND_COST : 1);
      if (d < dist[v]) dist[v] = d, prev[v] = c;
    }
  }
  return { dist, prev };
}

/**
 * Each fiber ({ source: [lon, lat, ...], target, count }) routed over the
 * network, or null where it isn't: an end more than `snapKm` from any
 * station, both ends at the same station, or a route more than `stretch`
 * times the great circle (plus `slackKm`), which a real path wouldn't take.
 * A route: { from, to, steps: [{ c, fwd }], nodes: [station...], km }, from
 * the fiber's source to its target; `fwd` is true where it runs a corridor
 * from its `a` to its `b`.
 */
export function routeFibers(net, fibers, { snapKm = 900, stretch = 2.2, slackKm = 600 } = {}) {
  const trees = new Map();
  const tree = (s) => {
    if (!trees.has(s)) trees.set(s, shortestFrom(net, s));
    return trees.get(s);
  };
  return fibers.map((f) => {
    const s = nearestNode(net, f.source[0], f.source[1]);
    const t = nearestNode(net, f.target[0], f.target[1]);
    if (s.km > snapKm || t.km > snapKm || s.node === t.node) return null;
    const { dist, prev } = tree(s.node);
    const km = dist[t.node];
    if (!Number.isFinite(km)) return null;
    const gc = gcKm(f.source, f.target);
    if (km + s.km + t.km > stretch * gc + slackKm) return null;
    const steps = [];
    const nodes = [t.node];
    for (let v = t.node; v !== s.node;) {
      const c = prev[v];
      const cor = net.corridors[c];
      const u = cor.a === v ? cor.b : cor.a;
      steps.push({ c, fwd: cor.a === u });
      nodes.push(u);
      v = u;
    }
    steps.reverse();
    nodes.reverse();
    return { from: s.node, to: t.node, steps, nodes, km, snapKm: [s.km, t.km] };
  });
}

/** How many lanes a corridor shows at a zoom: a CWDM-like 8 at world scale, a subway trunk's dozens close up. */
export const maxLanesAt = (zoom) => Math.max(4, Math.min(48, Math.round(4 * Math.pow(2, zoom / 2))));

/**
 * Lanes: which fibers a corridor carries side by side, and in what order.
 *
 * Fibers are taken biggest first, and one is drawn only if every corridor on
 * its route has a lane free (`maxLanes`), so a drawn fiber is one continuous
 * line from end to end, like a subway line. The rest are counted as each
 * corridor's `overflow`, drawn as one grey lane.
 *
 * Across a corridor (a to b), lanes are ordered by where their fiber comes
 * from and goes to: one that arrives from the right of the corridor's line
 * and leaves to the right takes the rightmost lane, so lines cross as little
 * as they can at the stations. `offset` is a lane's place from the middle, in
 * lane widths: negative is left of a -> b.
 *
 * Returns { drawn: Uint8Array per fiber, lanes: per corridor [{ fiber,
 * offset }], overflow: per corridor count, width: per corridor lane count
 * (with the grey lane), nodeWidth: per station the widest corridor there }.
 */
export function layoutLanes(net, fibers, routes, maxLanes) {
  const C = net.corridors.length;
  const used = new Uint16Array(C);
  const overflow = new Uint32Array(C);
  const drawn = new Uint8Array(fibers.length);
  const order = [];
  for (let i = 0; i < fibers.length; i++) if (routes[i]) order.push(i);
  order.sort((x, y) => fibers[y].count - fibers[x].count || x - y);
  const members = Array.from({ length: C }, () => []);
  for (const i of order) {
    const r = routes[i];
    if (r.steps.every((s) => used[s.c] < maxLanes)) {
      drawn[i] = 1;
      for (const s of r.steps) used[s.c]++, members[s.c].push(i);
    } else {
      for (const s of r.steps) overflow[s.c]++;
    }
  }
  const lanes = new Array(C);
  const width = new Uint16Array(C);
  for (let c = 0; c < C; c++) {
    const cor = net.corridors[c];
    const a = net.nodes[cor.a].u, b = net.nodes[cor.b].u;
    const nrm = cross(a, b);
    const ln = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
    // > 0: right of a -> b (a x b points left of the direction of travel)
    const right = (u) => -dot(u, nrm) / ln;
    const keyed = members[c].map((i) => {
      const r = routes[i];
      const k = r.steps.findIndex((s) => s.c === c);
      const fwd = r.steps[k].fwd;
      // in the corridor's a -> b order: the station before a and after b
      // (or the fiber's own end, where the route starts or ends here)
      const beforeIdx = fwd ? k - 1 : k + 2;
      const afterIdx = fwd ? k + 2 : k - 1;
      const at = (j, end) => (j >= 0 && j < r.nodes.length ? net.nodes[r.nodes[j]].u : unit(end[0], end[1]));
      const before = at(beforeIdx, fwd ? fibers[i].source : fibers[i].target);
      const after = at(afterIdx, fwd ? fibers[i].target : fibers[i].source);
      return { i, key: right(before) + right(after) };
    });
    keyed.sort((x, y) => x.key - y.key || x.i - y.i);
    const n = keyed.length + (overflow[c] ? 1 : 0);
    width[c] = n;
    lanes[c] = keyed.map((m, j) => ({ fiber: m.i, offset: j - (n - 1) / 2 }));
  }
  const nodeWidth = new Uint16Array(net.nodes.length);
  for (let c = 0; c < C; c++) {
    const cor = net.corridors[c];
    nodeWidth[cor.a] = Math.max(nodeWidth[cor.a], width[c]);
    nodeWidth[cor.b] = Math.max(nodeWidth[cor.b], width[c]);
  }
  return { drawn, lanes, overflow, width, nodeWidth };
}

// Subway-map colours, bright enough for the dark globe. Grey is the overflow
// lane's.
export const LINE_COLOURS = [
  [238, 53, 46], [255, 128, 32], [252, 204, 10], [0, 170, 80], [140, 205, 70], [50, 120, 235],
  [0, 185, 220], [190, 70, 190], [175, 120, 70], [245, 125, 185], [140, 100, 230], [20, 195, 165],
];
export const OVERFLOW_COLOUR = [150, 155, 165];

/** A fiber's line colour, from where its ends are, so it keeps its colour as filters change. */
export function lineColour(f) {
  let h = 2166136261;
  for (const v of [f.source[0], f.source[1], f.target[0], f.target[1]]) {
    h = Math.imul(h ^ Math.round(v * 10), 16777619);
  }
  return LINE_COLOURS[(h >>> 0) % LINE_COLOURS.length];
}
