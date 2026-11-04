// node --test: a host's matrix view (ECEF → eye, and its projection) as
// deck's viewport (src/matrixView.js): every point lands on the pixel the
// host's own matrices put it at, from a centimetre over the ground to orbit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core';
import { matrixViewport, cameraPlace, invertRigid, nearGraticule, curvatureDrop, GLOBE_MAX_ZOOM } from './matrixView.js';
import { DECK_EARTH_RADIUS as R } from './mapView.js';

const D2R = Math.PI / 180;
const W = 800, H = 500;
const ecef = (lon, lat, alt = 0) => {
  const l = lon * D2R, p = lat * D2R, r = R + alt;
  return [r * Math.cos(p) * Math.cos(l), r * Math.cos(p) * Math.sin(l), r * Math.sin(p)];
};
const sub = (a, b) => a.map((x, i) => x - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => a.map((x) => x / Math.hypot(...a));

/** A host camera at `eye` looking at `at`, `up` up: its view matrix (ECEF → eye) and a 60° projection. */
function host(eye, at, up) {
  const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
  const cam = [...x, 0, ...y, 0, ...z, 0, ...eye, 1];
  const viewMatrix = invertRigid(cam);
  const f = 1 / Math.tan(30 * D2R);
  const projectionMatrix = [f * H / W, 0, 0, 0, 0, f, 0, 0, 0, 0, -1.0001, -1, 0, 0, -0.2, 0];
  return { viewMatrix, projectionMatrix };
}

/** Where the host's own matrices put an ECEF point: top-left pixels. */
function hostPixel({ viewMatrix: v, projectionMatrix: p }, q) {
  const e = [0, 1, 2, 3].map((r) => v[r] * q[0] + v[4 + r] * q[1] + v[8 + r] * q[2] + v[12 + r]);
  const c = [0, 1, 3].map((r) => p[r] * e[0] + p[4 + r] * e[1] + p[8 + r] * e[2] + p[12 + r] * e[3]);
  return [((c[0] / c[2] + 1) / 2) * W, ((1 - c[1] / c[2]) / 2) * H];
}

const near = (a, b, tol, what) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < tol, `${what}: ${a.map((x) => x.toFixed(2))} vs ${b.map((x) => x.toFixed(2))}`);

test('from orbit, a globe: every point where the host sees it', () => {
  const view = host(ecef(5, 10, 6e6), ecef(0, 0), [0, 0, 1]);
  const vp = matrixViewport({ ...view, width: W, height: H });
  assert.ok(vp.cameraPlace.globeZoom <= GLOBE_MAX_ZOOM);
  assert.equal(vp.projectionMode, new GlobeViewport({}).projectionMode);
  for (const [lon, lat, alt] of [[0, 0, 0], [10, 5, 0], [-15, -8, 0], [3, 20, 3e5]]) {
    near(vp.project([lon, lat, alt]), hostPixel(view, ecef(lon, lat, alt)), 0.5, `(${lon}, ${lat}, ${alt})`);
  }
});

test('low over Null Island, looking at the horizon, a flat map centred under the camera', () => {
  for (const h of [0.01, 3, 2000]) {
    const eye = ecef(0.00001, 0.00002, h);
    // Looking east, 10° down.
    const at = ecef(0.00001 + (h * 20) / (R * D2R), 0.00002, 0);
    const view = host(eye, at, [1, 0, 0]);
    const vp = matrixViewport({ ...view, width: W, height: H });
    assert.ok(vp.cameraPlace.globeZoom > GLOBE_MAX_ZOOM, `${h} m is above zoom 12`);
    // Points on the ground a few camera heights off, where the flat map and the sphere agree.
    for (const [de, dn] of [[5, 0], [8, 2], [4, -1.5], [12, 3]]) {
      const lon = 0.00001 + (h * de) / (R * D2R), lat = 0.00002 + (h * dn) / (R * D2R);
      near(vp.project([lon, lat, 0]), hostPixel(view, ecef(lon, lat, 0)), 1, `h ${h} m, (${de}, ${dn}) heights`);
    }
  }
});

test('the camera is placed where the host has it', () => {
  const view = host(ecef(2, -3, 450), ecef(2.01, -3, 0), [0, 0, 1]);
  const place = cameraPlace(view.viewMatrix, H);
  assert.ok(Math.abs(place.h - 450) < 1e-6);
  assert.ok(Math.abs(place.lon - 2) < 1e-9 && Math.abs(place.lat + 3) < 1e-9);
});

test('from the chip, the equator and the prime meridian, densified round the camera', () => {
  const lines = nearGraticule(0.00001, 0.00002, 0.01);
  const meridian = lines.find((l) => l.path.every(([lon]) => lon === 0));
  const equator = lines.find((l) => l.path.every(([, lat]) => lat === 0));
  assert.ok(meridian && equator, 'both lines through Null Island');
  assert.ok(meridian.major && equator.major);
  // Points a fraction of the camera's height apart under it, and far out to the reach.
  const lats = meridian.path.map(([, lat]) => lat * (R * D2R) - 0.00002 * (R * D2R));
  const near0 = Math.min(...lats.filter((d) => d > 0));
  assert.ok(near0 <= 0.01, `first step ${near0} m`);
  assert.ok(Math.max(...lats) >= 999, 'out to the reach');
  // Only lines within reach: none of the others from 1 cm up.
  assert.equal(lines.length, 2);
});

test('on the flat map, what stands off the ground falls away as over the sphere', () => {
  assert.equal(curvatureDrop(0, 0, 0, 0), 0);
  // 100 km off: d²/2R, 785 m.
  assert.ok(Math.abs(curvatureDrop(0, 0, 100e3 / (R * D2R), 0) - 785) < 1);
  // A link at 700 km, 3,500 km away, is below the horizon from the ground: it falls further.
  assert.ok(curvatureDrop(0, 0, 3500e3 / (R * D2R), 0) > 700e3);
});
