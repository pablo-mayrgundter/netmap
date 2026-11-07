import test from 'node:test';
import assert from 'node:assert/strict';
import { azimuth, clears, coverageAngle, fibreMs, gcKm, lookAt, ring, site, slantAt, vacuumMs } from './geometry.js';
import { geodeticToEcef, RE } from './orbit.js';

test('elevation and slant range: overhead, on the horizon, and below it', () => {
  const s = site(-98.5, 38.5);
  const out = [0, 0];
  const above = geodeticToEcef(-98.5, 38.5, 550);
  lookAt(s, above, 0, out);
  assert.ok(Math.abs(out[0] - 90) < 1e-6 && Math.abs(out[1] - 550) < 1e-6, `${out}`);
  // A point 10° of arc away at 550 km: tan(el) = (cos 10° − R/(R+h)) / sin 10°, about 20° up.
  const far = geodeticToEcef(-98.5, 48.5, 550);
  lookAt(s, far, 0, out);
  assert.ok(out[0] > 19.5 && out[0] < 21.5, `${out}`);
  // The far side of the Earth is below the horizon.
  lookAt(s, geodeticToEcef(81.5, -38.5, 550), 0, out);
  assert.ok(out[0] < -80);
  // North is azimuth 0, east 90.
  assert.ok(Math.abs(azimuth(s, far, 0)) < 1e-6 || Math.abs(azimuth(s, far, 0) - 360) < 1e-6);
  const east = geodeticToEcef(-90, 38.5, 550);
  assert.ok(Math.abs(azimuth(s, east, 0) - 90) < 8);
});

test('coverage: the footprint angle and the slant range at the mask agree', () => {
  // 550 km, 25°: the classic Starlink figure, a footprint about 940 km in radius.
  const lam = coverageAngle(550, 25);
  assert.ok(Math.abs((lam * Math.PI / 180) * 6371 - 940) < 15, `${lam}`);
  assert.ok(Math.abs(slantAt(550, 90) - 550) < 1e-9);
  assert.ok(Math.abs(slantAt(550, 25) - 1123) < 10, `${slantAt(550, 25)}`);
  // A satellite placed at the footprint's edge is at the mask's elevation.
  const s = site(0, 0);
  const p = geodeticToEcef(lam, 0, 550);
  const out = [0, 0];
  lookAt(s, p, 0, out);
  assert.ok(Math.abs(out[0] - 25) < 0.6, `${out}`);
});

test('line of sight: lasers clear the Earth and a grazing height, or not', () => {
  const a = geodeticToEcef(0, 0, 550), b = geodeticToEcef(20, 0, 550), c = geodeticToEcef(90, 0, 550), d = geodeticToEcef(180, 0, 550);
  assert.ok(clears(...a, ...b, 80)); // 2,400 km apart: the chord stays high
  assert.ok(!clears(...a, ...d, 0)); // opposite sides: through the Earth
  // 90° apart at 550 km: the chord's lowest point is RE·cos45 + ... below the surface.
  assert.ok(!clears(...a, ...c, 0));
  // The chord between two satellites 47° apart at 550 km just grazes: (RE+550)cos(23.5°) ≈ RE.
  const e = geodeticToEcef(47, 0, 550);
  const mid = (RE + 550) * Math.cos((23.5 * Math.PI) / 180) - RE;
  assert.equal(clears(...a, ...e, mid - 5), true);
  assert.equal(clears(...a, ...e, mid + 5), false);
});

test('light time: vacuum and fibre, and great-circle distances', () => {
  assert.ok(Math.abs(vacuumMs(299.792458) - 1) < 1e-12);
  assert.ok(Math.abs(fibreMs(1000) - 4.9034) < 1e-3);
  assert.ok(Math.abs(gcKm(0, 0, 1, 0) - 111.195) < 0.01);
  assert.ok(Math.abs(gcKm(179, 0, -179, 0) - 222.39) < 0.05);
});

test('ring: points at the angle all round, continuous in longitude', () => {
  const r = ring(170, 10, 8, 36);
  assert.equal(r.length, 37);
  for (const [lon, lat] of r) assert.ok(Math.abs(gcKm(170, 10, lon, lat) - (8 * Math.PI / 180) * 6371.0088) < 0.5);
  for (let k = 1; k < r.length; k++) assert.ok(Math.abs(r[k][0] - r[k - 1][0]) < 10);
});
