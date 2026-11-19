import test from 'node:test';
import assert from 'node:assert/strict';
import { CENTERS, distanceKm, INCIDENTS, nearestCenter, NOV13, parseStep, shapeIncident, stepParam } from './data.js';

test('22 en route centers, unique ids, on the map', () => {
  assert.equal(CENTERS.length, 22);
  assert.equal(new Set(CENTERS.map((c) => c.id)).size, 22);
  for (const c of CENTERS) {
    assert.match(c.id, /^Z[A-Z]{2}$/);
    assert.ok(c.lat > 15 && c.lat < 72 && c.lon > -170 && c.lon < -60, c.id);
  }
});

test('distanceKm: about right, and symmetric', () => {
  const nyc = { lat: 40.71, lon: -74.01 }, la = { lat: 34.05, lon: -118.24 };
  const d = distanceKm(nyc, la);
  assert.ok(d > 3900 && d < 4000, String(d));
  assert.equal(Math.round(distanceKm(la, nyc)), Math.round(d));
  assert.equal(distanceKm(nyc, nyc), 0);
});

test('the sites home to their nearest center (modelled)', () => {
  const home = (id) => nearestCenter(NOV13.sites.find((s) => s.id === id)).id;
  assert.equal(home('eld'), 'ZME');
  assert.equal(home('ama'), 'ZAB');
});

test('parseStep and stepParam round-trip, default out of the hash', () => {
  const inc = NOV13;
  assert.equal(parseStep(inc, null), inc.defaultStep);
  assert.equal(parseStep(inc, 'x'), inc.defaultStep);
  assert.equal(parseStep(inc, '1.5'), inc.defaultStep);
  assert.equal(parseStep(inc, '-3'), 0);
  assert.equal(parseStep(inc, '99'), inc.steps.length - 1);
  assert.equal(stepParam(inc, inc.defaultStep), null);
  for (let k = 0; k < inc.steps.length; k++) assert.equal(parseStep(inc, stepParam(inc, k)), k);
});

test('steps: the flood reaches every other center, then the sites are cut off', () => {
  const ids = NOV13.steps.map((s) => s.id);
  const flood = shapeIncident(NOV13, ids.indexOf('flood'));
  assert.equal(flood.sites.length, 2);
  assert.equal(flood.access.length, 2);
  assert.equal(flood.homes.length, 2);
  assert.equal(flood.reach.length, 2 * (CENTERS.length - 1));
  assert.ok(flood.reach.every((r) => r.from !== r.to && r.path.length >= 2));
  const block = shapeIncident(NOV13, ids.indexOf('block'));
  assert.equal(block.reach.length, 0);
  assert.ok(block.sites.every((s) => s.blocked));
  const before = shapeIncident(NOV13, 0);
  assert.equal(before.reach.length, 0);
  assert.ok(before.sites.every((s) => !s.blocked));
});

test('globe paths are lifted, flat ones are not', () => {
  const k = NOV13.steps.findIndex((s) => s.id === 'flood');
  const flat = shapeIncident(NOV13, k);
  const globe = shapeIncident(NOV13, k, { globe: true });
  assert.ok(flat.reach.every((r) => r.path.every((p) => p[2] === 0)));
  assert.ok(globe.reach.some((r) => r.path.some((p) => p[2] > 6e3)));
});

test('incidents: sources, steps with times, and a step in range by default', () => {
  for (const inc of INCIDENTS) {
    assert.ok(inc.sources.length > 0 && inc.sources.every(([, u]) => /^https:\/\//.test(u)));
    assert.ok(inc.steps.every((s) => s.time && s.title && s.text && s.state));
    assert.ok(inc.defaultStep >= 0 && inc.defaultStep < inc.steps.length);
    for (const s of inc.steps) for (const id of s.state.sites) assert.ok(inc.sites.some((x) => x.id === id), id);
  }
});
