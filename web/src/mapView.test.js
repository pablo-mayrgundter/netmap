// node --test: map.html's protocol without the DOM (src/mapView.js), and
// the shared globe look it draws with (src/globeScene.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core';
import { MAP_HELLO, MAP_HOST_ORIGINS, MAX_MARKS, cameraOf, fitZoom, pickDataset, pickHostOrigin } from './mapView.js';
import { altitudeOf, ALT_MAX_M, makeEndReader, regionColours } from './globeScene.js';

const prodPage = 'https://pablo-mayrgundter.github.io';
const localPage = 'http://127.0.0.1:5481';

test('exo.cafe and pablo-mayrgundter.github.io may embed it', () => {
  for (const h of MAP_HOST_ORIGINS) assert.equal(pickHostOrigin({ ancestor: `${h}/pr-preview/pr-3/`, pageOrigin: prodPage }), h);
  assert.equal(pickHostOrigin({ referrer: 'https://exo.cafe/', pageOrigin: prodPage }), 'https://exo.cafe');
});

test('no other site may, and loopback only from a loopback page', () => {
  assert.equal(pickHostOrigin({ ancestor: 'https://evil.example', pageOrigin: prodPage }), null);
  assert.equal(pickHostOrigin({ ancestor: 'http://localhost:4173', pageOrigin: prodPage }), null);
  assert.equal(pickHostOrigin({ ancestor: 'http://localhost:4173', pageOrigin: localPage }), 'http://localhost:4173');
  assert.equal(pickHostOrigin({ ancestor: 'http://localhost:4173', pageOrigin: prodPage, dev: true }), 'http://localhost:4173');
  assert.equal(pickHostOrigin({ pageOrigin: prodPage }), null);
  assert.equal(pickHostOrigin({ ancestor: 'null', pageOrigin: localPage }), null);
});

test('the embedding page outranks a ?host= it might be lying in', () => {
  assert.equal(pickHostOrigin({ ancestor: 'https://evil.example', hostParam: 'https://exo.cafe', pageOrigin: prodPage }), null);
  assert.equal(pickHostOrigin({ hostParam: 'https://exo.cafe', pageOrigin: prodPage }), 'https://exo.cafe');
});

test('the hello offers a map, as a globe camera, in metres', () => {
  assert.equal(MAP_HELLO.type, 'layer:hello');
  assert.ok(MAP_HELLO.capabilities.kinds.includes('map'));
  assert.ok(MAP_HELLO.capabilities.views.includes('globe-camera'));
  assert.deepEqual(MAP_HELLO.units, { meters: 1 });
  assert.equal(MAP_HELLO.earth.radius, 6370972);
});

const view = { kind: 'globe-camera', lon: 10, lat: 5, zoom: 0.5, bearing: 0, pitch: 0, width: 512, height: 512, timeMs: 1.8e12 };

test("a globe camera becomes deck's view state", () => {
  const c = cameraOf(view);
  assert.deepEqual(c.viewState, { longitude: 10, latitude: 5, zoom: 0.5, bearing: 0, pitch: 0 });
  assert.equal(c.width, 512);
  assert.equal(c.height, 512);
  assert.equal(c.timeMs, 1.8e12);
  assert.deepEqual(c.marks, []);
});

test('anything else is no view', () => {
  for (const v of [null, {}, { ...view, kind: 'matrix' }, { ...view, width: 'x' }, { ...view, lon: NaN }, { ...view, zoom: undefined }]) {
    assert.equal(cameraOf(v), null, JSON.stringify(v));
  }
});

test('it clamps what deck can draw, and wraps longitude', () => {
  const c = cameraOf({ ...view, lon: 370, lat: 95, pitch: 80, width: 1e6, height: 0 });
  assert.equal(c.viewState.longitude, 10);
  assert.equal(c.viewState.latitude, 89);
  assert.equal(c.viewState.pitch, 60);
  assert.equal(c.width, 4096);
  assert.equal(c.height, 1);
});

test('marks are checked and capped', () => {
  const marks = [{ lon: 0, lat: 0 }, { lon: 'x', lat: 0 }, { lon: 5, lat: 6, rgb: [1, 2, 3] }, ...Array(30).fill({ lon: 1, lat: 1 })];
  const c = cameraOf({ ...view, marks });
  assert.equal(c.marks.length, MAX_MARKS - 1); // the bad one is dropped from the first MAX_MARKS
  assert.deepEqual(c.marks[0], { lon: 0, lat: 0, rgb: [255, 213, 74] });
  assert.deepEqual(c.marks[1].rgb, [1, 2, 3]);
});

// Where deck's globe's silhouette lands, pixels from the centre: the farthest
// any point on the equator projects, for a camera over (0°, lat).
const discRadius = (zoom, height, lat = 0) => {
  const vp = new GlobeViewport({ width: height, height, longitude: 0, latitude: lat, zoom });
  let r = 0;
  for (let lon = 0; lon <= 180; lon += 0.05) {
    const [x, y] = vp.project([lon, lat]);
    r = Math.max(r, Math.hypot(x - height / 2, y - height / 2));
  }
  return r;
};

test("fit gives the zoom at which deck's globe spans that much of the frame", () => {
  for (const [fit, h] of [[0.9, 512], [0.5, 256], [1, 1024]]) {
    assert.ok(Math.abs(discRadius(fitZoom(fit, h), h) - (fit * h) / 2) < 0.01 * h, `${fit} of ${h}`);
  }
  assert.ok(Math.abs(discRadius(fitZoom(0.9, 512, 30), 512, 30) - 0.45 * 512) < 6, 'off the equator too');
  const c = cameraOf({ ...view, zoom: undefined, fit: 0.9 });
  assert.equal(c.viewState.zoom, fitZoom(0.9, 512, 5));
});

test('the dataset: the one asked for, else the first AS map', () => {
  const sets = [{ id: 'routers', kind: 'routers' }, { id: 'internet', kind: 'as' }];
  assert.equal(pickDataset(sets), 'internet');
  assert.equal(pickDataset(sets, 'routers'), 'routers');
  assert.equal(pickDataset(sets, 'nope'), 'internet');
  assert.equal(pickDataset([]), null);
});

// A two-node, one-link bundle, the shape data.js loads.
const G = {
  n: 2,
  e: 1,
  meta: { regions: [{ rgb: [200, 0, 0] }, { rgb: [0, 100, 50] }] },
  region: [0, 1],
  edges: new Uint32Array([0, 1]),
  edge_rel: new Int8Array([0]),
  level: new Float32Array([0, 1]),
  pos_geo: new Float32Array([10, 20, 30, 40]),
  edge_pop: new Int32Array([-1, 0]),
  pop_pos: new Float32Array([50, 60]),
  pop_node: new Uint32Array([1]),
};

test('colours: a link is the mean of its ends, peering dimmer', () => {
  const { nodeColor, edgeColor } = regionColours(G);
  assert.deepEqual([...nodeColor], [200, 0, 0, 255, 0, 100, 50, 255]);
  assert.deepEqual([...edgeColor], [100, 50, 25, 190]);
});

test('link ends: at the point of presence when asked, floating by level on the globe', () => {
  const t = [0, 0, 0];
  const end = makeEndReader(G, { sec: 'pos_geo', pops: true, globe: true, alt: 0.2 });
  assert.deepEqual(end(0, 0, t), [10, 20, 0]);
  assert.deepEqual(end(0, 1, [0, 0, 0]), [50, 60, altitudeOf(1, 0.2)]);
  assert.equal(altitudeOf(1, 0.5), ALT_MAX_M);
  const flat = makeEndReader(G, { sec: 'pos_geo', pops: false, globe: false, alt: 0.2 });
  assert.deepEqual(flat(0, 1, [0, 0, 0]), [30, 40, 0]);
});
