// map.html: NetMap as a NetGL guest (portal RFC 0004 §5; the protocol is in
// mapView.js). A host page embeds this in a hidden cross-origin iframe;
// deck.gl draws NetMap's globe into portal-netgl's recording context, and
// every GL call it makes is replayed into the host's WebGL2 context. The
// host asks for a camera, and gets that view drawn full frame, one frame
// per view: no requestAnimationFrame clock of its own to wait on, since a
// hidden cross-origin frame's may be throttled, and the host owns the clock.
//
// What it draws is netmap's default globe (main.js) from the same code
// (globeScene.js, arcs.js, data.js): the geo layout, backbone links in one
// vantage tree, points of presence and their core routes, and the nodes,
// glowing. No basemap but the dark grid and land, and no fiber bundles yet.
import { Deck, _GlobeView as GlobeView } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { makeNetGLGuestContext, parentTransport } from '@pablo-mayrgundter/portal-netgl/core';
import { listDatasets, loadBundle } from './data.js';
import { buildArcs } from './arcs.js';
import { shownLinks } from './lineSet.js';
import {
  altitudeOf, EDGE_LIFT, regionColours, makeEndReader, linkLengthFactors, routeLengthFactors, linkOpacity, nodeLook, nodeRadius, ADDITIVE,
} from './globeScene.js';
import { earthLayers } from './earth.js';
import { MAP_HELLO, pickHostOrigin, cameraOf, pickDataset } from './mapView.js';

const DATA_BASE = new URL(import.meta.env.VITE_DATA_BASE || './data', document.baseURI).href.replace(/\/$/, '');
const params = new URLSearchParams(location.search);
// netmap's defaults (main.js PARAMS): the look the app opens with.
const LOOK = { alt: 0.2, edgeAlpha: 0.05, nodeSize: 0, glow: true };
const HELLO_RESEND_MS = 500;

const stats = { host: null, status: 'starting', dataset: null, links: 0, views: 0, frames: 0, loadMs: 0, buildMs: 0, drawMs: [] };
window.netmapGuest = { stats };

const why = (text) => {
  const p = document.getElementById('why');
  p.textContent = text;
  p.hidden = false;
  console.warn(`[map] ${text}`);
};

const host = pickHostOrigin({
  ancestor: location.ancestorOrigins?.[0] ?? null,
  referrer: document.referrer || null,
  hostParam: params.get('host'),
  pageOrigin: location.origin,
  dev: !!import.meta.env.DEV,
});
if (window.parent === window) why('This page is NetMap for a NetGL host to embed. Open netmap itself at ./');
else if (!host) why('Not embedded by a host this page talks to.');
else start(host);

function start(host) {
  stats.host = host;
  // The shadow canvas is deck's, laid out in the page at the host's size
  // (resize()), and draws nothing itself: with shadowDraws off the pixels
  // are made once, by the host's replay.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: '1px', height: '1px' });
  document.body.appendChild(canvas);
  let core;
  try {
    core = makeNetGLGuestContext({
      canvas,
      transport: parentTransport({ hostOrigins: [host] }),
      messageChannel: 'all',
      shadowDraws: false,
      contextAttributes: { antialias: false, alpha: true, depth: true, stencil: false, premultipliedAlpha: true },
    });
  } catch (e) {
    why(`No WebGL2 (${e?.message ?? e})`);
    parent.postMessage({ type: 'layer:status', status: 'error', message: 'no WebGL2' }, host);
    return;
  }
  const transport = core.transport;
  const status = (s, message) => {
    stats.status = s;
    transport.post({ type: 'layer:status', status: s, ...(message ? { message } : {}) });
  };

  let acked = false;
  const hello = () => {
    if (acked) return;
    transport.post(MAP_HELLO);
    setTimeout(hello, HELLO_RESEND_MS);
  };

  const earth = earthLayers();
  let net = null; // the map's data and the layers' fixed parts, once loaded
  let latest = null; // the newest view: { viewId, cam }
  let size = [1, 1];
  let deckReady = false;
  let drawing = false; // inside draw(): deck may draw
  let asked = false; // a layer:invalidate is out, unanswered

  const deck = new Deck({
    gl: core.gl,
    views: new GlobeView({ resolution: 5 }),
    viewState: { longitude: 0, latitude: 0, zoom: 0 },
    controller: false,
    useDevicePixels: false,
    layers: earth,
    onLoad: () => {
      deckReady = true;
      draw();
    },
    // deck draws only for a view (draw()). When it wants to redraw on its
    // own (a layer's data or shaders came in), the host is asked for the
    // view again instead: a frame it didn't ask for would be replayed with
    // the next one, at twice the cost. (_drawLayers is the hook
    // @deck.gl/mapbox draws through too.)
    _customRender: (reason) => {
      if (drawing) deck._drawLayers(reason);
      else if (!asked) {
        asked = true;
        transport.post({ type: 'layer:invalidate', reason: `deck: ${reason}` });
      }
    },
    onError: (e) => {
      console.error('[map] deck', e);
      status('error', String(e?.message ?? e));
    },
  });

  function resize(w, h) {
    if (w === size[0] && h === size[1]) return;
    size = [w, h];
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    // luma owns the drawing buffer's size (deck doesn't resize a context it
    // was given), and its resize observer is too late for a frame drawn now.
    deck.device.getDefaultCanvasContext().setDrawingBufferSize(w, h);
    canvas.width = w;
    canvas.height = h;
    deck.setProps({ width: w, height: h });
  }

  function draw() {
    if (!latest || !deckReady) return;
    const { viewId, cam } = latest;
    resize(cam.width, cam.height);
    const t0 = performance.now();
    deck.setProps({ viewState: cam.viewState, layers: [...earth, ...networkLayers(cam), ...markLayers(cam)] });
    asked = false;
    drawing = true;
    try {
      // What deck's own frame does (Deck._onRenderFrame): new layers are
      // matched and updated, then drawn. Without it this frame would draw
      // the last view's layers, and deck would ask again for this one's.
      deck.layerManager.updateLayers();
      deck.redraw('layer:view');
      // luma's WebGL device draws at once but queues buffer and texture
      // copies until submit(), which its AnimationLoop calls after each
      // frame: submit here, so any are in this NetGL frame, not the next.
      deck.device.submit();
    } finally {
      drawing = false;
    }
    core.endFrame({ viewId });
    stats.frames += 1;
    const ms = performance.now() - t0;
    stats.drawMs.push(ms);
    if (stats.drawMs.length > 120) stats.drawMs.shift();
  }

  function networkLayers(cam) {
    if (!net) return [];
    const zoom = cam.viewState.zoom + 0.6; // the map zoom netmap's looks are tuned at
    const opacity = linkOpacity({ zoom, glow: LOOK.glow, edgeAlpha: LOOK.edgeAlpha, sparsity: net.sparsity });
    const { sizeK, opacity: nodeOpacity } = nodeLook({ zoom, nodeSize: LOOK.nodeSize, glow: LOOK.glow });
    const blend = { ...ADDITIVE, depthWriteEnabled: false, depthCompare: 'less-equal' };
    const { G, nodeColor, edgeColor, links, lf } = net;
    const layers = [
      new PathLayer({
        id: 'edges',
        data: net.arcs,
        _pathType: 'open',
        getColor: (_, { index, target }) => {
          const k = links[index];
          const o = k * 4;
          target[0] = edgeColor[o];
          target[1] = edgeColor[o + 1];
          target[2] = edgeColor[o + 2];
          target[3] = edgeColor[o + 3] * lf[k];
          return target;
        },
        opacity,
        getWidth: 1,
        widthUnits: 'pixels',
        billboard: true,
        parameters: blend,
      }),
    ];
    if (net.routes) {
      const rlf = net.rlf;
      layers.push(
        new PathLayer({
          id: 'routes',
          data: net.routes,
          _pathType: 'open',
          getColor: (_, { index, target }) => {
            const o = G.pop_node[G.pop_routes[2 * index]] * 4;
            target[0] = nodeColor[o];
            target[1] = nodeColor[o + 1];
            target[2] = nodeColor[o + 2];
            target[3] = 255 * rlf[index];
            return target;
          },
          opacity: Math.min(0.8, opacity * 2.5),
          getWidth: 1.2,
          widthUnits: 'pixels',
          billboard: true,
          parameters: blend,
        }),
      );
    }
    const pops = !!G.pop_pos;
    const hasPops = (i) => pops && G.pop_offset[i + 1] > G.pop_offset[i];
    const fill = (o, target) => {
      target[0] = nodeColor[o];
      target[1] = nodeColor[o + 1];
      target[2] = nodeColor[o + 2];
      target[3] = 255;
      return target;
    };
    layers.push(
      new ScatterplotLayer({
        id: 'nodes',
        data: net.nodes,
        getPosition: (_, { index, target }) => net.pos(index, target),
        getRadius: (_, { index }) => ((G.flags[index] & 1) === 1 && !hasPops(index) ? nodeRadius(G.degree[index]) : 0),
        getFillColor: (_, { index, target }) => fill(index * 4, target),
        radiusUnits: 'pixels',
        billboard: true,
        radiusMinPixels: 0,
        radiusScale: sizeK,
        opacity: nodeOpacity,
        parameters: blend,
      }),
    );
    if (pops) {
      layers.push(
        new ScatterplotLayer({
          id: 'pops',
          data: net.pops,
          getPosition: (_, { index, target }) => net.popPos(index, target),
          getRadius: (_, { index }) => {
            const i = G.pop_node[index];
            const w = Math.sqrt(G.pop_offset[i + 1] - G.pop_offset[i]);
            return 0.8 + (Math.log2(G.degree[i] + 1) * 0.55) / w;
          },
          getFillColor: (_, { index, target }) => fill(G.pop_node[index] * 4, target),
          radiusUnits: 'pixels',
          billboard: true,
          radiusScale: sizeK,
          opacity: Math.min(1, nodeOpacity * 1.5),
          parameters: blend,
        }),
      );
    }
    return layers;
  }

  // Places the host marks (exo marks where it sits: 0° N 0° E), as a ring
  // round a dot, a little above the ground so the ocean doesn't hide it.
  function markLayers(cam) {
    if (!cam.marks.length) return [];
    return [
      new ScatterplotLayer({
        id: 'marks',
        data: cam.marks,
        getPosition: (m) => [m.lon, m.lat, 20_000],
        getRadius: 6,
        radiusUnits: 'pixels',
        billboard: true,
        stroked: true,
        filled: true,
        getFillColor: (m) => [...m.rgb, 90],
        getLineColor: (m) => [...m.rgb, 255],
        lineWidthMinPixels: 2,
        updateTriggers: { getFillColor: JSON.stringify(cam.marks), getLineColor: JSON.stringify(cam.marks) },
      }),
    ];
  }

  async function load() {
    const t0 = performance.now();
    const sets = await listDatasets(DATA_BASE);
    const id = pickDataset(sets, params.get('data'));
    if (!id) throw new Error('no datasets');
    const G = await loadBundle(DATA_BASE, id);
    stats.dataset = id;
    stats.loadMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    // netmap's default globe: geo layout, points of presence, backbone links
    // in one vantage tree (the sampling slider at its left, edge_rank 0).
    const sec = 'pos_geo';
    const pops = !!G.pop_pos;
    const end = makeEndReader(G, { sec, pops, globe: true, alt: LOOK.alt });
    const geo = (i) => (G.flags[i] & 1) === 1;
    const links = shownLinks(G.e, (k) =>
      (!G.edge_backbone || G.edge_backbone[k]) && (!G.edge_rank || G.edge_rank[k] <= 0) && geo(G.edges[2 * k]) && geo(G.edges[2 * k + 1]));
    const ends = new Float64Array(6 * links.length);
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    for (let j = 0; j < links.length; j++) {
      end(links[j], 0, a);
      end(links[j], 1, b);
      ends.set(a, 6 * j);
      ends.set(b, 6 * j + 3);
    }
    const popPos = (p, target) => {
      target[0] = G.pop_pos[2 * p];
      target[1] = G.pop_pos[2 * p + 1];
      target[2] = altitudeOf(G.level[G.pop_node[p]], LOOK.alt);
      return target;
    };
    let routes = null;
    if (pops && G.pop_routes) {
      const r = G.pop_routes;
      const re = new Float64Array(3 * r.length);
      for (let k = 0; k < r.length / 2; k++) {
        popPos(r[2 * k], a);
        popPos(r[2 * k + 1], b);
        re.set(a, 6 * k);
        re.set(b, 6 * k + 3);
      }
      routes = buildArcs(re, EDGE_LIFT);
    }
    const p = G[sec];
    net = {
      G,
      ...regionColours(G),
      links,
      lf: linkLengthFactors(G.e, end),
      rlf: routes ? routeLengthFactors(G) : null,
      arcs: buildArcs(ends, EDGE_LIFT),
      routes,
      nodes: { length: G.n },
      pops: pops ? { length: G.pop_node.length } : null,
      pos: (i, target) => ((target[0] = p[2 * i]), (target[1] = p[2 * i + 1]), (target[2] = altitudeOf(G.level[i], LOOK.alt)), target),
      popPos,
      // as main.js's edgeOpacity with backbone only: makes up for the links it hides
      sparsity: G.e / Math.max(G.meta.counts.backbone || G.e, 1) / 1.5,
    };
    stats.links = links.length;
    stats.buildMs = Math.round(performance.now() - t1);
  }

  transport.onMessage((msg) => {
    if (msg?.type === 'layer:hello-ack') {
      acked = true;
      if (msg.accepted === false) console.info(`[map] ${host} declined: ${msg.reason ?? ''}`);
    } else if (msg?.type === 'layer:view') {
      const cam = cameraOf(msg.view);
      if (!cam) return console.warn('[map] not a globe camera:', msg.view?.kind);
      stats.views += 1;
      latest = { viewId: msg.viewId, cam };
      draw();
    } else if (msg?.type === 'layer:dispose') {
      deck.finalize();
      stats.status = 'disposed';
    }
  });

  hello();
  status('loading');
  load().then(
    () => {
      status('ready');
      // The map's data came: ask the host for its view again, to draw it.
      transport.post({ type: 'layer:invalidate', reason: 'data' });
      draw();
    },
    (e) => {
      // The globe still draws, without the network on it.
      console.warn('[map] no map data', e);
      status('degraded', `no map data (${e?.message ?? e})`);
    },
  );
}
