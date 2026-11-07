import test from 'node:test';
import assert from 'node:assert/strict';
import { ecefToGeodetic, fromTLE, geodeticToEcef, laserCapable, meanAltitudeKm, ommRecords, parseDesignator, propagateAll, RE, satellites, temeAt, temeToEcef } from './orbit.js';

// Vallado et al. (2006), "Revisiting Spacetrack Report #3", the verification
// case 00005 and its reference output (tcppver.out) at 0 and 360 minutes.
const L1 = '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753';
const L2 = '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667';
const EPOCH = Date.UTC(2000, 0, 1) + (179.78495062 - 1) * 86400000;
const REF = { 0: [7022.46529266, -1400.08296755, 0.03995155], 360: [-7154.03120202, -3783.17682504, -3536.19412294] };

test('SGP4: the Vallado 00005 case at 0 and 360 min, to well under a km', () => {
  const sat = fromTLE(L1, L2, 'VANGUARD 1');
  for (const [min, ref] of Object.entries(REF)) {
    const pv = temeAt(sat, EPOCH + Number(min) * 60000);
    const d = Math.hypot(pv.position.x - ref[0], pv.position.y - ref[1], pv.position.z - ref[2]);
    assert.ok(d < 0.5, `${min} min: ${d} km off`);
  }
});

// A Starlink element set (OMM, as CelesTrak gives it) and where it is.
const OMM = {
  OBJECT_NAME: 'STARLINK-3001', OBJECT_ID: '2021-082A', NORAD_CAT_ID: 49140, EPOCH: '2026-11-01T00:00:00.000', MEAN_MOTION: 15.30, ECCENTRICITY: 0.0001,
  INCLINATION: 70.0, RA_OF_ASC_NODE: 120, ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 0, BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1000,
};

test('satellites: elements, altitude, laser cut-off; propagateAll to ECEF and geodetic', () => {
  const [s] = satellites([OMM]);
  assert.equal(s.norad, 49140);
  assert.ok(s.laser);
  assert.ok(Math.abs(s.alt - meanAltitudeKm(15.3)) < 1e-9 && s.alt > 450 && s.alt < 500, `${s.alt}`);
  const pos = new Float64Array(3), vel = new Float64Array(3), ok = new Uint8Array(1);
  const t = Date.parse('2026-11-01T00:10:00Z');
  assert.equal(propagateAll([s], t, pos, vel, ok), 1);
  const r = Math.hypot(pos[0], pos[1], pos[2]);
  assert.ok(r > RE + 440 && r < RE + 520, `${r}`);
  // The same point the TEME position gives, rotated by GMST.
  const e = temeToEcef(temeAt(s, t).position, t);
  assert.ok(Math.hypot(e[0] - pos[0], e[1] - pos[1], e[2] - pos[2]) < 1e-6);
  const g = ecefToGeodetic(pos[0], pos[1], pos[2]);
  assert.ok(Math.abs(g[1]) <= 70.1 && g[2] > 440 && g[2] < 520, `${g}`);
  // And at the inclination: latitude never above it, speed about 7.6 km/s.
  const v = Math.hypot(vel[0], vel[1], vel[2]);
  assert.ok(v > 7.4 && v < 7.8, `${v}`);
});

test('geodetic <-> ECEF round trip on WGS84', () => {
  for (const [lon, lat, h] of [[0, 0, 0], [-98.5, 38.5, 0.4], [15.6, 78.2, 550], [179.9, -45, 1200], [-150, 89.5, 10]]) {
    const p = geodeticToEcef(lon, lat, h);
    const g = ecefToGeodetic(p[0], p[1], p[2]);
    assert.ok(Math.abs(g[0] - lon) < 1e-6 && Math.abs(g[1] - lat) < 1e-6 && Math.abs(g[2] - h) < 1e-5, `${[lon, lat, h]} -> ${g}`);
  }
  assert.ok(Math.abs(geodeticToEcef(0, 0, 0)[0] - RE) < 1e-9);
  assert.ok(Math.abs(geodeticToEcef(0, 90, 0)[2] - 6356.752) < 1e-3); // the polar radius
});

test('designators and the laser cut-off (v1.5 from Group 2-1, 2021-082)', () => {
  assert.deepEqual(parseDesignator('2021-082A'), { year: 2021, launch: 82, piece: 'A' });
  assert.equal(parseDesignator('bogus'), null);
  assert.equal(laserCapable('2019-074B'), false);
  assert.equal(laserCapable('2021-044AB'), false);
  assert.equal(laserCapable('2021-059C'), false); // a 2021 polar test satellite: ignored
  assert.equal(laserCapable('2021-082A'), true);
  assert.equal(laserCapable('2024-001K'), true);
  assert.equal(laserCapable(''), false);
});

test('ommRecords: gp.json columns or a list', () => {
  const cols = { fields: ['OBJECT_NAME', 'NORAD_CAT_ID', 'BSTAR'], rows: [['A', 1, null], ['B', 2, 0.1]] };
  assert.deepEqual(ommRecords(cols), [{ OBJECT_NAME: 'A', NORAD_CAT_ID: 1 }, { OBJECT_NAME: 'B', NORAD_CAT_ID: 2, BSTAR: 0.1 }]);
  assert.deepEqual(ommRecords([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(ommRecords(null), []);
});

test("ecefToGlobe: satellites are drawn where deck's globe and the Orbits layer put their true position", async () => {
  const { ecefToGlobe, globeToEcef, GLOBE_RADIUS_M } = await import('./orbit.js');
  // deck's GlobeView sphere, the radius netmap sends the Orbits layer (src/orbits.js).
  assert.equal(GLOBE_RADIUS_M, 6370972);
  // A satellite 470 km above 45° N, 30° E (WGS84): its true ECEF position…
  const p = geodeticToEcef(30, 45, 470);
  const g = ecefToGlobe(...p);
  // …is drawn at its geocentric latitude, 0.18° south of the geodetic, and at its radius above deck's sphere.
  assert.ok(Math.abs(g[0] - 30) < 1e-9);
  assert.ok(Math.abs(g[1] - (Math.atan2(p[2], Math.hypot(p[0], p[1])) * 180) / Math.PI) < 1e-12);
  assert.ok(g[1] < 45 - 0.17 && g[1] > 45 - 0.2, `${g[1]}`);
  assert.ok(Math.abs(g[2] - (Math.hypot(...p) * 1000 - 6370972)) < 1e-6);
  // As src/orbits.js's ecefToLngLatAlt (the Orbits layer's anchors) does it, and back exactly.
  const r = Math.hypot(...p);
  assert.deepEqual(g.map((x) => +x.toFixed(9)), [(Math.atan2(p[1], p[0]) * 180) / Math.PI, (Math.atan2(p[2], Math.hypot(p[0], p[1])) * 180) / Math.PI, r * 1000 - 6370972].map((x) => +x.toFixed(9)));
  const back = globeToEcef(...g);
  assert.ok(Math.hypot(back[0] - p[0], back[1] - p[1], back[2] - p[2]) < 1e-9);
  // Drawing the geodetic lat/height instead would put it ~21 km north of that.
  const wrong = globeToEcef(30, 45, 470e3);
  assert.ok(Math.hypot(wrong[0] - p[0], wrong[1] - p[1], wrong[2] - p[2]) > 15);
});
