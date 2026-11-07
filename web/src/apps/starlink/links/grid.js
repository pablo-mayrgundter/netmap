// The modelled laser mesh: a +Grid per shell, as in SpaceX's filings and the
// literature on it (arXiv 2103.00056): each laser-capable satellite links to
// the satellites before and after it in its plane (by argument of latitude)
// and to its nearest neighbour in each adjacent plane, four links at most.
// Links longer than a maximum range, or whose line comes closer to the Earth
// than a grazing height, aren't made (and drop out while they're so).
// DOM-free.

import { clears } from './geometry.js';

export const GRID = {
  maxRangeKm: 5000, // a laser terminal's reach (assumed)
  grazeKm: 80, // the beam stays this far above the surface (out of the denser atmosphere)
};

export const IN_PLANE = 0;
export const CROSS_PLANE = 1;

const dist = (pos, i, j) => {
  const a = 3 * i, b = 3 * j;
  const dx = pos[a] - pos[b], dy = pos[a + 1] - pos[b + 1], dz = pos[a + 2] - pos[b + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/** Whether the link i–j can be up: in range and clear of the Earth. */
export function linkUp(pos, i, j, o = GRID) {
  if (dist(pos, i, j) > o.maxRangeKm) return false;
  const a = 3 * i, b = 3 * j;
  return clears(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], o.grazeKm);
}

/**
 * Build the +Grid. `planes` and `byShell` are shells.js's clusterPlanes
 * (members in argument-of-latitude order, planes in RAAN order round each
 * shell); `use[i]` says whether satellite i takes part (laser-capable,
 * propagated, in a shell in service); `pos` its ECEF km.
 *
 * In-plane: consecutive members, and the last back to the first, round the
 * ring. Cross-plane: between each pair of adjacent planes (the last back to
 * the first), each satellite's nearest in the other plane, matched greedily
 * shortest first so that each satellite gets at most one link to each side.
 *
 * Returns { a, b, kind: typed arrays, n: the link count }.
 */
export function buildGrid({ planes, byShell }, use, pos, opts = {}) {
  const o = { ...GRID, ...opts };
  const A = [], B = [], K = [];
  const add = (i, j, k) => (A.push(i), B.push(j), K.push(k));
  // In each plane, round the ring.
  for (const p of planes) {
    const m = p.members.filter((i) => use[i]);
    if (m.length < 2) continue;
    for (let k = 0; k < m.length; k++) {
      const i = m[k], j = m[(k + 1) % m.length];
      if (m.length === 2 && k === 1) break; // two satellites: one link
      if (linkUp(pos, i, j, o)) add(i, j, IN_PLANE);
    }
  }
  // Between adjacent planes, round the shell.
  for (const ids of byShell) {
    if (ids.length < 2) continue;
    const pairs = ids.length === 2 ? [[ids[0], ids[1]]] : ids.map((id, k) => [id, ids[(k + 1) % ids.length]]);
    for (const [pa, pb] of pairs) {
      const P = planes[pa].members.filter((i) => use[i]);
      const Q = planes[pb].members.filter((i) => use[i]);
      if (!P.length || !Q.length) continue;
      const cand = [];
      for (const i of P) {
        let best = -1, bd = Infinity;
        for (const j of Q) {
          const d = dist(pos, i, j);
          if (d < bd) (bd = d), (best = j);
        }
        cand.push([bd, i, best]);
      }
      for (const j of Q) {
        let best = -1, bd = Infinity;
        for (const i of P) {
          const d = dist(pos, i, j);
          if (d < bd) (bd = d), (best = i);
        }
        cand.push([bd, best, j]);
      }
      cand.sort((x, y) => x[0] - y[0]);
      const east = new Set(), west = new Set();
      for (const [d, i, j] of cand) {
        if (east.has(i) || west.has(j) || d > o.maxRangeKm) continue;
        if (!linkUp(pos, i, j, o)) continue;
        east.add(i);
        west.add(j);
        add(i, j, CROSS_PLANE);
      }
    }
  }
  return { a: Int32Array.from(A), b: Int32Array.from(B), kind: Uint8Array.from(K), n: A.length };
}

/**
 * Refresh a grid's links for new positions: each link's length (km) into
 * `len` and whether it's up into `up` (1/0). Returns how many are up.
 */
export function refreshGrid(grid, pos, len, up, opts = {}) {
  const o = { ...GRID, ...opts };
  let n = 0;
  for (let e = 0; e < grid.n; e++) {
    const i = grid.a[e], j = grid.b[e];
    len[e] = dist(pos, i, j);
    up[e] = len[e] <= o.maxRangeKm && linkUp(pos, i, j, o) ? 1 : 0;
    n += up[e];
  }
  return n;
}

/** Each satellite's link count in a grid (a Uint8Array of n). */
export function degrees(grid, n) {
  const d = new Uint8Array(n);
  for (let e = 0; e < grid.n; e++) d[grid.a[e]]++, d[grid.b[e]]++;
  return d;
}
