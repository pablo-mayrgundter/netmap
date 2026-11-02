// The globe's look, shared by the app (main.js) and the NetGL guest page
// (map.html, mapGuest.js): the earth under the map, the colours of nodes and
// links, how high a network floats and how bright a link is. Everything
// here takes the bundle (data.js) and the settings as arguments, so both
// pages draw the same numbers from the same code. Pure (no deck, no DOM), so
// `npm test` checks it in node; the earth's layers are in earth.js.

// A dark lat/lon graticule generated here, so there are no tile requests,
// tokens or placeholder images. Every 10 degrees, brighter every 30.
export const graticule = (() => {
  const features = [];
  const line = (coords, major) => features.push({ type: 'Feature', properties: { major }, geometry: { type: 'LineString', coordinates: coords } });
  for (let lon = -180; lon <= 180; lon += 10) {
    const pts = [];
    for (let lat = -80; lat <= 80; lat += 2) pts.push([lon, lat]);
    line(pts, lon % 30 === 0);
  }
  for (let lat = -80; lat <= 80; lat += 10) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, lat]);
    line(pts, lat % 30 === 0);
  }
  return { type: 'FeatureCollection', features };
})();

// Core networks hover this high (at full hierarchy level, default slider) on
// the globe: high enough to read as a layer above the cities, low enough that
// zooming in doesn't put them in the camera's face.
export const ALT_MAX_M = 700_000;

/** How high a network of hierarchy `level` (0..1) floats, metres, at the altitude slider's `alt`. */
export const altitudeOf = (level, alt) => Math.pow(level, 1.5) * ALT_MAX_M * alt * 2;

// The lift of the globe's link arcs (arcs.js buildArcs).
export const EDGE_LIFT = 0.03;

/**
 * Node and link colours, RGBA bytes: a node in its region's colour, a link
 * in the mean of its ends', transit and intra-AS backbone brighter than
 * peering, and router-level bundles brighter with log(number of router links).
 */
export function regionColours(G) {
  const regionRGB = G.meta.regions.map((r) => r.rgb);
  const nodeColor = new Uint8Array(G.n * 4);
  for (let i = 0; i < G.n; i++) {
    const c = regionRGB[G.region[i]];
    nodeColor.set([c[0], c[1], c[2], 255], i * 4);
  }
  const edgeColor = new Uint8Array(G.e * 4);
  for (let k = 0; k < G.e; k++) {
    const a = regionRGB[G.region[G.edges[2 * k]]];
    const b = regionRGB[G.region[G.edges[2 * k + 1]]];
    edgeColor[k * 4] = (a[0] + b[0]) >> 1;
    edgeColor[k * 4 + 1] = (a[1] + b[1]) >> 1;
    edgeColor[k * 4 + 2] = (a[2] + b[2]) >> 1;
    const w = G.edge_weight ? Math.min(1, 0.35 + 0.18 * Math.log2(1 + G.edge_weight[k])) : 1;
    edgeColor[k * 4 + 3] = (G.edge_rel[k] === 0 ? 190 : 255) * w;
  }
  return { regionRGB, nodeColor, edgeColor };
}

/**
 * Link k's ends: `end(k, side, target)` fills target with [lon, lat,
 * altitude] for side 0 or 1, in layout section `sec`, at the AS's point of
 * presence when `pops` (and the link was re-attached to one), floating by
 * hierarchy on the globe (`globe`, altitude slider `alt`).
 */
export function makeEndReader(G, { sec, pops, globe, alt }) {
  const p = G[sec];
  const { edges, level } = G;
  const { edge_pop: edgePop, pop_pos: popXY, pop_node: popNode } = G;
  return (k, side, target) => {
    let i;
    const q = pops ? edgePop[2 * k + side] : -1;
    if (q >= 0) {
      target[0] = popXY[2 * q];
      target[1] = popXY[2 * q + 1];
      i = popNode[q];
    } else {
      i = edges[2 * k + side];
      target[0] = p[2 * i];
      target[1] = p[2 * i + 1];
    }
    target[2] = globe ? altitudeOf(level[i], alt) : 0;
    return target;
  };
}

/**
 * Per-link brightness by on-screen length: each link gets a fixed amount of
 * "ink", so hundreds of thousands of trans-oceanic lines don't saturate an
 * 8-bit framebuffer and metro-scale structure stays visible. `end` as
 * makeEndReader's.
 */
export function linkLengthFactors(count, end) {
  const merc = (lon, lat) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  };
  const f = new Float32Array(count);
  const ta = [0, 0, 0];
  const tb = [0, 0, 0];
  for (let k = 0; k < count; k++) {
    end(k, 0, ta);
    end(k, 1, tb);
    const [x0, y0] = merc(ta[0], ta[1]);
    const [x1, y1] = merc(tb[0], tb[1]);
    const len = Math.hypot(x1 - x0, y1 - y0);
    f[k] = Math.min(1, Math.pow(0.004 / Math.max(len, 1e-7), 0.6));
  }
  return f;
}

/** The same for the core routes between an AS's points of presence: fewer, so brighter. */
export function routeLengthFactors(G) {
  const r = G.pop_routes;
  const f = new Float32Array(r.length / 2);
  for (let k = 0; k < f.length; k++) {
    const a = r[2 * k];
    const b = r[2 * k + 1];
    const dLon = Math.abs(G.pop_pos[2 * a] - G.pop_pos[2 * b]);
    const len = Math.hypot(Math.min(dLon, 360 - dLon), G.pop_pos[2 * a + 1] - G.pop_pos[2 * b + 1]) / 360;
    f[k] = Math.min(1, Math.pow(0.012 / Math.max(len, 1e-7), 0.6));
  }
  return f;
}

/**
 * Per-line opacity. Hundreds of thousands of additive lines blow out to
 * white at world scale, so lines start faint and brighten as you zoom in and
 * they spread apart. `zoom` is the map's (the globe's plus 0.6); `sparsity`
 * makes up for the links a filter hides.
 */
export function linkOpacity({ zoom, glow, edgeAlpha, sparsity = 1 }) {
  const k = (glow ? 0.0025 : 0.007) * Math.pow(edgeAlpha / 0.35, 2) * sparsity;
  return Math.min(1, k * Math.pow(2, zoom));
}

/** Nodes' radius scale and opacity at map zoom `zoom` (the globe's plus 0.6). */
export function nodeLook({ zoom, nodeSize, glow }) {
  return {
    sizeK: (0.25 + nodeSize * 2.2) * Math.min(1.6, 0.45 + 0.13 * zoom),
    opacity: Math.min(0.9, 0.1 * Math.pow(2, zoom - 1) * (glow ? 1 : 2.5)),
  };
}

/** A node's radius in pixels (before the radius scale) by degree. */
export const nodeRadius = (degree) => 0.6 + Math.log2(degree + 1) * 0.55;

// The glow: links and nodes add up, so dense bundles blow out to white.
export const ADDITIVE = {
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
};
