// Visibility and link geometry, in Earth-fixed km: a ground point's ECEF and
// local up, the elevation and slant range of a satellite from it, whether a
// line between two points clears the Earth (with a grazing altitude for
// lasers), coverage radii and light time. DOM-free.

import { geodeticToEcef, RE } from './orbit.js';

const D2R = Math.PI / 180;
export const C_KM_S = 299792.458; // light in vacuum, km/s
export const FIBRE_INDEX = 1.47; // group index of silica fibre: light at c/1.47
export const EARTH_MEAN_KM = 6371.0088;

/** One-way light time in ms over `km` in vacuum (radio, lasers). */
export const vacuumMs = (km) => (km / C_KM_S) * 1000;
/** One-way light time in ms over `km` of fibre (c/1.47). */
export const fibreMs = (km) => (km * FIBRE_INDEX * 1000) / C_KM_S;

/**
 * A ground site for visibility tests: { lon, lat, h, p: ECEF km, up: the
 * geodetic up unit vector }.
 */
export function site(lon, lat, hKm = 0) {
  const la = lat * D2R, lo = lon * D2R;
  return { lon, lat, h: hKm, p: geodeticToEcef(lon, lat, hKm), up: [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)] };
}

/**
 * The elevation (°) of the point at pos[k..k+2] (ECEF km) seen from `s`
 * (a site), and its slant range in km, written into out[0], out[1].
 */
export function lookAt(s, pos, k, out) {
  const dx = pos[k] - s.p[0], dy = pos[k + 1] - s.p[1], dz = pos[k + 2] - s.p[2];
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out[0] = Math.asin(Math.max(-1, Math.min(1, (dx * s.up[0] + dy * s.up[1] + dz * s.up[2]) / r))) / D2R;
  out[1] = r;
  return out;
}

/** Azimuth (° from north, clockwise) of pos[k..] from site `s`. */
export function azimuth(s, pos, k) {
  const la = s.lat * D2R, lo = s.lon * D2R;
  const dx = pos[k] - s.p[0], dy = pos[k + 1] - s.p[1], dz = pos[k + 2] - s.p[2];
  const e = -Math.sin(lo) * dx + Math.cos(lo) * dy;
  const n = -Math.sin(la) * Math.cos(lo) * dx - Math.sin(la) * Math.sin(lo) * dy + Math.cos(la) * dz;
  return ((Math.atan2(e, n) / D2R) + 360) % 360;
}

/**
 * Whether the straight line between a and b (ECEF km, arrays or offsets into
 * one array) stays at least `graze` km above a sphere of radius RE: the
 * closest approach of the segment to the Earth's centre. For laser links the
 * grazing height keeps the beam out of the atmosphere.
 */
export function clears(ax, ay, az, bx, by, bz, graze = 0) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dd = dx * dx + dy * dy + dz * dz;
  let t = dd > 0 ? -(ax * dx + ay * dy + az * dz) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx, y = ay + t * dy, z = az + t * dz;
  const r = RE + graze;
  return x * x + y * y + z * z >= r * r;
}

/**
 * The Earth-central angle (°) from a ground point to the edge of a
 * satellite's coverage at `altKm` for an elevation mask `maskDeg`: the
 * footprint's radius on the ground is this times the Earth's radius.
 */
export function coverageAngle(altKm, maskDeg, r = EARTH_MEAN_KM) {
  const e = maskDeg * D2R;
  return (Math.acos((r * Math.cos(e)) / (r + altKm)) - e) / D2R;
}

/** The slant range (km) at elevation `maskDeg` to a satellite at `altKm`. */
export function slantAt(altKm, maskDeg, r = EARTH_MEAN_KM) {
  const e = maskDeg * D2R;
  const R = r + altKm;
  return Math.sqrt(R * R - r * r * Math.cos(e) ** 2) - r * Math.sin(e);
}

/** Great-circle distance (km) between lon/lat points, on the mean sphere. */
export function gcKm(lon0, lat0, lon1, lat1) {
  const dLat = (lat1 - lat0) * D2R, dLon = (lon1 - lon0) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat0 * D2R) * Math.cos(lat1 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MEAN_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A ring of `n` + 1 [lon, lat] points `angleDeg` (central angle) around lon/lat. */
export function ring(lon, lat, angleDeg, n = 72) {
  const la = lat * D2R, lo = lon * D2R, d = angleDeg * D2R;
  const out = [];
  let prev = lon;
  for (let i = 0; i <= n; i++) {
    const b = (i / n) * 2 * Math.PI;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    let lo2 = (lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2))) / D2R;
    while (lo2 - prev > 180) lo2 -= 360;
    while (lo2 - prev < -180) lo2 += 360;
    prev = lo2;
    out.push([lo2, la2 / D2R]);
  }
  return out;
}
