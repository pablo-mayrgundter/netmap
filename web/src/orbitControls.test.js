import test from 'node:test';
import assert from 'node:assert/strict';
import { orbitDelta, strafeGlobe, isPanDrag } from './orbitControls.js';

test('orbitDelta: linear, a viewport height is 180 degrees', () => {
  assert.deepEqual(orbitDelta(500, 0, 1000), { bearing: 90, pitch: -0 });
  assert.deepEqual(orbitDelta(0, -250, 1000), { bearing: 0, pitch: 45 });
});

test('strafeGlobe: right is east when north is up, south when east is up', () => {
  const east = strafeGlobe({ longitude: 0, latitude: 0, bearing: 0 }, 10);
  assert.ok(Math.abs(east.longitude - 10) < 1e-9 && Math.abs(east.latitude) < 1e-9);
  const south = strafeGlobe({ longitude: 0, latitude: 0, bearing: 90 }, 10);
  assert.ok(Math.abs(south.latitude + 10) < 1e-9 && Math.abs(south.longitude) < 1e-9);
  assert.ok(Math.abs(strafeGlobe({ longitude: 175, latitude: 0 }, 10).longitude + 175) < 1e-9);
});

test('isPanDrag: right button or a modifier', () => {
  assert.equal(isPanDrag({ button: 0 }), false);
  assert.equal(isPanDrag({ button: 2 }), true);
  assert.equal(isPanDrag({ button: 0, shiftKey: true }), true);
});

test('rotateScale: alt/R near the ground, 1 far out, never 0', async () => {
  const { rotateScale } = await import('./orbitControls.js');
  assert.ok(Math.abs(rotateScale(1, 1000) - 0.001) < 1e-6);
  assert.ok(rotateScale(5, 1) > 0.99 && rotateScale(50, 1) === 1);
  assert.equal(rotateScale(0, 1), 1e-6);
});

test('orbitGlobe: across turns about the axis, up/down changes latitude, slower up close', async () => {
  const { orbitGlobe, ORBIT_RAD_PER_PX } = await import('./orbitControls.js');
  const far = orbitGlobe({ longitude: 0, latitude: 0, zoom: 0 }, 100, 0, 1000); // alt/R ~ 18: full rate
  assert.ok(Math.abs(far.longitude + (100 * ORBIT_RAD_PER_PX * 180) / Math.PI) < 1e-6 && far.latitude === 0);
  const b = orbitGlobe({ longitude: 0, latitude: 0, zoom: 0 }, 0, 10, 1000);
  assert.ok(b.latitude > 0 && b.longitude === 0 && b.zoom < 0);
  const near = orbitGlobe({ longitude: 0, latitude: 0, zoom: 12 }, 100, 0, 1000);
  assert.ok(Math.abs(near.longitude) < Math.abs(far.longitude) / 100);
  // capped: up close a pixel turns the Earth 1 / R, the ground keeps pace with the pointer
  const R = 256 * Math.pow(2, 12) / Math.PI;
  assert.ok(Math.abs(near.longitude + (100 / R) * 180 / Math.PI) < 1e-9);
  assert.equal(orbitGlobe({ longitude: 0, latitude: 80, zoom: 0 }, 0, 10000, 1000).latitude, 89);
});
