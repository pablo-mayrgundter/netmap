import test from 'node:test';
import assert from 'node:assert/strict';
import { propagateAll, satellites } from './orbit.js';
import { clusterPlanes, clusterShells, markOperational, orbitAngles } from './shells.js';
import { EPOCH, walker } from './testShells.js';

// Two shells (53° at 550 km: 6 planes of 12; polar at 560 km: 3 planes of 10
// over 180°), and satellites in transit (raising, at 300-540 km) that aren't in either.
const omm = [
  ...walker({ incl: 53, alt: 550, planes: 6, per: 12, norad0: 50000 }),
  ...walker({ incl: 97.6, alt: 560, planes: 3, per: 10, spread: 180, norad0: 51000, raan0: 30 }),
  ...Array.from({ length: 30 }, (_, k) => ({ ...walker({ incl: 53, alt: 330 + k * 7, planes: 1, per: 1, norad0: 52000 + k })[0], RA_OF_ASC_NODE: k * 11 })),
];
const sats = satellites(omm);

test('clusterShells: two shells by inclination and altitude; transit satellites in none', () => {
  const { shellOf, shells } = clusterShells(sats, { minShell: 20 });
  assert.equal(shells.length, 2);
  assert.deepEqual(shells.map((s) => [Math.round(s.incl * 10) / 10, s.n]), [[53, 72], [97.6, 30]]);
  assert.ok(Math.abs(shells[0].alt - 550) < 1 && Math.abs(shells[1].alt - 560) < 1);
  assert.equal(shells[0].label, '53.0° · 550 km');
  for (let i = 0; i < 72; i++) assert.equal(shellOf[i], 0);
  for (let i = 72; i < 102; i++) assert.equal(shellOf[i], 1);
  // The transit ones near 550 km fall inside the shell's ±6 km window; the rest are out.
  const transit = [...shellOf.slice(102)];
  assert.ok(transit.filter((s) => s === -1).length >= 28, `${transit}`);
});

test('clusterPlanes: planes by RAAN round the shell, members by argument of latitude', () => {
  const { shellOf, shells } = clusterShells(sats, { minShell: 20 });
  const n = sats.length;
  const pos = new Float64Array(3 * n), vel = new Float64Array(3 * n), ok = new Uint8Array(n);
  propagateAll(sats, Date.parse(`${EPOCH}Z`) + 600000, pos, vel, ok);
  const raan = new Float64Array(n), u = new Float64Array(n);
  orbitAngles(pos, vel, ok, raan, u);
  const { planeOf, planes, byShell } = clusterPlanes(shellOf, shells.length, raan, u, ok);
  assert.equal(byShell[0].length, 6);
  assert.equal(byShell[1].length, 3);
  for (const id of byShell[0]) assert.equal(planes[id].members.length, 12);
  for (const id of byShell[1]) assert.equal(planes[id].members.length, 10);
  // Planes 60° apart (in the Earth-fixed frame all have turned the same way).
  const r = byShell[0].map((id) => planes[id].raan);
  for (let k = 1; k < r.length; k++) assert.ok(Math.abs(r[k] - r[k - 1] - 60) < 0.5, `${r}`);
  // In a plane, u increases by 30° from member to member.
  const m = planes[byShell[0][0]].members;
  for (let k = 1; k < m.length; k++) assert.ok(Math.abs(u[m[k]] - u[m[k - 1]] - 30) < 0.5, `${k}`);
  // Every member of a shell's planes is that shell's; transit satellites have no plane.
  for (let i = 0; i < 102; i++) assert.ok(planeOf[i] >= 0);
  assert.ok([...planeOf.slice(102)].filter((p) => p >= 0).length <= 2);
  // Operational: big and high enough, mostly in planes.
  markOperational(shells, [72, 30], { minSats: 50, minAlt: 400, minInPlanes: 0.7 });
  assert.deepEqual(shells.map((s) => s.operational), [true, false]);
});

test('clusterPlanes: planes 1.3° apart split; a plane across 0° RAAN stays whole', () => {
  // RAAN given directly: plane A at 359.6..0.4 (across the cut), B at 10, C at 11.6.
  const raan = Float64Array.from([359.6, 359.9, 0.1, 0.4, 10, 10.1, 10.2, 10.3, 11.6, 11.7, 11.8, 11.9]);
  const u = Float64Array.from(raan.map((_, k) => k * 30));
  const shellOf = new Int16Array(12);
  const ok = new Uint8Array(12).fill(1);
  const { planes, byShell } = clusterPlanes(shellOf, 1, raan, u, ok, { minPlane: 3 });
  assert.equal(byShell[0].length, 3);
  assert.deepEqual(byShell[0].map((id) => planes[id].members.length), [4, 4, 4]);
  const a = planes.find((p) => p.members.includes(0));
  assert.ok(a.raan > 359 || a.raan < 1, `${a.raan}`);
});
