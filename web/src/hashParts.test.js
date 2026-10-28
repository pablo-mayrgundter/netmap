import test from 'node:test';
import assert from 'node:assert/strict';
import { hashChanges } from './hashParts.js';

const q = (s) => new URLSearchParams(s);
const now = q('data=internet&edges=0.05&lon=10.000&lat=25.000&z=1.60&as=3356,13335&at=2&open=1');

test('the same permalink: nothing changed', () => {
  assert.deepEqual(hashChanges(q(now.toString()), now), { camera: false, route: false });
});

test('a slider: neither the camera nor the route', () => {
  assert.deepEqual(hashChanges(q('data=internet&edges=0.3&lon=10.000&lat=25.000&z=1.60&as=3356,13335&at=2&open=1'), now), { camera: false, route: false });
});

test('the order of the keys does not matter', () => {
  assert.deepEqual(hashChanges(q('as=3356,13335&open=1&at=2&z=1.60&lat=25.000&lon=10.000&data=internet'), now), { camera: false, route: false });
});

test('the camera, alone', () => {
  for (const [k, v] of [['lon', '-74'], ['lat', '40.7'], ['z', '3'], ['pitch', '30'], ['bearing', '10']]) {
    const h = q(now.toString());
    h.set(k, v);
    assert.deepEqual(hashChanges(h, now), { camera: true, route: false }, k);
  }
});

test('each part of the route, alone', () => {
  for (const [k, v] of [['as', '174'], ['at', '1'], ['open', '0'], ['sel', '174']]) {
    const h = q(now.toString());
    h.set(k, v);
    assert.deepEqual(hashChanges(h, now), { camera: false, route: true }, k);
  }
  const h = q(now.toString());
  h.delete('as');
  assert.equal(hashChanges(h, now).route, true, 'as removed');
});

test('pop= and selpop= count on router maps only', () => {
  const routers = q('data=routers&as=3356&pop=21125&at=1&open=1&sel=174&selpop=386');
  for (const [k, v] of [['pop', '21122'], ['selpop', '385']]) {
    const h = q(routers.toString());
    h.set(k, v);
    assert.equal(hashChanges(h, routers, { routers: true }).route, true, k);
    assert.equal(hashChanges(h, routers).route, false, `${k} on an AS map`);
  }
  // a router link's pop= on an AS map, whose permalink has none
  assert.equal(hashChanges(q('as=3356,13335&at=2&open=1&pop=1,2&lon=10.000&lat=25.000&z=1.60'), now).route, false);
});
