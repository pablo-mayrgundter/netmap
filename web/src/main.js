import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Deck, _GlobeView as GlobeView } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ArcLayer, LineLayer, ScatterplotLayer, GeoJsonLayer, SolidPolygonLayer } from '@deck.gl/layers';
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

const ALT_MAX_M = 2_500_000;

// --- state ---------------------------------------------------------------

const hash = new URLSearchParams(location.hash.slice(1));
const state = {
  dataset: hash.get('data') || params.get('data') || null,
  mode: hash.get('mode') || 'hybrid',
  view: hash.get('view') || 'map',
  basemap: hash.get('basemap') || 'dark',
  renderer: 'vector',
  edgeAlpha: 0.35,
  nodeSize: 0.4,
  altitude: 0.5,
  showTransit: true,
  showPeering: true,
  glow: true,
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
function ensureGlobe() {
  if (globe) return globe;
  const c = map.getCenter();
  globe = new Deck({
    parent: $('globe'),
    views: new GlobeView({ resolution: 5 }),
    initialViewState: { longitude: c.lng, latitude: c.lat, zoom: Math.max(map.getZoom() - 0.6, 0) },
    controller: true,
    layers: [],
    onHover: onHover,
    onClick: onClick,
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
  const tm = tilesMeta[state.mode] || {};
  map.addSource('net', {
    type: 'raster',
    tiles: [`${base}/${state.mode}/{z}/{x}/{y}.png`],
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

// --- positions -----------------------------------------------------------

const hasGeo = (i) => (G.flags[i] & 1) === 1;
const visibleNode = (i) => state.mode !== 'geo' || hasGeo(i);

function altitude(i) {
  if (state.view !== 'globe') return 0;
  const l = G.level[i];
  return Math.pow(l, 1.8) * ALT_MAX_M * state.altitude * 2;
}

function pos(i, target) {
  const p = G[`pos_${state.mode}`];
  target[0] = p[2 * i];
  target[1] = p[2 * i + 1];
  target[2] = altitude(i);
  return target;
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

function edgeVisible(k) {
  const rel = G.edge_rel[k];
  if (rel === -1 && !state.showTransit) return false;
  if (rel !== -1 && !state.showPeering) return false;
  return visibleNode(G.edges[2 * k]) && visibleNode(G.edges[2 * k + 1]);
}

const TRANSITION = { duration: 1400, easing: (t) => t * t * (3 - 2 * t) };

function networkLayers(globeView) {
  if (!G) return [];
  const trig = `${state.mode}|${state.view}|${state.altitude}`;
  const colourTrig = `${state.mode}|${state.edgeAlpha}|${state.showTransit}|${state.showPeering}|${state.glow}`;
  const edgeA = state.glow ? state.edgeAlpha * 0.5 : state.edgeAlpha;
  const getEdgeColor = (_, { index, target }) => {
    const o = index * 4;
    target[0] = edgeColor[o];
    target[1] = edgeColor[o + 1];
    target[2] = edgeColor[o + 2];
    target[3] = edgeVisible(index) ? edgeColor[o + 3] * edgeA : 0;
    return target;
  };
  const edgeData = { length: G.e };
  const src = (_, { index, target }) => pos(G.edges[2 * index], target);
  const dst = (_, { index, target }) => pos(G.edges[2 * index + 1], target);
  const layers = [];
  const showVectors = state.renderer === 'vector' || globeView;

  if (showVectors) {
    if (globeView) {
      layers.push(
        new ArcLayer({
          id: 'edges',
          data: edgeData,
          getSourcePosition: src,
          getTargetPosition: dst,
          getSourceColor: getEdgeColor,
          getTargetColor: getEdgeColor,
          getHeight: (_, { index }) => 0.08 + 0.35 * Math.max(G.level[G.edges[2 * index]], G.level[G.edges[2 * index + 1]]) * state.altitude,
          greatCircle: true,
          numSegments: 20,
          getWidth: 1,
          widthUnits: 'pixels',
          parameters: blendParams(true),
          updateTriggers: { getSourcePosition: trig, getTargetPosition: trig, getSourceColor: colourTrig, getTargetColor: colourTrig, getHeight: trig },
          transitions: { getSourcePosition: TRANSITION, getTargetPosition: TRANSITION },
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
          getWidth: 1,
          widthUnits: 'pixels',
          parameters: blendParams(false),
          updateTriggers: { getSourcePosition: trig, getTargetPosition: trig, getColor: colourTrig },
          transitions: { getSourcePosition: TRANSITION, getTargetPosition: TRANSITION },
        }),
      );
    }
  }

  // Selection: the selected AS's links, bright.
  if (state.selected !== null) {
    const nb = G.neighbours(state.selected);
    const LinkLayer = globeView ? ArcLayer : LineLayer;
    layers.push(
      new LinkLayer({
        id: 'sel-edges',
        data: nb,
        getSourcePosition: (d, { target }) => pos(state.selected, target),
        getTargetPosition: (d, { target }) => pos(d.node, target),
        getColor: (d) => (G.edge_rel[d.edge] === -1 ? [255, 255, 255, 200] : [140, 220, 255, 150]),
        getSourceColor: [255, 255, 255, 220],
        getTargetColor: (d) => (G.edge_rel[d.edge] === -1 ? [255, 255, 255, 160] : [140, 220, 255, 120]),
        getHeight: 0.25,
        greatCircle: true,
        getWidth: 1.5,
        widthUnits: 'pixels',
        parameters: blendParams(globeView),
        updateTriggers: { getSourcePosition: trig, getTargetPosition: trig },
      }),
    );
  }

  const sizeK = 0.25 + state.nodeSize * 2.2;
  layers.push(
    new ScatterplotLayer({
      id: 'nodes',
      data: { length: G.n },
      getPosition: (_, { index, target }) => pos(index, target),
      getRadius: (_, { index }) => (visibleNode(index) ? (0.6 + Math.log2(G.degree[index] + 1) * 0.55) * sizeK : 0),
      getFillColor: (_, { index, target }) => {
        const o = index * 4;
        target[0] = nodeColor[o];
        target[1] = nodeColor[o + 1];
        target[2] = nodeColor[o + 2];
        target[3] = showVectors ? 210 : 0;
        return target;
      },
      radiusUnits: 'pixels',
      radiusMinPixels: 0,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 255],
      parameters: blendParams(globeView),
      updateTriggers: { getPosition: trig, getRadius: `${state.mode}|${state.nodeSize}`, getFillColor: `${showVectors}` },
      transitions: { getPosition: TRANSITION },
    }),
  );

  if (state.selected !== null) {
    layers.push(
      new ScatterplotLayer({
        id: 'sel-node',
        data: [state.selected],
        getPosition: (i, { target }) => pos(i, target),
        getRadius: 9,
        radiusUnits: 'pixels',
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

function onHover(info) {
  const tip = $('tooltip');
  if (info.layer?.id === 'nodes' && info.index >= 0) {
    const i = info.index;
    tip.hidden = false;
    tip.textContent = `AS${G.asn[i]} · ${G.names[i]} · ${G.degree[i]} links`;
    tip.style.left = `${info.x + 12}px`;
    tip.style.top = `${info.y + 12}px`;
  } else {
    tip.hidden = true;
  }
}

function onClick(info) {
  if (info.layer?.id === 'nodes' && info.index >= 0) select(info.index, false);
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
  h.set('mode', state.mode);
  h.set('view', state.view);
  h.set('basemap', state.basemap);
  const c = map.getCenter();
  h.set('lon', c.lng.toFixed(3));
  h.set('lat', c.lat.toFixed(3));
  h.set('z', map.getZoom().toFixed(2));
  if (state.selected !== null && G) h.set('as', G.asn[state.selected]);
  history.replaceState(null, '', `#${h}`);
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
      ensureGlobe().setProps({ initialViewState: { longitude: c.lng, latitude: c.lat, zoom: Math.max(map.getZoom() - 0.6, 0) } });
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
  for (const [id, key] of [['showTransit', 'showTransit'], ['showPeering', 'showPeering'], ['glow', 'glow']]) {
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.checked;
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
  lowerNames = G.names.map((s) => s.toLowerCase());
  buildColours();
  tilesMeta = {};
  for (const m of G.meta.modes) {
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

  const m = G.meta;
  $('banner').hidden = !m.synthetic;
  $('banner').innerHTML = m.synthetic
    ? '<b>Synthetic topology.</b> ASes, names, prefixes and geography are real; the links between them are generated. Build with CAIDA data for the real graph.'
    : '';
  $('legend').innerHTML = m.regions
    .map((r) => `<li><i style="color: rgb(${r.rgb.join(',')}); background: rgb(${r.rgb.join(',')})"></i>${esc(r.name.split(' /')[0])}</li>`)
    .join('');
  const c = m.counts;
  $('stats').innerHTML = `${fmt(c.nodes)} ASes · ${fmt(c.edges)} links (${fmt(c.p2c)} transit, ${fmt(c.p2p)} peering) · ${fmt(c.geolocated)} geolocated, ${fmt(c.pinned)} pinned<br>${m.attribution.join('<br>')}`;
  map.getContainer().querySelector('.maplibregl-ctrl-attrib-inner');
  updateRaster();
  render();

  const want = hash.get('as');
  if (want && G.byAsn.has(Number(want))) select(G.byAsn.get(Number(want)), false);
}

async function boot() {
  wireControls();
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

boot();
