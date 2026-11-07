// Where the constellation's element sets come from, and how each source's
// file becomes OMM records for SGP4. All three are CelesTrak's GP data:
//
// 1. celestiary's snapshot, the one its Orbits layer draws the satellites
//    from (celestiary.org/data/earth/satellites/networks/starlink.json, its
//    "celestiary-compact-omm-1" columns). First, so the modelled links meet
//    the satellites the globe shows.
// 2. netmap's own snapshot, `python -m netmap starlink-gp` (gp.json).
// 3. CelesTrak live (gp.php?GROUP=starlink&FORMAT=json).
//
// DOM-free (fetch is passed in), so node's tests import it.

import { ommRecords } from './orbit.js';

export const CELESTIARY_STARLINK = 'https://celestiary.org/data/earth/satellites/networks/starlink.json';
export const CELESTRAK_GP = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json';
const COMPACT = 'celestiary-compact-omm-1';
// Its columns and their fixed-point scales (celestiary's decodeElements).
const SCALES = [
  ['n', 'MEAN_MOTION', 1e8],
  ['e', 'ECCENTRICITY', 1e7],
  ['i', 'INCLINATION', 1e4],
  ['raan', 'RA_OF_ASC_NODE', 1e4],
  ['argp', 'ARG_OF_PERICENTER', 1e4],
  ['ma', 'MEAN_ANOMALY', 1e4],
  ['bstar', 'BSTAR', 1e9],
];

/**
 * celestiary's compact columns -> OMM records. NORAD ids are deltas, epochs
 * ms after `epochBase`, and an international designator that's only a piece
 * letter ("F") is of the launch before it.
 */
export function decodeCompact(c) {
  if (c?.format !== COMPACT) throw new Error(`not ${COMPACT}: ${c?.format}`);
  const base = Date.parse(c.epochBase);
  const out = new Array(c.id.length);
  let norad = 0;
  let launch = null;
  for (let k = 0; k < c.id.length; k++) {
    norad += c.id[k];
    const r = {
      NORAD_CAT_ID: norad,
      OBJECT_NAME: c.name ? (c.namePrefix ?? '') + c.name[k] : `NORAD ${norad}`,
      EPOCH: new Date(base + c.epoch[k]).toISOString(),
      MEAN_MOTION_DOT: 0,
      MEAN_MOTION_DDOT: 0,
    };
    if (c.intlId) {
      const d = c.intlId[k];
      r.OBJECT_ID = launch !== null && /^[A-Z]+$/.test(d) ? launch + d : d;
      launch = /^(\d{4}-\d{3})[A-Z]+$/.exec(r.OBJECT_ID)?.[1] ?? null;
    }
    for (const [key, field, scale] of SCALES) r[field] = c[key][k] / scale;
    out[k] = r;
  }
  return out;
}

/** The newest and median epochs (Unix ms) of OMM records. */
export function epochStats(omm) {
  const t = omm.map((r) => Date.parse(/Z$/.test(r.EPOCH) ? r.EPOCH : `${r.EPOCH}Z`)).filter(Number.isFinite).sort((a, b) => a - b);
  return t.length ? { min: t[0], median: t[t.length >> 1], max: t[t.length - 1] } : null;
}

/**
 * The sources in order: [{ id, label, url, parse(json) -> OMM records,
 * fetched(json) -> ISO time or null }]. `dataBase` is netmap's data URL.
 */
export function sources(dataBase) {
  return [
    {
      id: 'celestiary',
      label: "CelesTrak via celestiary (the Orbits layer's elements)",
      url: CELESTIARY_STARLINK,
      parse: decodeCompact,
      fetched: (j) => j.fetched ?? null,
    },
    {
      id: 'netmap',
      label: "CelesTrak, netmap's snapshot",
      url: `${dataBase}/starlink/gp.json`,
      parse: ommRecords,
      fetched: (j) => j.source?.fetched_at ?? j.generated ?? null,
    },
    { id: 'celestrak', label: 'CelesTrak, live', url: CELESTRAK_GP, parse: ommRecords, fetched: () => null },
  ];
}

/**
 * Fetch the first source that answers with element sets. `only` picks one
 * source by id. Returns { source, omm, fetched, epochs, tried: [{ id, error }] }
 * or throws with every source's error.
 */
export async function loadElements({ dataBase, fetchFn = fetch, signal, only = null }) {
  const tried = [];
  for (const s of sources(dataBase)) {
    if (only && s.id !== only) continue;
    try {
      const res = await fetchFn(s.url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!/json/.test(res.headers.get('content-type') ?? 'json')) throw new Error('not JSON');
      const j = await res.json();
      const omm = s.parse(j);
      if (!omm.length) throw new Error('no element sets');
      return { source: s, omm, fetched: s.fetched(j) ?? new Date().toISOString(), epochs: epochStats(omm), tried };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      tried.push({ id: s.id, error: String(err?.message ?? err) });
    }
  }
  const e = new Error(`no element sets: ${tried.map((t) => `${t.id}: ${t.error}`).join('; ')}`);
  e.tried = tried;
  throw e;
}
