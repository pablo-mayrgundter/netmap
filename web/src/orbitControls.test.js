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

test('orbitGlobe: across turns about the axis, up/down changes latitude, the ground follows', async () => {
  const { orbitGlobe } = await import('./orbitControls.js');
  const a = orbitGlobe({ longitude: 0, latitude: 0, zoom: 0 }, 100, 0, 1000);
  assert.ok(Math.abs(a.longitude + 18) < 1e-9 && a.latitude === 0 && Math.abs(a.zoom) < 1e-9);
  const b = orbitGlobe({ longitude: 0, latitude: 0, zoom: 1 }, 0, 100, 1000);
  assert.ok(Math.abs(b.latitude - 9) < 1e-9 && b.longitude === 0 && b.zoom < 1);
  assert.equal(orbitGlobe({ longitude: 0, latitude: 80, zoom: 0 }, 0, 1000, 1000).latitude, 89);
});
