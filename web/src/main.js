import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Deck, _GlobeView as GlobeView } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { DataFilterExtension } from '@deck.gl/extensions';
import { LineLayer, PathLayer, ScatterplotLayer, GeoJsonLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { feature } from 'topojson-client';
import countries110 from 'world-atlas/countries-110m.json';

import { listDatasets, loadBundle } from './data.js';

// Where map bundles live. PR previews point this at the production data (../../data).
const DATA_BASE = new URL(import.meta.env.VITE_DATA_BASE || './data', document.baseURI).href.replace(/\/$/, '');
const params = new URLSearchParams(location.search);
// Optional on-demand tile server (`netmap serve-tiles`), e.g. ?tiles=http://localhost:8765
const TILE_SERVER = params.get('tiles');

const BASEMAPS = {
  dark: {
    tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`),
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
  },
  osm: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};

// Core networks hover this high (at full hierarchy level, default slider) on
// the globe: high enough to read as a layer above the cities, low enough that
// zooming in doesn't put them in the camera's face.
const ALT_MAX_M = 700_000;

// --- state ---------------------------------------------------------------

const hash = new URLSearchParams(location.hash.slice(1));

// Every UI parameter: state field, URL key, type, default. Permalinks carry
// all of them (plus dataset, camera and selection), so a link reproduces the
// view exactly even if these defaults change later.
const PARAMS = [
  ['mode', 'mode', ['cyber', 'hybrid', 'geo'], 'hybrid'],
  ['view', 'view', ['map', 'globe'], 'globe'],
  ['basemap', 'basemap', ['dark', 'osm', 'none'], 'dark'],
  ['renderer', 'renderer', ['vector', 'raster'], 'vector'],
  ['edgeAlpha', 'edges', 'num', 0.05],
  ['nodeSize', 'nodes', 'num', 0],
  ['sampling', 'sample', 'num', 0], // 0 = one vantage tree .. 1 = every link
  ['altitude', 'alt', 'num', 0.2],
  ['showTransit', 'transit', 'bool', true],
  ['showPeering', 'peering', 'bool', true],
  ['backboneOnly', 'backbone', 'bool', true],
  ['pops', 'pops', 'bool', true], // floating ASes drawn at their points of presence
  ['fibers', 'fibers', 'bool', true], // bundle links that join the same pair of places
  ['fiberCell', 'cell', 'num', 1], // 0..1 -> ~5..650 km
  ['fiberWidth', 'fw', 'num', 0.1],
  ['glow', 'glow', 'bool', true],
];

function readParam([, key, type, def]) {
  const v = hash.get(key);
  if (v === null) return def;
  if (type === 'bool') return v === '1' || v === 'true';
  if (type === 'num') {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : def;
  }
  return type.includes(v) ? v : def; // enumerated string
}

const state = {
  dataset: hash.get('data') || params.get('data') || null,
  ...Object.fromEntries(PARAMS.map((p) => [p[0], readParam(p)])),
  selected: null, // node index
  hover: null,
};

let G = null; // loaded bundle
let edgeColor = null; // Uint8Array E*4 (base colours, alpha applied in accessor)
let nodeColor = null; // Uint8Array N*4
let regionRGB = [];
let tilesMeta = {};

const $ = (id) => document.getElementById(id);

// --- maps ----------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  style: baseStyle(),
  center: [Number(hash.get('lon') ?? 10), Number(hash.get('lat') ?? 25)],
  zoom: Number(hash.get('z') ?? 1.6),
  renderWorldCopies: false,
  attributionControl: { compact: true },
  maxZoom: 16,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

const overlay = new MapboxOverlay({ interleaved: false, layers: [], getTooltip: null });
map.addControl(overlay);

let globe = null;
let globeCam = null; // globe's current view state, for permalinks
function ensureGlobe() {
  if (globe) return globe;
  const c = map.getCenter();
  globe = new Deck({
    parent: $('globe'),
    views: new GlobeView({ resolution: 5 }),
    initialViewState: (globeCam = { longitude: c.lng, latitude: c.lat, zoom: (globeZoom = Math.max(map.getZoom() - 0.6, 0)) }),
    controller: true,
    layers: [],
    onHover: onHover,
    onClick: onClick,
    onViewStateChange: ({ viewState }) => {
      globeCam = viewState;
      writeHashSoon();
      if (Math.abs(viewState.zoom - globeZoom) > 0.05) {
        globeZoom = viewState.zoom;
        renderSoon();
      }
    },
    getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
  });
  return globe;
}

function baseStyle() {
  const style = {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#000' } }],
  };
  const b = BASEMAPS[state.basemap];
  if (b) {
    style.sources.base = { type: 'raster', tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: 19 };
    style.layers.push({
      id: 'base',
      type: 'raster',
      source: 'base',
      paint: { 'raster-opacity': basemapOpacity(), 'raster-opacity-transition': { duration: 1200 } },
    });
  }
  return style;
}

function basemapOpacity() {
  if (state.mode === 'cyber') return 0;
  return state.basemap === 'osm' ? 0.75 : 1;
}

function setBasemap(v) {
  state.basemap = v;
  if (v === 'osm' && state.glow) {
    state.glow = false;
    $('glow').checked = false;
  }
  map.setStyle(baseStyle());
  map.once('styledata', () => updateRaster());
  render();
}

// Raster XYZ layer from `netmap tiles` (static) or `netmap serve-tiles` (on demand).
function updateRaster() {
  if (!map.isStyleLoaded()) return;
  if (map.getLayer('net')) map.removeLayer('net');
  if (map.getSource('net')) map.removeSource('net');
  if (state.renderer !== 'raster' || !G) return;
  const base = TILE_SERVER || `${G.root}/tiles`;
  // Backbone-only tiles are optional (`netmap tiles --backbone`); fall back to
  // the full-link pyramid rather than requesting tiles that don't exist.
  const bb = `backbone/${state.mode}`;
  const layer = state.backboneOnly && !TILE_SERVER && tilesMeta[bb] ? bb : state.mode;
  const tm = tilesMeta[layer] || {};
  map.addSource('net', {
    type: 'raster',
    tiles: [`${base}/${layer}/{z}/{x}/{y}.${tm.format || 'png'}`],
    tileSize: 256,
    minzoom: 0,
    maxzoom: TILE_SERVER ? 14 : tm.maxzoom ?? 5,
  });
  map.addLayer({ id: 'net', type: 'raster', source: 'net', paint: { 'raster-fade-duration': 0 } });
}

// --- colours -------------------------------------------------------------

function buildColours() {
  regionRGB = G.meta.regions.map((r) => r.rgb);
  nodeColor = new Uint8Array(G.n * 4);
  for (let i = 0; i < G.n; i++) {
    const c = regionRGB[G.region[i]];
    nodeColor.set([c[0], c[1], c[2], 255], i * 4);
  }
  edgeColor = new Uint8Array(G.e * 4);
  for (let k = 0; k < G.e; k++) {
    const a = regionRGB[G.region[G.edges[2 * k]]];
    const b = regionRGB[G.region[G.edges[2 * k + 1]]];
    edgeColor[k * 4] = (a[0] + b[0]) >> 1;
    edgeColor[k * 4 + 1] = (a[1] + b[1]) >> 1;
    edgeColor[k * 4 + 2] = (a[2] + b[2]) >> 1;
    edgeColor[k * 4 + 3] = G.edge_rel[k] === -1 ? 255 : 190;
  }
}

// Per-edge brightness by on-screen length, per mode: each link gets a fixed
// amount of "ink", so hundreds of thousands of trans-oceanic lines don't
// saturate an 8-bit framebuffer and metro-scale structure stays visible.
const lengthFactor = {};
function edgeLengthFactor(mode) {
  const key = `${mode}|${usePops()}`;
  if (lengthFactor[key]) return lengthFactor[key];
  const merc = (lon, lat) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  };
  const f = new Float32Array(G.e);
  const ta = [0, 0, 0];
  const tb = [0, 0, 0];
  for (let k = 0; k < G.e; k++) {
    endPos(k, 0, ta, mode);
    endPos(k, 1, tb, mode);
    const [x0, y0] = merc(ta[0], ta[1]);
    const [x1, y1] = merc(tb[0], tb[1]);
    const len = Math.hypot(x1 - x0, y1 - y0);
    f[k] = Math.min(1, Math.pow(0.004 / Math.max(len, 1e-7), 0.6));
  }
  return (lengthFactor[key] = f);
}

let routeLF = null;
function routeLengthFactor() {
  if (routeLF) return routeLF;
  const r = G.pop_routes;
  const f = new Float32Array(r.length / 2);
  for (let k = 0; k < f.length; k++) {
    const a = r[2 * k];
    const b = r[2 * k + 1];
    const dLon = Math.abs(G.pop_pos[2 * a] - G.pop_pos[2 * b]);
    const len = Math.hypot(Math.min(dLon, 360 - dLon), G.pop_pos[2 * a + 1] - G.pop_pos[2 * b + 1]) / 360;
    f[k] = Math.min(1, Math.pow(0.012 / Math.max(len, 1e-7), 0.6));
  }
  return (routeLF = f);
}

// --- positions -----------------------------------------------------------

const hasGeo = (i) => (G.flags[i] & 1) === 1;
const visibleNode = (i) => state.mode !== 'geo' || hasGeo(i);

function altitude(i) {
  if (state.view !== 'globe') return 0;
  const l = G.level[i];
  return Math.pow(l, 1.5) * ALT_MAX_M * state.altitude * 2;
}

function pos(i, target, mode = state.mode) {
  const p = G[`pos_${mode}`];
  target[0] = p[2 * i];
  target[1] = p[2 * i + 1];
  target[2] = altitude(i);
  return target;
}

// Points of presence (pipeline/netmap/pops.py): floating ASes split into the
// cities their address space lives in. Each link end may attach to a PoP
// instead of the AS's single position, and each PoP'd AS has core routes
// (a spanning tree) between its PoPs.
const usePops = (mode = state.mode) => state.pops && mode !== 'cyber' && !!G?.pop_pos;
const hasPops = (i) => !!G.pop_offset && G.pop_offset[i + 1] > G.pop_offset[i];

function popPos(p, target) {
  target[0] = G.pop_pos[2 * p];
  target[1] = G.pop_pos[2 * p + 1];
  target[2] = altitude(G.pop_node[p]);
  return target;
}

function endPos(k, side, target, mode = state.mode) {
  if (usePops(mode)) {
    const p = G.edge_pop[2 * k + side];
    if (p >= 0) return popPos(p, target);
  }
  return pos(G.edges[2 * k + side], target, mode);
}

// --- globe arcs ----------------------------------------------------------
// Links on the globe are paths we build here: great-circle interpolation
// between the two ends' altitudes plus a gentle sin-shaped lift. (deck's
// ArcLayer in GlobeView lofts arcs thousands of km up, so from above they
// read as radial dashes.) Short links get 1-2 segments, long ones up to 16.
const D2R = Math.PI / 180;
function buildArcs(count, ends, liftK) {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const segs = new Uint8Array(count);
  let total = 0;
  for (let k = 0; k < count; k++) {
    ends(k, a, b);
    const dLat = (b[1] - a[1]) * D2R;
    const dLon = (b[0] - a[0]) * D2R;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
    const ang = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    segs[k] = Math.max(1, Math.min(16, Math.ceil(ang / (4 * D2R))));
    total += segs[k] + 1;
  }
  const path = new Float32Array(total * 3);
  const startIndices = new Uint32Array(count);
  let v = 0;
  for (let k = 0; k < count; k++) {
    ends(k, a, b);
    startIndices[k] = v;
    const n = segs[k];
    const la0 = a[1] * D2R, lo0 = a[0] * D2R, la1 = b[1] * D2R, lo1 = b[0] * D2R;
    const x0 = Math.cos(la0) * Math.cos(lo0), y0 = Math.cos(la0) * Math.sin(lo0), z0 = Math.sin(la0);
    const x1 = Math.cos(la1) * Math.cos(lo1), y1 = Math.cos(la1) * Math.sin(lo1), z1 = Math.sin(la1);
    const ang = Math.acos(Math.max(-1, Math.min(1, x0 * x1 + y0 * y1 + z0 * z1)));
    const lift = Math.min(ang * 6.371e6 * liftK, 250e3);
    const so = Math.sin(ang);
    let prevLon = a[0];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      let x, y, z;
      if (so < 1e-6) {
        x = x0 + (x1 - x0) * t; y = y0 + (y1 - y0) * t; z = z0 + (z1 - z0) * t;
      } else {
        const w0 = Math.sin((1 - t) * ang) / so;
        const w1 = Math.sin(t * ang) / so;
        x = w0 * x0 + w1 * x1; y = w0 * y0 + w1 * y1; z = w0 * z0 + w1 * z1;
      }
      let lon = Math.atan2(y, x) / D2R;
      // Keep longitudes continuous across the antimeridian.
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
      prevLon = lon;
      path[3 * v] = lon;
      path[3 * v + 1] = Math.atan2(z, Math.hypot(x, y)) / D2R;
      path[3 * v + 2] = a[2] + (b[2] - a[2]) * t + lift * Math.sin(Math.PI * t);
      v++;
    }
  }
  return { length: count, startIndices, attributes: { getPath: { value: path, size: 3 } } };
}

const arcCache = new Map();
function cachedArcs(key, count, ends, liftK) {
  if (!arcCache.has(key)) {
    if (arcCache.size > 6) arcCache.clear();
    arcCache.set(key, buildArcs(count, ends, liftK));
  }
  return arcCache.get(key);
}

// --- fiber bundles -------------------------------------------------------
// Links whose two ends fall in the same pair of grid cells (after PoP
// re-attachment and the current filters) are merged into one fiber between
// the centroids of their ends, drawn with width ~ log2(1 + count). Members
// are hidden under their fiber. The cell size is a slider: metro-to-metro at
// small sizes, region-to-region at large ones. Works in cyber mode too, where
// it bundles links between nearby clusters of the layout.
const FIBER_MIN = 2; // links needed to form a fiber
function fiberCellSize() {
  return 1.25e-4 * Math.pow(128, state.fiberCell); // mercator units (1 = world)
}

let fiberCache = { key: null, value: null };
function computeFibers() {
  const K = sampleK();
  const key = `${state.mode}|${usePops()}|${state.fiberCell}|${K}|${state.showTransit}|${state.showPeering}|${state.backboneOnly}|${state.view}|${state.altitude}`;
  if (fiberCache.key === key) return fiberCache.value;
  const cell = fiberCellSize();
  const inv = 1 / cell;
  const W = Math.ceil(inv) + 2; // cells per row; ids < 2^26 for cell >= 1.25e-4
  const merc = (lon, lat) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  };
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const lf = edgeLengthFactor(state.mode);
  const index = new Map();
  const edgeBundle = new Int32Array(G.e).fill(-1);
  // per-bundle accumulators (grown as needed)
  let cap = 1 << 16;
  const NF = 13;
  let acc = new Float64Array(cap * NF); // ax ay az bx by bz r g b count transit peering inkSum
  let nb = 0;
  for (let k = 0; k < G.e; k++) {
    if (G.edge_rank && G.edge_rank[k] > K) continue;
    if (!edgeVisible(k)) continue;
    endPos(k, 0, a);
    endPos(k, 1, b);
    const [xa, ya] = merc(a[0], a[1]);
    const [xb, yb] = merc(b[0], b[1]);
    const ca = Math.floor(ya * inv) * W + Math.floor(xa * inv);
    const cb = Math.floor(yb * inv) * W + Math.floor(xb * inv);
    if (ca === cb) continue; // local: stays a plain link
    const swap = ca > cb;
    const pk = (swap ? cb : ca) * 67108864 + (swap ? ca : cb);
    let bi = index.get(pk);
    if (bi === undefined) {
      bi = nb++;
      index.set(pk, bi);
      if (nb > cap) {
        const grown = new Float64Array(cap * 2 * NF);
        grown.set(acc);
        acc = grown;
        cap *= 2;
      }
    }
    const o = bi * NF;
    const [sx, sy, sz, tx, ty, tz] = swap ? [xb, yb, b[2], xa, ya, a[2]] : [xa, ya, a[2], xb, yb, b[2]];
    acc[o] += sx, acc[o + 1] += sy, acc[o + 2] += sz;
    acc[o + 3] += tx, acc[o + 4] += ty, acc[o + 5] += tz;
    acc[o + 6] += edgeColor[k * 4], acc[o + 7] += edgeColor[k * 4 + 1], acc[o + 8] += edgeColor[k * 4 + 2];
    acc[o + 9] += 1;
    acc[o + (G.edge_rel[k] === -1 ? 10 : 11)] += 1;
    acc[o + 12] += (edgeColor[k * 4 + 3] / 255) * lf[k]; // the link's own brightness
    edgeBundle[k] = bi;
  }
  // keep bundles with enough members, biggest last (drawn on top)
  const keep = [];
  for (let i = 0; i < nb; i++) if (acc[i * NF + 9] >= FIBER_MIN) keep.push(i);
  keep.sort((x, y) => acc[x * NF + 9] - acc[y * NF + 9]);
  const remap = new Int32Array(nb).fill(-1);
  keep.forEach((bi, j) => (remap[bi] = j));
  const toLonLat = (x, y) => [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
  const fibers = keep.map((bi) => {
    const o = bi * NF;
    const c = acc[o + 9];
    const [slon, slat] = toLonLat(acc[o] / c, acc[o + 1] / c);
    const [tlon, tlat] = toLonLat(acc[o + 3] / c, acc[o + 4] / c);
    return {
      source: [slon, slat, acc[o + 2] / c],
      target: [tlon, tlat, acc[o + 5] / c],
      color: [acc[o + 6] / c, acc[o + 7] / c, acc[o + 8] / c],
      count: c,
      transit: acc[o + 10],
      peering: acc[o + 11],
      ink: acc[o + 12], // sum of member brightness, conserved by the fiber
    };
  });
  const hidden = new Uint8Array(G.e);
  let bundled = 0;
  for (let k = 0; k < G.e; k++) {
    if (edgeBundle[k] >= 0 && remap[edgeBundle[k]] >= 0) {
      hidden[k] = 1;
      bundled++;
    }
  }
  fiberCache = { key, value: { fibers, hidden, bundled } };
  return fiberCache.value;
}

function fiberLayers(globeView, opacity) {
  const { fibers } = computeFibers();
  if (!fibers.length) return [];
  const w = (f) => 1 + Math.log2(1 + f.count) * (0.4 + 2.4 * state.fiberWidth);
  // Ink: brightness x width follows what the hidden member links added (x2,
  // so fibers stand out over the unbundled links), with the same
  // zoom-dependent opacity as links.
  const alpha = (f, k) => Math.max(8, Math.min(255, (255 * k * f.ink) / w(f)));
  const col = (k) => (f) => [f.color[0], f.color[1], f.color[2], alpha(f, k)];
  const fOpacity = Math.min(1, opacity * 1.5);
  const make = (id, width, k, pickable) => {
    if (globeView) {
      const data = buildArcs(fibers.length, (i, a, b) => {
        a[0] = fibers[i].source[0], a[1] = fibers[i].source[1], a[2] = fibers[i].source[2];
        b[0] = fibers[i].target[0], b[1] = fibers[i].target[1], b[2] = fibers[i].target[2];
      }, 0.04);
      return new PathLayer({
        id,
        data,
        _pathType: 'open',
        getColor: (_, { index }) => col(k)(fibers[index]),
        getWidth: (_, { index }) => width(fibers[index]),
        widthUnits: 'pixels',
        billboard: true,
        opacity: fOpacity,
        pickable,
        parameters: blendParams(true),
      });
    }
    return new LineLayer({
      id,
      data: fibers,
      getSourcePosition: (f) => f.source,
      getTargetPosition: (f) => f.target,
      getColor: col(k),
      getWidth: width,
      widthUnits: 'pixels',
      opacity: fOpacity,
      pickable,
      parameters: blendParams(false),
      updateTriggers: { getColor: fiberCache.key, getWidth: `${fiberCache.key}|${state.fiberWidth}` },
    });
  };
  // a faint halo under a core that carries most of the ink
  return [make('fibers-glow', (f) => w(f) * 2.5, 0.2, false), make('fibers', w, 2.0, true)];
}

// --- layers --------------------------------------------------------------

const additive = {
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
};

function blendParams(globeView) {
  const p = state.glow ? { ...additive } : {};
  p.depthWriteEnabled = false;
  p.depthCompare = globeView ? 'less-equal' : 'always';
  return p;
}

// Traceroute-style sampling (edge_rank = first vantage tree using the link).
const FULL_RANK = 255;
function sampleK() {
  if (state.sampling >= 1) return FULL_RANK;
  return Math.max(0, Math.floor(Math.pow(FULL_RANK, state.sampling)) - 1);
}
let rankCum = null; // links visible at each k
function visibleAtK(k) {
  if (!G?.edge_rank) return G ? G.e : 1;
  if (!rankCum) {
    rankCum = new Uint32Array(256);
    for (let i = 0; i < G.e; i++) rankCum[G.edge_rank[i]]++;
    for (let i = 1; i < 256; i++) rankCum[i] += rankCum[i - 1];
  }
  return rankCum[k];
}
function samplingLabel() {
  const k = sampleK();
  const v = visibleAtK(k);
  const what = k >= FULL_RANK ? 'all links' : k === 0 ? '1 vantage tree' : `${k + 1} vantage trees`;
  return `${what} · ${fmt(v)} links`;
}

// Per-line opacity. Hundreds of thousands of additive lines blow out to white
// at world scale, so lines start faint and brighten as you zoom in and they
// spread apart. A layer uniform, so changing it is free.
let globeZoom = 1;
function edgeOpacity(globeView) {
  const z = globeView ? globeZoom + 0.6 : map.getZoom();
  let k = (state.glow ? 0.0025 : 0.007) * Math.pow(state.edgeAlpha / 0.35, 2);
  if (state.backboneOnly && G) k *= G.e / Math.max(G.meta.counts.backbone || G.e, 1) / 1.5;
  else if (G) k *= Math.pow(G.e / Math.max(visibleAtK(sampleK()), 1), 0.6);
  return Math.min(1, k * Math.pow(2, z));
}

let pending = false;
function renderSoon() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

function edgeVisible(k) {
  if (state.backboneOnly && G.edge_backbone && !G.edge_backbone[k]) return false;
  const rel = G.edge_rel[k];
  if (rel === -1 && !state.showTransit) return false;
  if (rel !== -1 && !state.showPeering) return false;
  return visibleNode(G.edges[2 * k]) && visibleNode(G.edges[2 * k + 1]);
}

const TRANSITION = { duration: 1400, easing: (t) => t * t * (3 - 2 * t) };

const showVectorsFor = (globeView) => state.renderer === 'vector' || globeView;

function networkLayers(globeView) {
  if (!G) return [];
  const trig = `${state.mode}|${state.view}|${state.altitude}|${usePops()}`;
  const opacity = edgeOpacity(globeView);
  const lf = edgeLengthFactor(state.mode);
  const fib = state.fibers && showVectorsFor(globeView) ? computeFibers() : null;
  const hidden = fib ? fib.hidden : null;
  const colourTrig = `${state.mode}|${state.showTransit}|${state.showPeering}|${state.backboneOnly}|${usePops()}|${state.fibers ? fiberCache.key ?? 'f' : ''}`;
  const getEdgeColor = (_, { index, target }) => {
    const o = index * 4;
    target[0] = edgeColor[o];
    target[1] = edgeColor[o + 1];
    target[2] = edgeColor[o + 2];
    // with fibers on, links left out of any fiber recede so the bundles read
    target[3] = edgeVisible(index) && !(hidden && hidden[index]) ? edgeColor[o + 3] * lf[index] * (hidden ? 0.5 : 1) : 0;
    return target;
  };
  const edgeData = { length: G.e };
  const src = (_, { index, target }) => endPos(index, 0, target);
  const dst = (_, { index, target }) => endPos(index, 1, target);
  const layers = [];
  const showVectors = state.renderer === 'vector' || globeView;

  if (showVectors) {
    if (globeView) {
      const data = cachedArcs(`edges|${trig}`, G.e, (k, a, b) => (endPos(k, 0, a), endPos(k, 1, b)), 0.03);
      layers.push(
        new PathLayer({
          id: 'edges',
          data,
          _pathType: 'open',
          getColor: getEdgeColor,
          opacity,
          extensions: G.edge_rank ? [new DataFilterExtension({ filterSize: 1 })] : [],
          getFilterValue: (_, { index }) => (G.edge_rank ? G.edge_rank[index] : 0),
          filterRange: [0, sampleK()],
          getWidth: 1,
          widthUnits: 'pixels',
          billboard: true,
          parameters: blendParams(true),
          updateTriggers: { getColor: colourTrig },
        }),
      );
    } else {
      layers.push(
        new LineLayer({
          id: 'edges',
          data: edgeData,
          getSourcePosition: src,
          getTargetPosition: dst,
          getColor: getEdgeColor,
          opacity,
          extensions: G.edge_rank ? [new DataFilterExtension({ filterSize: 1 })] : [],
          getFilterValue: (_, { index }) => (G.edge_rank ? G.edge_rank[index] : 0),
          filterRange: [0, sampleK()],
          getWidth: 1,
          widthUnits: 'pixels',
          parameters: blendParams(false),
          updateTriggers: { getSourcePosition: trig, getTargetPosition: trig, getColor: colourTrig },
          transitions: { getSourcePosition: TRANSITION, getTargetPosition: TRANSITION },
        }),
      );
    }
  }

  if (usePops() && showVectors && G.pop_routes) {
    const routeData = { length: G.pop_routes.length / 2 };
    const rsrc = (_, { index, target }) => popPos(G.pop_routes[2 * index], target);
    const rdst = (_, { index, target }) => popPos(G.pop_routes[2 * index + 1], target);
    const rlf = routeLengthFactor();
    const rcol = (_, { index, target }) => {
      const o = G.pop_node[G.pop_routes[2 * index]] * 4;
      target[0] = nodeColor[o];
      target[1] = nodeColor[o + 1];
      target[2] = nodeColor[o + 2];
      target[3] = 255 * rlf[index];
      return target;
    };
    // Core routes are few (25k) next to the links, so they can be brighter.
    const routeOpacity = Math.min(0.8, opacity * 2.5);
    const common = {
      id: 'routes',
      data: routeData,
      getSourcePosition: rsrc,
      getTargetPosition: rdst,
      opacity: routeOpacity,
      getWidth: 1.2,
      widthUnits: 'pixels',
      parameters: blendParams(globeView),
      updateTriggers: { getSourcePosition: trig, getTargetPosition: trig },
    };
    if (globeView) {
      const r = G.pop_routes;
      const data = cachedArcs(`routes|${trig}`, routeData.length, (k, a, b) => (popPos(r[2 * k], a), popPos(r[2 * k + 1], b)), 0.03);
      layers.push(
        new PathLayer({
          id: 'routes',
          data,
          _pathType: 'open',
          getColor: rcol,
          opacity: routeOpacity,
          updateTriggers: { getColor: G.id },
          getWidth: 1.2,
          widthUnits: 'pixels',
          billboard: true,
          parameters: blendParams(true),
        }),
      );
    } else {
      layers.push(new LineLayer({ ...common, getColor: rcol }));
    }
  }

  if (fib) layers.push(...fiberLayers(globeView, opacity));

  // Selection: the selected AS's links, bright.
  if (state.selected !== null) {
    const nb = G.neighbours(state.selected);
    const sideOf = (d) => (G.edges[2 * d.edge] === state.selected ? 0 : 1);
    const selColor = (d) => (G.edge_rel[d.edge] === -1 ? [255, 255, 255, 200] : [140, 220, 255, 150]);
    if (globeView) {
      const data = buildArcs(nb.length, (k, a, b) => (endPos(nb[k].edge, sideOf(nb[k]), a), endPos(nb[k].edge, 1 - sideOf(nb[k]), b)), 0.05);
      layers.push(
        new PathLayer({
          id: 'sel-edges',
          data,
          _pathType: 'open',
          getColor: (_, { index }) => selColor(nb[index]),
          getWidth: 1.5,
          widthUnits: 'pixels',
          billboard: true,
          parameters: blendParams(true),
        }),
      );
    } else {
      layers.push(
        new LineLayer({
          id: 'sel-edges',
          data: nb,
          getSourcePosition: (d, { target }) => endPos(d.edge, sideOf(d), target),
          getTargetPosition: (d, { target }) => endPos(d.edge, 1 - sideOf(d), target),
          getColor: selColor,
          getWidth: 1.5,
          widthUnits: 'pixels',
          parameters: blendParams(false),
          updateTriggers: { getSourcePosition: trig, getTargetPosition: trig },
        }),
      );
    }
  }

  const pops = usePops();
  const z = globeView ? globeZoom + 0.6 : map.getZoom();
  const sizeK = (0.25 + state.nodeSize * 2.2) * Math.min(1.6, 0.45 + 0.13 * z);
  const nodeOpacity = Math.min(0.9, 0.1 * Math.pow(2, z - 1) * (state.glow ? 1 : 2.5));
  layers.push(
    new ScatterplotLayer({
      id: 'nodes',
      data: { length: G.n },
      getPosition: (_, { index, target }) => pos(index, target),
      getRadius: (_, { index }) => (visibleNode(index) && !(pops && hasPops(index)) ? 0.6 + Math.log2(G.degree[index] + 1) * 0.55 : 0),
      getFillColor: (_, { index, target }) => {
        const o = index * 4;
        target[0] = nodeColor[o];
        target[1] = nodeColor[o + 1];
        target[2] = nodeColor[o + 2];
        target[3] = showVectors ? 255 : 0;
        return target;
      },
      radiusUnits: 'pixels',
      billboard: true,
      radiusMinPixels: 0,
      radiusScale: sizeK,
      opacity: nodeOpacity,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 255],
      parameters: blendParams(globeView),
      updateTriggers: { getPosition: trig, getRadius: `${state.mode}|${pops}`, getFillColor: `${showVectors}` },
      transitions: { getPosition: TRANSITION },
    }),
  );

  if (pops) {
    layers.push(
      new ScatterplotLayer({
        id: 'pops',
        data: { length: G.pop_node.length },
        getPosition: (_, { index, target }) => popPos(index, target),
        getRadius: (_, { index }) => {
          const i = G.pop_node[index];
          const w = Math.sqrt(G.pop_offset[i + 1] - G.pop_offset[i]);
          return 0.8 + (Math.log2(G.degree[i] + 1) * 0.55) / w;
        },
        getFillColor: (_, { index, target }) => {
          const o = G.pop_node[index] * 4;
          target[0] = nodeColor[o];
          target[1] = nodeColor[o + 1];
          target[2] = nodeColor[o + 2];
          target[3] = showVectors ? 255 : 0;
          return target;
        },
        radiusUnits: 'pixels',
        billboard: true,
        radiusScale: sizeK,
        opacity: Math.min(1, nodeOpacity * 1.5),
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 255],
        parameters: blendParams(globeView),
        updateTriggers: { getPosition: trig, getFillColor: `${showVectors}` },
      }),
    );
  }

  if (state.selected !== null) {
    layers.push(
      new ScatterplotLayer({
        id: 'sel-node',
        data: [state.selected],
        getPosition: (i, { target }) => pos(i, target),
        getRadius: 9,
        radiusUnits: 'pixels',
        billboard: true,
        stroked: true,
        filled: false,
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 2,
        parameters: { depthCompare: 'always' },
        updateTriggers: { getPosition: trig },
      }),
    );
  }
  return layers;
}

const earth = (() => {
  const land = feature(countries110, countries110.objects.countries);
  return [
    new SolidPolygonLayer({
      id: 'ocean',
      data: [{ polygon: [[-180, 90], [0, 90], [180, 90], [180, -90], [0, -90], [-180, -90]] }],
      getPolygon: (d) => d.polygon,
      getFillColor: [6, 10, 22, 255],
    }),
    new GeoJsonLayer({
      id: 'land',
      data: land,
      filled: true,
      stroked: true,
      getFillColor: [22, 28, 40, 255],
      getLineColor: [60, 72, 96, 255],
      lineWidthMinPixels: 0.5,
    }),
  ];
})();

function render() {
  const globeView = state.view === 'globe';
  $('map').hidden = globeView;
  $('globe').hidden = !globeView;
  if (globeView) {
    ensureGlobe().setProps({ layers: [...earth, ...networkLayers(true)] });
    overlay.setProps({ layers: [] });
  } else {
    overlay.setProps({ layers: networkLayers(false), onHover, onClick });
    if (map.getLayer('base')) map.setPaintProperty('base', 'raster-opacity', basemapOpacity());
  }
  syncControls();
  writeHash();
}

// --- interaction ---------------------------------------------------------

function pickedNode(info) {
  if (info.index < 0 || !info.layer) return null;
  if (info.layer.id === 'nodes') return info.index;
  if (info.layer.id === 'pops') return G.pop_node[info.index];
  return null;
}

function onHover(info) {
  const tip = $('tooltip');
  const picked = pickedNode(info);
  if (picked !== null) {
    const i = picked;
    tip.hidden = false;
    tip.textContent = `AS${G.asn[i]} · ${G.names[i]} · ${G.degree[i]} links`;
    tip.style.left = `${info.x + 12}px`;
    tip.style.top = `${info.y + 12}px`;
  } else if (info.layer?.id === 'fibers' && info.index >= 0) {
    const f = computeFibers().fibers[info.index];
    tip.hidden = false;
    tip.textContent = `fiber: ${fmt(f.count)} links (${fmt(f.transit)} transit, ${fmt(f.peering)} peering)`;
    tip.style.left = `${info.x + 12}px`;
    tip.style.top = `${info.y + 12}px`;
  } else {
    tip.hidden = true;
  }
}

function onClick(info) {
  const picked = pickedNode(info);
  if (picked !== null) select(picked, false);
  else if (!info.layer) select(null);
}

async function select(i, fly = true) {
  state.selected = i;
  render();
  if (i === null) {
    $('info').hidden = true;
    return;
  }
  if (fly) flyTo(i);
  const rec = await G.info(i);
  if (state.selected !== i) return;
  showInfo(i, rec);
}

function flyTo(i) {
  const p = G[`pos_${state.mode}`];
  const lon = p[2 * i];
  const lat = p[2 * i + 1];
  if (state.view === 'globe') {
    const vs = { longitude: lon, latitude: lat, zoom: 2.2, transitionDuration: 1200 };
    globeCam = vs;
    ensureGlobe().setProps({ initialViewState: vs });
  } else {
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), state.mode === 'cyber' ? 5 : 6), speed: 1.4 });
  }
}

const fmt = (x) => x.toLocaleString('en-US');

function showInfo(i, r) {
  const nb = G.neighbours(i)
    .map((d) => ({ ...d, deg: G.degree[d.node] }))
    .sort((a, b) => b.deg - a.deg);
  const relOf = (d) => {
    if (G.edge_rel[d.edge] !== -1) return 'peer';
    return G.edges[2 * d.edge] === i ? 'customer' : 'provider';
  };
  const slash24 = r.addrs / 256;
  const sites = r.sites
    .map(([lat, lon, share, city]) => `<li>${esc(city || '?')} <span class="muted">${(share * 100).toFixed(0)}%</span></li>`)
    .join('');
  const pfx = r.prefixes.map((p) => `<li>${p}</li>`).join('');
  const nbrs = nb
    .slice(0, 40)
    .map((d) => `<li data-i="${d.node}"><span class="asn">AS${G.asn[d.node]}</span> ${esc(G.names[d.node])} <span class="muted">(${relOf(d)})</span></li>`)
    .join('');
  $('infoBody').innerHTML = `
    <h2><span class="asn">AS${r.asn}</span> ${esc(r.name)}</h2>
    ${r.as_name && r.as_name !== r.name ? `<div class="muted">${esc(r.as_name)}</div>` : ''}
    <dl>
      <dt>Country</dt><dd>${esc(r.country || '—')} · ${esc(G.meta.regions[G.region[i]].name)}</dd>
      <dt>Rank</dt><dd>#${fmt(r.rank)} by customer cone</dd>
      <dt>Links</dt><dd>${fmt(r.degree)} — ${fmt(r.providers)} providers, ${fmt(r.customers)} customers, ${fmt(r.peers)} peers</dd>
      <dt>Cone</dt><dd>${fmt(r.cone)} ASes</dd>
      <dt>k-core</dt><dd>${r.coreness}</dd>
      <dt>IPv4</dt><dd>${fmt(r.addrs)} addrs (${slash24 >= 1 ? fmt(Math.round(slash24)) + ' /24s' : '< /24'}), ${fmt(r.nprefix)} ranges</dd>
      <dt>Geo</dt><dd>${r.sites.length ? `${(r.concentration * 100).toFixed(0)}% near main site · ${r.pinned ? 'pinned' : 'floating'} in hybrid` : 'no geolocation'}</dd>
    </dl>
    ${sites ? `<h3>Sites</h3><ul>${sites}</ul>` : ''}
    ${pfx ? `<h3>Prefixes${r.nprefix > r.prefixes.length ? ` (largest ${r.prefixes.length})` : ''}</h3><ul class="prefixes">${pfx}</ul>` : ''}
    <h3>Neighbours${nb.length > 40 ? ` (top 40 of ${fmt(nb.length)})` : ''}</h3>
    <ul class="nbrs">${nbrs}</ul>
    <h3>Elsewhere</h3>
    <ul>
      <li><a href="https://bgp.tools/as/${r.asn}" target="_blank" rel="noopener">bgp.tools</a> ·
          <a href="https://bgp.he.net/AS${r.asn}" target="_blank" rel="noopener">Hurricane Electric</a> ·
          <a href="https://asrank.caida.org/asns/${r.asn}" target="_blank" rel="noopener">CAIDA ASRank</a> ·
          <a href="https://www.peeringdb.com/asn/${r.asn}" target="_blank" rel="noopener">PeeringDB</a></li>
    </ul>`;
  $('info').hidden = false;
  for (const li of $('infoBody').querySelectorAll('.nbrs li')) {
    li.addEventListener('click', () => select(Number(li.dataset.i)));
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// --- search --------------------------------------------------------------

let lowerNames = [];
function search(q) {
  q = q.trim().toLowerCase().replace(/^as/, '');
  const out = [];
  if (!q || !G) return out;
  if (/^\d+$/.test(q)) {
    const exact = G.byAsn.get(Number(q));
    if (exact !== undefined) out.push(exact);
  }
  const hits = [];
  for (let i = 0; i < G.n && hits.length < 400; i++) {
    if (lowerNames[i].includes(q) || String(G.asn[i]).startsWith(q)) hits.push(i);
  }
  hits.sort((a, b) => G.degree[b] - G.degree[a]);
  for (const i of hits) if (!out.includes(i) && out.length < 25) out.push(i);
  return out;
}

function wireSearch() {
  const input = $('search');
  const list = $('results');
  let items = [];
  let active = 0;
  const draw = () => {
    list.innerHTML = items
      .map((i, k) => `<li data-i="${i}" class="${k === active ? 'active' : ''}"><span class="asn">AS${G.asn[i]}</span>${esc(G.names[i])}</li>`)
      .join('');
  };
  input.addEventListener('input', () => {
    items = search(input.value);
    active = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') active = Math.min(active + 1, items.length - 1);
    else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0);
    else if (e.key === 'Enter' && items[active] !== undefined) {
      select(items[active]);
      list.innerHTML = '';
      input.blur();
      return;
    } else return;
    e.preventDefault();
    draw();
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) {
      select(Number(li.dataset.i));
      list.innerHTML = '';
    }
  });
}

// --- controls ------------------------------------------------------------

function syncControls() {
  $('samplingLabel').textContent = G ? samplingLabel() : '';
  const fib = state.fibers && G && fiberCache.value;
  $('fiberLabel').textContent = fib
    ? `~${Math.round(fiberCellSize() * 40075)} km cells · ${fmt(fib.fibers.length)} fibers carrying ${fmt(fib.bundled)} links`
    : '';
  for (const b of $('mode').children) b.classList.toggle('on', b.dataset.v === state.mode);
  for (const b of $('view').children) b.classList.toggle('on', b.dataset.v === state.view);
  $('basemap').value = state.basemap;
  $('basemap').disabled = state.view === 'globe';
  $('renderer').disabled = state.view === 'globe';
  $('renderer').value = state.renderer;
}

function writeHash() {
  const h = new URLSearchParams();
  if (G) h.set('data', G.id);
  for (const [field, key, type] of PARAMS) {
    const v = state[field];
    h.set(key, type === 'bool' ? (v ? '1' : '0') : type === 'num' ? String(+v.toFixed(2)) : v);
  }
  // camera: the globe's when it's showing (zoom stored in map units)
  if (state.view === 'globe' && globeCam) {
    h.set('lon', globeCam.longitude.toFixed(3));
    h.set('lat', globeCam.latitude.toFixed(3));
    h.set('z', (globeCam.zoom + 0.6).toFixed(2));
  } else {
    const c = map.getCenter();
    h.set('lon', c.lng.toFixed(3));
    h.set('lat', c.lat.toFixed(3));
    h.set('z', map.getZoom().toFixed(2));
  }
  if (state.selected !== null && G) h.set('as', G.asn[state.selected]);
  history.replaceState(null, '', `#${h}`);
}

let hashTimer = null;
function writeHashSoon() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHash, 250);
}

// Push state into every control (on load, and whenever state changes in code).
function applyControls() {
  for (const [field, , type] of PARAMS) {
    const el = $(field);
    if (!el) continue;
    if (type === 'bool') el.checked = state[field];
    else if (type === 'num') el.value = Math.round(state[field] * 100);
    else if (el.tagName === 'SELECT') el.value = state[field];
  }
  syncControls();
}

function wireControls() {
  $('mode').addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v) return;
    state.mode = v;
    updateRaster();
    render();
  });
  $('view').addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v || v === state.view) return;
    if (v === 'globe') {
      const c = map.getCenter();
      const zoom = Math.max(map.getZoom() - 0.6, 0);
      ensureGlobe().setProps({ initialViewState: (globeCam = { longitude: c.lng, latitude: c.lat, zoom }) });
      globeZoom = zoom; // link opacity follows the globe's zoom; keep it in sync
    }
    state.view = v;
    render();
  });
  $('basemap').addEventListener('change', (e) => setBasemap(e.target.value));
  $('renderer').addEventListener('change', (e) => {
    state.renderer = e.target.value;
    updateRaster();
    render();
  });
  const slider = (id, key) =>
    $(id).addEventListener('input', (e) => {
      state[key] = Number(e.target.value) / 100;
      render();
    });
  slider('edgeAlpha', 'edgeAlpha');
  slider('nodeSize', 'nodeSize');
  slider('altitude', 'altitude');
  $('sampling').value = Math.round(state.sampling * 100);
  slider('sampling', 'sampling');
  $('fiberCell').value = Math.round(state.fiberCell * 100);
  slider('fiberCell', 'fiberCell');
  slider('fiberWidth', 'fiberWidth');
  for (const [id, key] of [['showTransit', 'showTransit'], ['showPeering', 'showPeering'], ['glow', 'glow'], ['backboneOnly', 'backboneOnly'], ['pops', 'pops'], ['fibers', 'fibers']]) {
    $(id).checked = state[key];
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.checked;
      if (key === 'backboneOnly') updateRaster();
      render();
    });
  }
  $('close').addEventListener('click', () => select(null));
  $('dataset').addEventListener('change', (e) => {
    state.dataset = e.target.value;
    state.selected = null;
    $('info').hidden = true;
    load(state.dataset);
  });
  map.on('moveend', writeHash);
  map.on('zoom', renderSoon);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const modes = { 1: 'cyber', 2: 'hybrid', 3: 'geo' };
    if (modes[e.key]) {
      state.mode = modes[e.key];
      updateRaster();
      render();
    } else if (e.key === 'g') {
      $('view').querySelector(`[data-v="${state.view === 'globe' ? 'map' : 'globe'}"]`).click();
    } else if (e.key === 'Escape') select(null);
    else if (e.key === '/') {
      e.preventDefault();
      $('search').focus();
    }
  });
}

// --- boot ----------------------------------------------------------------

async function load(id) {
  $('stats').textContent = 'loading…';
  G = await loadBundle(DATA_BASE, id);
  rankCum = null;
  routeLF = null;
  fiberCache = { key: null, value: null };
  arcCache.clear();
  for (const k of Object.keys(lengthFactor)) delete lengthFactor[k];
  lowerNames = G.names.map((s) => s.toLowerCase());
  buildColours();
  tilesMeta = {};
  for (const m of G.meta.modes.flatMap((m) => [m, `backbone/${m}`])) {
    try {
      const r = await fetch(`${G.root}/tiles/${m}/tiles.json`);
      if (r.ok) tilesMeta[m] = await r.json();
    } catch {
      /* no tiles */
    }
  }
  const hasTiles = TILE_SERVER || Object.keys(tilesMeta).length > 0;
  $('renderer').querySelector('[value="raster"]').disabled = !hasTiles;
  if (!hasTiles) state.renderer = 'vector';
  applyControls();

  const m = G.meta;
  $('banner').hidden = !m.synthetic;
  $('banner').innerHTML = m.synthetic
    ? '<b>Synthetic topology.</b> ASes, names, prefixes and geography are real; the links between them are generated. Build with CAIDA data for the real graph.'
    : '';
  $('legend').innerHTML = m.regions
    .map((r) => `<li><i style="color: rgb(${r.rgb.join(',')}); background: rgb(${r.rgb.join(',')})"></i>${esc(r.name.split(' /')[0])}</li>`)
    .join('');
  const c = m.counts;
  $('stats').innerHTML = `${fmt(c.nodes)} ASes · ${fmt(c.edges)} links (${fmt(c.p2c)} transit, ${fmt(c.p2p)} peering) · ${fmt(c.geolocated)} geolocated, ${fmt(c.pinned)} pinned${c.backbone ? ` · ${fmt(c.backbone)} backbone` : ''}<br>${m.attribution.join('<br>')}`;
  map.getContainer().querySelector('.maplibregl-ctrl-attrib-inner');
  updateRaster();
  render();

  const want = hash.get('as');
  if (want && G.byAsn.has(Number(want))) select(G.byAsn.get(Number(want)), false);
}

async function boot() {
  wireControls();
  applyControls();
  wireSearch();
  const sets = await listDatasets(DATA_BASE);
  if (!sets.length) {
    $('stats').innerHTML = 'No datasets found. Run <code>python -m netmap build</code> first (see README).';
    return;
  }
  $('dataset').innerHTML = sets
    .map((s) => `<option value="${s.id}">${esc(s.name)}${s.synthetic ? ' (synthetic)' : ''} — ${fmt(s.counts.nodes)} ASes</option>`)
    .join('');
  if (!state.dataset || !sets.some((s) => s.id === state.dataset)) state.dataset = sets[0].id;
  $('dataset').value = state.dataset;
  map.on('load', () => updateRaster());
  await load(state.dataset);
}

// Console / automation handle: netmap.state, netmap.render(), netmap.layers().
window.netmap = {
  state,
  render: () => render(),
  layers: () => (state.view === 'globe' ? globe?.props.layers : overlay._props?.layers || []).map((l) => l.id),
};

boot();
