import test from 'node:test';
import assert from 'node:assert/strict';
import { assignTraffic, demandRegions } from './traffic.js';
import { adjacency, dijkstra } from './route.js';

test('demandRegions: placed regions, weighted by IPv4 addresses (else prefixes)', () => {
  const d = demandRegions([
    { id: 0, city: 'Wichita', lat: 37.7, lon: -97.3, v4_addresses: 1024, v4_prefixes: 4, v6_prefixes: 1 },
    { id: 1, city: 'Nowhere', lat: null, lon: null, v4_addresses: 512 },
    { id: 2, city: 'Only v6', lat: 10, lon: 10, v4_addresses: 0, v4_prefixes: 0, v6_prefixes: 3 },
    { id: 3, city: 'Empty', lat: 1, lon: 1, v4_addresses: 0, v4_prefixes: 0, v6_prefixes: 0 },
  ]);
  assert.deepEqual(d.map((p) => [p.id, p.w]), [[0, 1024], [2, 3]]);
  assert.ok(d[0].s.p.length === 3);
});

test('assignTraffic: bent pipes, laser paths and the unserved, summed per link and gateway', () => {
  // Satellites 0-1-2-3 in a line; 3 sees gateway 0, 0 sees gateway 1.
  const a = Int32Array.from([0, 1, 2]), b = Int32Array.from([1, 2, 3]), w = Float64Array.from([1, 1, 1]);
  const exitGw = Int32Array.from([-1, -1, -1, 0]);
  const tree = dijkstra(adjacency(4, a, b), w, [[3, 2]]);
  const points = [
    { id: 'kansas', w: 100, serve: { i: 3, rule: 'bent-pipe' } },
    { id: 'ocean', w: 10, serve: { i: 0, rule: 'laser' } },
    { id: 'ocean2', w: 5, serve: { i: 1, rule: 'laser' } },
    { id: 'void', w: 7, serve: null },
    { id: 'stuck', w: 3, serve: { i: 2, rule: 'no-gateway' } },
  ];
  const r = assignTraffic(points, { serve: (p) => p.serve, tree, exitGw, nLinks: 3, nGateways: 2 });
  assert.deepEqual([...r.link], [10, 15, 15]);
  assert.deepEqual([...r.gateway], [115, 0]);
  assert.deepEqual([...r.feeder.values()], [{ sat: 3, gw: 0, load: 115 }]);
  assert.equal(r.total, 125);
  assert.equal(r.bent, 100);
  assert.equal(r.laser, 15);
  assert.equal(r.unserved, 10);
  assert.ok(Math.abs(r.hops - (10 * 3 + 5 * 2) / 15) < 1e-12);
});
