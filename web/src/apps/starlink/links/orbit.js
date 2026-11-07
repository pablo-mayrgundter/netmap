// SGP4 for the Starlink constellation: element sets (CelesTrak's GP/OMM
// records, or two-line elements) into satellite records, and the whole
// constellation propagated into typed arrays of Earth-fixed positions. Also
// what the elements say without propagating: altitude, inclination, and the
// launch (from the international designator), which decides laser links.
// DOM-free: the worker and node's tests import it.

import { gstime, json2satrec, sgp4, twoline2satrec } from 'satellite.js';

export const MU = 398600.4418; // km³/s², Earth's gravitational parameter
export const RE = 6378.137; // km, WGS84 equatorial radius
const F = 1 / 298.257223563; // WGS84 flattening
const E2 = F * (2 - F);
const D2R = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** Unix ms -> Julian date (UTC, standing in for UT1). */
export const julian = (ms) => ms / 86400000 + 2440587.5;

/** Semi-major axis (km) from the mean motion in revolutions a day. */
export const semiMajorKm = (revPerDay) => Math.cbrt(MU / (((revPerDay * TWO_PI) / 86400) ** 2));

/** The mean altitude above the equatorial radius (km), from the mean motion. */
export const meanAltitudeKm = (revPerDay) => semiMajorKm(revPerDay) - RE;

/**
 * The launch in an international (COSPAR) designator: "2021-082A" ->
 * { year: 2021, launch: 82, piece: 'A' }, or null.
 */
export function parseDesignator(id) {
  const m = /^(\d{4})-(\d{3})([A-Z]*)$/.exec(String(id ?? '').trim());
  return m ? { year: Number(m[1]), launch: Number(m[2]), piece: m[3] } : null;
}

/**
 * Laser (inter-satellite link) capability, modelled from the launch: Starlink
 * v1.5 and later carry lasers, and the first v1.5 launch was Group 2-1 on
 * 2021-09-14, COSPAR 2021-082. Launches from it on are laser-capable, earlier
 * ones not. (The ten polar test satellites of January 2021 are ignored.)
 */
export const LASER_CUTOFF = { year: 2021, launch: 82, date: '2021-09-14', label: 'Group 2-1, COSPAR 2021-082' };
export function laserCapable(id) {
  const d = parseDesignator(id);
  if (!d) return false;
  return d.year > LASER_CUTOFF.year || (d.year === LASER_CUTOFF.year && d.launch >= LASER_CUTOFF.launch);
}

/** gp.json's columns ({ fields, rows }) or a list of OMM records -> OMM records. */
export function ommRecords(gp) {
  if (Array.isArray(gp)) return gp;
  if (!gp?.fields || !Array.isArray(gp.rows)) return [];
  const f = gp.fields;
  return gp.rows.map((r) => {
    const o = {};
    for (let k = 0; k < f.length; k++) if (r[k] !== null && r[k] !== undefined) o[f[k]] = r[k];
    return o;
  });
}

/**
 * Satellite records from OMM records: { satrec, norad, name, id, incl (°),
 * raan (° at epoch), ecc, mm (rev/day), alt (km, mean), epoch (Unix ms),
 * laser }. Records SGP4 can't start from are dropped.
 */
export function satellites(omm) {
  const out = [];
  for (const o of omm) {
    let satrec;
    try {
      satrec = json2satrec(o);
    } catch {
      continue;
    }
    if (!satrec || satrec.error) continue;
    const mm = Number(o.MEAN_MOTION);
    out.push({
      satrec,
      norad: Number(o.NORAD_CAT_ID),
      name: String(o.OBJECT_NAME ?? ''),
      id: String(o.OBJECT_ID ?? ''),
      incl: Number(o.INCLINATION),
      raan: Number(o.RA_OF_ASC_NODE),
      ecc: Number(o.ECCENTRICITY),
      mm,
      alt: meanAltitudeKm(mm),
      epoch: Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(o.EPOCH) ? o.EPOCH : `${o.EPOCH}Z`),
      laser: laserCapable(o.OBJECT_ID),
    });
  }
  return out;
}

/** A satellite record from two-line elements (tests, and TLE sources). */
export function fromTLE(line1, line2, name = '') {
  const satrec = twoline2satrec(line1, line2);
  return { satrec, norad: Number(satrec.satnum), name, id: '', laser: false };
}

/**
 * Propagate one satellite to `ms` (Unix ms UTC): its position in TEME (km),
 * or null if SGP4 fails (decayed, bad elements).
 */
export function temeAt(sat, ms) {
  const m = (julian(ms) - sat.satrec.jdsatepoch) * 1440;
  const pv = sgp4(sat.satrec, m);
  return pv && pv.position ? pv : null;
}

/**
 * Propagate `sats` to `ms` into Earth-fixed (ECEF) positions and velocities,
 * km and km/s in the rotating frame (TEME rotated by GMST; polar motion
 * ignored). `pos` and `vel` are Float64Array(3n); `ok` a Uint8Array(n), 1
 * where SGP4 succeeded. Velocities are inertial (TEME) rotated into the
 * frame, which is what the orbit's plane needs. Returns the count that
 * propagated.
 */
export function propagateAll(sats, ms, pos, vel, ok) {
  const jd = julian(ms);
  const g = gstime(jd);
  const c = Math.cos(g), s = Math.sin(g);
  let n = 0;
  for (let i = 0; i < sats.length; i++) {
    const sat = sats[i];
    const pv = sgp4(sat.satrec, (jd - sat.satrec.jdsatepoch) * 1440);
    const p = pv && pv.position;
    const k = 3 * i;
    if (!p || !Number.isFinite(p.x)) {
      ok[i] = 0;
      pos[k] = pos[k + 1] = pos[k + 2] = 0;
      if (vel) vel[k] = vel[k + 1] = vel[k + 2] = 0;
      continue;
    }
    ok[i] = 1;
    n++;
    pos[k] = c * p.x + s * p.y;
    pos[k + 1] = -s * p.x + c * p.y;
    pos[k + 2] = p.z;
    if (vel) {
      const v = pv.velocity;
      vel[k] = c * v.x + s * v.y;
      vel[k + 1] = -s * v.x + c * v.y;
      vel[k + 2] = v.z;
    }
  }
  return n;
}

/** TEME position (km) -> ECEF at Unix ms. */
export function temeToEcef(p, ms) {
  const g = gstime(julian(ms));
  const c = Math.cos(g), s = Math.sin(g);
  return [c * p.x + s * p.y, -s * p.x + c * p.y, p.z];
}

/** Geodetic (WGS84) lon, lat (°) and height (km) -> ECEF (km). */
export function geodeticToEcef(lon, lat, h = 0, out = [0, 0, 0]) {
  const la = lat * D2R, lo = lon * D2R;
  const sl = Math.sin(la), cl = Math.cos(la);
  const n = RE / Math.sqrt(1 - E2 * sl * sl);
  out[0] = (n + h) * cl * Math.cos(lo);
  out[1] = (n + h) * cl * Math.sin(lo);
  out[2] = (n * (1 - E2) + h) * sl;
  return out;
}

/**
 * ECEF (km) -> [lon °, lat °, height km] on WGS84 (Bowring's method, two
 * iterations: well under a metre at LEO heights). Writes into `out` at `k`.
 */
export function ecefToGeodetic(x, y, z, out = [0, 0, 0], k = 0) {
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  let lat = Math.atan2(z, p * (1 - E2));
  let n = RE;
  for (let it = 0; it < 3; it++) {
    const sl = Math.sin(lat);
    n = RE / Math.sqrt(1 - E2 * sl * sl);
    lat = Math.atan2(z + E2 * n * sl, p);
  }
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const h = Math.abs(cl) > 1e-9 ? p / cl - n : Math.abs(z) - n * (1 - E2);
  out[k] = lon / D2R;
  out[k + 1] = lat / D2R;
  out[k + 2] = h;
  return out;
}
