// Starlink's shells and orbital planes, clustered from the elements: a shell
// is a group of satellites at one inclination and mean altitude; a plane is a
// group of a shell's satellites with the same right ascension of the
// ascending node (RAAN), ordered round the shell. Satellites in neither (orbit
// raising, lowering, drifting between planes, deorbiting) are left out of the
// model: they don't serve users and carry no laser links here. DOM-free.

const D2R = Math.PI / 180;

export const SHELL_DEFAULTS = {
  maxEcc: 0.005, // near-circular only
  minAlt: 300, // km: below this a satellite is raising or deorbiting
  maxAlt: 700,
  inclGap: 0.25, // ° between sorted inclinations that starts a new group
  altWindow: 6, // km either side of a shell's peak altitude
  minShell: 40, // satellites for a shell
};

// Which shells are in service, in the model: big enough, high enough (below
// 400 km satellites are still raising their orbits after launch, or coming
// down), and mostly in planes (a shell that's a stream of satellites passing
// through an altitude isn't one).
export const OPERATIONAL = { minSats: 150, minAlt: 400, minInPlanes: 0.7 };

/** Mark shells operational: `inPlanes[s]` is how many of shell s's satellites are in planes. */
export function markOperational(shells, inPlanes, o = OPERATIONAL) {
  for (const s of shells) s.operational = s.n >= o.minSats && s.alt >= o.minAlt && (inPlanes[s.id] ?? 0) >= o.minInPlanes * s.n;
  return shells;
}

/**
 * Cluster satellites into shells from their elements ({ incl, alt, ecc }):
 * sort by inclination and split at gaps, then in each inclination group take
 * the densest altitudes, a ±altWindow km window at a time, while one holds
 * at least minShell satellites. Returns { shellOf: Int16Array (-1: none),
 * shells: [{ id, incl, alt, n, label }] }, the shells by inclination then
 * altitude.
 */
export function clusterShells(sats, opts = {}) {
  const o = { ...SHELL_DEFAULTS, ...opts };
  const shellOf = new Int16Array(sats.length).fill(-1);
  const cand = [];
  for (let i = 0; i < sats.length; i++) {
    const s = sats[i];
    if (s.ecc <= o.maxEcc && s.alt >= o.minAlt && s.alt <= o.maxAlt && Number.isFinite(s.incl)) cand.push(i);
  }
  cand.sort((a, b) => sats[a].incl - sats[b].incl);
  const groups = [];
  let g = [];
  for (const i of cand) {
    if (g.length && sats[i].incl - sats[g[g.length - 1]].incl > o.inclGap) groups.push(g), (g = []);
    g.push(i);
  }
  if (g.length) groups.push(g);
  const found = [];
  for (const grp of groups) {
    let left = grp.slice();
    for (;;) {
      if (left.length < o.minShell) break;
      // The densest window: sort by altitude, slide a 2·window span.
      left.sort((a, b) => sats[a].alt - sats[b].alt);
      let best = 0, bestLo = 0, j = 0;
      for (let k = 0; k < left.length; k++) {
        while (sats[left[k]].alt - sats[left[j]].alt > 2 * o.altWindow) j++;
        if (k - j + 1 > best) (best = k - j + 1), (bestLo = j);
      }
      if (best < o.minShell) break;
      const members = left.slice(bestLo, bestLo + best);
      const alts = members.map((i) => sats[i].alt).sort((a, b) => a - b);
      const incls = members.map((i) => sats[i].incl).sort((a, b) => a - b);
      found.push({ members, alt: alts[alts.length >> 1], incl: incls[incls.length >> 1] });
      left = left.slice(0, bestLo).concat(left.slice(bestLo + best));
    }
  }
  found.sort((a, b) => a.incl - b.incl || a.alt - b.alt);
  const shells = found.map((f, id) => {
    for (const i of f.members) shellOf[i] = id;
    return { id, incl: f.incl, alt: f.alt, n: f.members.length, label: shellLabel(f.incl, f.alt) };
  });
  return { shellOf, shells };
}

export const shellLabel = (incl, alt) => `${incl.toFixed(1)}° · ${Math.round(alt)} km`;

/**
 * Each satellite's orbit, from its Earth-fixed position and inertial
 * velocity (orbit.js's propagateAll): the RAAN in the Earth-fixed frame (°,
 * 0..360) and the argument of latitude u (°, 0..360, from the ascending
 * node in the direction of motion). Writes raan[i], u[i] for ok[i].
 */
export function orbitAngles(pos, vel, ok, raan, u) {
  const n = ok.length;
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue;
    const k = 3 * i;
    const rx = pos[k], ry = pos[k + 1], rz = pos[k + 2];
    const vx = vel[k], vy = vel[k + 1], vz = vel[k + 2];
    const hx = ry * vz - rz * vy, hy = rz * vx - rx * vz, hz = rx * vy - ry * vx;
    const h = Math.sqrt(hx * hx + hy * hy + hz * hz);
    // The ascending node: z × h = (-hy, hx, 0).
    let nx = -hy, ny = hx;
    const nn = Math.hypot(nx, ny) || 1;
    nx /= nn;
    ny /= nn;
    raan[i] = ((Math.atan2(ny, nx) / D2R) + 360) % 360;
    // In the plane: n, and (h × n)/|h| at 90° ahead of it.
    const mx = (hy * 0 - hz * ny) / h, my = (hz * nx - hx * 0) / h, mz = (hx * ny - hy * nx) / h;
    u[i] = ((Math.atan2(rx * mx + ry * my + rz * mz, rx * nx + ry * ny) / D2R) + 360) % 360;
  }
}

export const PLANE_DEFAULTS = {
  gap: 1.0, // ° of RAAN between sorted satellites that starts a new plane
  maxSpan: 1.6, // ° a plane may span before it's split at its widest gap (two planes close together)
  minPlane: 4, // satellites for a plane
};

/**
 * Cluster each shell's satellites into planes by RAAN, on the circle: sort,
 * cut at the largest gap and at every gap over `gap`°; planes wider than
 * `maxSpan` are split at their widest inner gap; planes with fewer than
 * `minPlane` satellites are drifting ones, left out. Planes are numbered
 * round each shell by RAAN.
 *
 * Returns { planeOf: Int32Array (-1: none), planes: [{ id, shell, raan,
 * members: [sat index by u] }], byShell: [[plane ids in RAAN order]] }.
 */
export function clusterPlanes(shellOf, nShells, raan, u, ok, opts = {}) {
  const o = { ...PLANE_DEFAULTS, ...opts };
  const planeOf = new Int32Array(shellOf.length).fill(-1);
  const planes = [];
  const byShell = [];
  const per = Array.from({ length: nShells }, () => []);
  for (let i = 0; i < shellOf.length; i++) if (shellOf[i] >= 0 && ok[i]) per[shellOf[i]].push(i);
  for (let s = 0; s < nShells; s++) {
    const list = per[s].sort((a, b) => raan[a] - raan[b]);
    byShell.push([]);
    if (!list.length) continue;
    // Rotate so the list starts after the largest gap (the circle's cut).
    let cut = 0, big = -1;
    for (let k = 0; k < list.length; k++) {
      const next = k + 1 < list.length ? raan[list[k + 1]] : raan[list[0]] + 360;
      if (next - raan[list[k]] > big) (big = next - raan[list[k]]), (cut = (k + 1) % list.length);
    }
    const ring = list.slice(cut).concat(list.slice(0, cut));
    // RAAN unwrapped along the ring, so it only grows.
    const ur = new Float64Array(ring.length);
    let off = 0;
    for (let k = 0; k < ring.length; k++) {
      if (k && raan[ring[k]] + off < ur[k - 1]) off += 360;
      ur[k] = raan[ring[k]] + off;
    }
    const unwrap = (k) => ur[k];
    const groups = [];
    let g = [0];
    for (let k = 1; k < ring.length; k++) {
      if (unwrap(k) - unwrap(k - 1) > o.gap) groups.push(g), (g = []);
      g.push(k);
    }
    groups.push(g);
    const split = (grp) => {
      if (grp.length < 2 || unwrap(grp[grp.length - 1]) - unwrap(grp[0]) <= o.maxSpan) return [grp];
      let at = 1, w = -1;
      for (let k = 1; k < grp.length; k++) {
        const d = unwrap(grp[k]) - unwrap(grp[k - 1]);
        if (d > w) (w = d), (at = k);
      }
      return [...split(grp.slice(0, at)), ...split(grp.slice(at))];
    };
    for (const grp of groups.flatMap(split)) {
      if (grp.length < o.minPlane) continue;
      const members = grp.map((k) => ring[k]).sort((a, b) => u[a] - u[b]);
      let sx = 0, sy = 0;
      for (const i of members) (sx += Math.cos(raan[i] * D2R)), (sy += Math.sin(raan[i] * D2R));
      const id = planes.length;
      planes.push({ id, shell: s, raan: ((Math.atan2(sy, sx) / D2R) + 360) % 360, members });
      for (const i of members) planeOf[i] = id;
      byShell[s].push(id);
    }
    byShell[s].sort((a, b) => planes[a].raan - planes[b].raan);
  }
  return { planeOf, planes, byShell };
}
