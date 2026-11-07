import test from 'node:test';
import assert from 'node:assert/strict';
import { propagateAll, satellites, geodeticToEcef } from './orbit.js';
import { clusterPlanes, clusterShells, orbitAngles } from './shells.js';
import { buildGrid, CROSS_PLANE, degrees, IN_PLANE, linkUp, refreshGrid } from './grid.js';
import { EPOCH, walker } from './testShells.js';

function shell(omm, t = Date.parse(`${EPOCH}Z`) + 600000) {
  const sats = satellites(omm);
  const n = sats.length;
  const { shellOf, shells } = clusterShells(sats, { minShell: 10 });
  const pos = new Float64Array(3 * n), vel = new Float64Array(3 * n), ok = new Uint8Array(n);
  propagateAll(sats, t, pos, vel, ok);
  const raan = new Float64Array(n), u = new Float64Array(n);
  orbitAngles(pos, vel, ok, raan, u);
  return { sats, n, pos, ok, shells, planes: clusterPlanes(shellOf, shells.length, raan, u, ok) };
}

test('+Grid on a full Walker shell: four links each, two in-plane and two cross-plane', () => {
  // 24 planes of 22 at 53° and 550 km: in-plane neighbours 1,900 km apart, planes 15° apart.
  const s = shell(walker({ incl: 53, alt: 550, planes: 24, per: 22, phase: 5 }));
  const use = new Uint8Array(s.n).fill(1);
  const g = buildGrid(s.planes, use, s.pos);
  const deg = degrees(g, s.n);
  // In each plane a ring of 22 links; between 24 planes (cyclic) a matching of 22.
  assert.equal([...g.kind].filter((k) => k === IN_PLANE).length, 24 * 22);
  assert.equal([...g.kind].filter((k) => k === CROSS_PLANE).length, 24 * 22);
  assert.ok([...deg].every((d) => d === 4), `${new Set(deg)}`);
  // No link twice, none to itself, all in range and clear of the Earth.
  const seen = new Set();
  for (let e = 0; e < g.n; e++) {
    const k = `${Math.min(g.a[e], g.b[e])}-${Math.max(g.a[e], g.b[e])}`;
    assert.ok(!seen.has(k) && g.a[e] !== g.b[e]);
    seen.add(k);
    assert.ok(linkUp(s.pos, g.a[e], g.b[e]));
  }
  // Cross-plane links join satellites in adjacent planes.
  const planeOf = s.planes.planeOf, order = s.planes.byShell[0];
  const rank = new Map(order.map((id, k) => [id, k]));
  for (let e = 0; e < g.n; e++) {
    if (g.kind[e] !== CROSS_PLANE) continue;
    const d = Math.abs(rank.get(planeOf[g.a[e]]) - rank.get(planeOf[g.b[e]]));
    assert.ok(d === 1 || d === order.length - 1, `planes ${d} apart`);
  }
});

test('+Grid: only laser-capable satellites; range and Earth occlusion cut links', () => {
  // A sparse shell: 3 planes of 4, in-plane neighbours 90° apart: their lines
  // go through the Earth, so no in-plane links at all.
  const s = shell(walker({ incl: 53, alt: 550, planes: 3, per: 4 }));
  const use = new Uint8Array(s.n).fill(1);
  const g = buildGrid(s.planes, use, s.pos);
  assert.equal([...g.kind].filter((k) => k === IN_PLANE).length, 0);
  for (let e = 0; e < g.n; e++) assert.ok(linkUp(s.pos, g.a[e], g.b[e]));
  // A denser one with half the satellites without lasers.
  const t = shell(walker({ incl: 53, alt: 550, planes: 12, per: 20 }));
  const half = Uint8Array.from({ length: t.n }, (_, i) => i % 2);
  const h = buildGrid(t.planes, half, t.pos);
  for (let e = 0; e < h.n; e++) assert.ok(half[h.a[e]] && half[h.b[e]]);
  assert.ok(h.n > 0);
  // With a short reach, only the in-plane links of the denser shell remain (1,960 km apart at 18°).
  const all = new Uint8Array(t.n).fill(1);
  const short = buildGrid(t.planes, all, t.pos, { maxRangeKm: 2200 });
  const full = buildGrid(t.planes, all, t.pos);
  assert.ok(short.n < full.n);
  assert.ok([...short.kind].filter((k) => k === IN_PLANE).length === 12 * 20);
});

test('refreshGrid: lengths, and links that go below the grazing height drop', () => {
  const pos = Float64Array.from([...geodeticToEcef(0, 0, 550), ...geodeticToEcef(20, 0, 550), ...geodeticToEcef(40, 0, 550)]);
  const grid = { a: Int32Array.from([0, 0]), b: Int32Array.from([1, 2]), n: 2 };
  const len = new Float64Array(2), up = new Uint8Array(2);
  // 0–2 are 40° apart: the chord's lowest point is (R + 550) cos 20° − R ≈ 132 km up.
  assert.equal(refreshGrid(grid, pos, len, up), 2);
  assert.ok(Math.abs(len[0] - 2 * (6378.137 + 550) * Math.sin((10 * Math.PI) / 180)) < 1);
  assert.equal(refreshGrid(grid, pos, len, up, { grazeKm: 150 }), 1);
  assert.deepEqual([...up], [1, 0]);
});
