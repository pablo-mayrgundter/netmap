// Synthetic Walker shells as OMM records, for the links section's tests.
import { MU, RE } from './orbit.js';

export const EPOCH = '2026-11-01T00:00:00.000';
export const revPerDay = (altKm) => (Math.sqrt(MU / (RE + altKm) ** 3) * 86400) / (2 * Math.PI);

/**
 * A Walker shell: `planes` planes of `per` satellites, RAAN spread over
 * `spread`° (360 for a Walker delta), in-plane spacing 360/per and a phase
 * offset between planes. NORAD ids from `norad0`; designators from `cospar`.
 */
export function walker({ incl, alt, planes, per, spread = 360, phase = 1, norad0 = 50000, cospar = '2023-001', raan0 = 0 }) {
  const out = [];
  for (let p = 0; p < planes; p++) {
    for (let k = 0; k < per; k++) {
      const n = norad0 + p * per + k;
      out.push({
        OBJECT_NAME: `STARLINK-${n}`,
        OBJECT_ID: `${cospar}${String.fromCharCode(65 + (k % 26))}`,
        NORAD_CAT_ID: n,
        EPOCH,
        MEAN_MOTION: revPerDay(alt),
        ECCENTRICITY: 0.0001,
        INCLINATION: incl,
        RA_OF_ASC_NODE: (raan0 + (p * spread) / planes) % 360,
        ARG_OF_PERICENTER: 0,
        MEAN_ANOMALY: ((360 / per) * k + (phase * 360 * p) / (planes * per)) % 360,
        BSTAR: 0,
        MEAN_MOTION_DOT: 0,
        MEAN_MOTION_DDOT: 0,
      });
    }
  }
  return out;
}
