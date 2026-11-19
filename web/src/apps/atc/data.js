// The ATC app's data: the FAA's 22 en route centers (ARTCCs), and incidents
// on the network that connects them, each with its sites and a timeline.
// DOM-free, so node's tests import it.
//
// What's measured and what's modelled (apps/README.md: anything modelled says
// so). The centers' places are public (the FAA's facility list; city-level
// here). The incident's sites, times and counts are from the FAA's Q&A and
// press reports, with conflicts kept as ranges. The circuits are not public:
// which center a remote site homes to, and how the FAA Telecommunications
// Infrastructure (FTI) backbone joins the centers, are modelled here (nearest
// center; a line to every other center to show reach, not paths).

import { greatCircle } from '../starlink/pops/data.js';

// [id, name, city, lat, lon]: the 20 CONUS centers, Anchorage and Honolulu.
const CENTER_ROWS = [
  ['ZAB', 'Albuquerque Center', 'Albuquerque, NM', 35.173, -106.567],
  ['ZAN', 'Anchorage Center', 'Anchorage, AK', 61.229, -149.781],
  ['ZAU', 'Chicago Center', 'Aurora, IL', 41.782, -88.331],
  ['ZBW', 'Boston Center', 'Nashua, NH', 42.736, -71.481],
  ['ZDC', 'Washington Center', 'Leesburg, VA', 39.102, -77.543],
  ['ZDV', 'Denver Center', 'Longmont, CO', 40.187, -105.127],
  ['ZFW', 'Fort Worth Center', 'Fort Worth, TX', 32.831, -97.067],
  ['ZHN', 'Honolulu Control Facility', 'Honolulu, HI', 21.33, -157.92],
  ['ZHU', 'Houston Center', 'Houston, TX', 29.962, -95.332],
  ['ZID', 'Indianapolis Center', 'Indianapolis, IN', 39.737, -86.281],
  ['ZJX', 'Jacksonville Center', 'Hilliard, FL', 30.699, -81.908],
  ['ZKC', 'Kansas City Center', 'Olathe, KS', 38.88, -94.791],
  ['ZLA', 'Los Angeles Center', 'Palmdale, CA', 34.603, -118.084],
  ['ZLC', 'Salt Lake City Center', 'Salt Lake City, UT', 40.786, -111.952],
  ['ZMA', 'Miami Center', 'Miami, FL', 25.825, -80.319],
  ['ZME', 'Memphis Center', 'Memphis, TN', 35.067, -89.955],
  ['ZMP', 'Minneapolis Center', 'Farmington, MN', 44.637, -93.152],
  ['ZNY', 'New York Center', 'Ronkonkoma, NY', 40.784, -73.098],
  ['ZOA', 'Oakland Center', 'Fremont, CA', 37.543, -122.016],
  ['ZOB', 'Cleveland Center', 'Oberlin, OH', 41.297, -82.206],
  ['ZSE', 'Seattle Center', 'Auburn, WA', 47.287, -122.188],
  ['ZTL', 'Atlanta Center', 'Hampton, GA', 33.38, -84.297],
];

export const CENTERS = CENTER_ROWS.map(([id, name, city, lat, lon]) => ({ id, name, city, lat, lon }));
export const CENTER_BY_ID = new Map(CENTERS.map((c) => [c.id, c]));

const R_KM = 6371;
const D2R = Math.PI / 180;

/** Great-circle distance in km between two { lat, lon }. */
export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * D2R, dLon = (b.lon - a.lon) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The center nearest a place: the modelled home of a remote site. */
export function nearestCenter(p, centers = CENTERS) {
  let best = null, bestKm = Infinity;
  for (const c of centers) {
    const d = distanceKm(p, c);
    if (d < bestKm) (best = c), (bestKm = d);
  }
  return best;
}

// The nationwide ground stop of Friday 13 November 2026. Times are ET.
// Sources: the FAA's "Nationwide Ground Stop: Questions and Answers", and
// reporting by CNN, CNBC, CBS, The Hill and others (listed in SOURCES).
export const NOV13 = {
  id: 'nov13',
  title: 'Nationwide ground stop, 13 Nov 2026',
  short: 'Nov 13 ground stop',
  date: '2026-11-13',
  summary:
    'Two newly installed routers on the FAA\'s telecom network (FTI, run by L3Harris) flooded it with connection attempts, ' +
    'over 1,000 every 4–5 seconds. The network went unstable at 17 of the 22 en route centers and spread into several TRACONs, ' +
    'taking out communications and radar feeds. The FAA stopped all departures nationwide, the second time since 9/11.',
  affected: { centers: 17, of: 22, named: false },
  numbers: [
    ['Aircraft landed safely', 'about 3,500'],
    ['Flights cancelled', '1,900 – 12,462 (sources differ; the FAA cites 12,462)'],
    ['Ground stop', 'over four hours'],
    ['Cyberattack', 'no indication found (FAA, DHS)'],
    ['Root cause', 'not determined yet'],
  ],
  sites: [
    {
      id: 'eld',
      name: 'El Dorado, AR',
      kind: 'Remote site',
      lat: 33.207,
      lon: -92.666,
      precision: 'town',
      what:
        'L3Harris was replacing its router while moving the site from copper to fiber. The FAA was told on 9 Nov; an FAA technician ' +
        'tested and signed off on the swap. Within about eight minutes the new router began flooding the network.',
      router: 'new router (Juniper, as reported), installed 13 Nov',
    },
    {
      id: 'ama',
      name: 'Amarillo, TX',
      kind: 'Radar site',
      lat: 35.222,
      lon: -101.831,
      precision: 'town',
      what: 'Its router had been replaced about three weeks earlier. The FAA says the overload could have started here or at El Dorado.',
      router: 'new router, installed about three weeks earlier',
    },
  ],
  // The steps of the timeline. `state` drives the map: which sites are on,
  // and whether the flood is spreading or the sites are cut off.
  steps: [
    { id: 'before', time: 'late Oct – 13 Nov', title: 'New routers go in', text: 'Amarillo\'s router is replaced about three weeks before. On 9 Nov L3Harris tells the FAA it will replace El Dorado\'s.', state: { sites: ['ama', 'eld'], flood: false, blocked: false } },
    { id: 'swap', time: 'shortly before 15:30', title: 'El Dorado swap signed off', text: 'An FAA technician tests and signs off on the new router at El Dorado. Within about eight minutes it starts sending far too much data into the network.', state: { sites: ['ama', 'eld'], flood: false, blocked: false, focus: 'eld' } },
    { id: 'flood', time: '15:30', title: 'The network goes unstable', text: 'Connection attempts, over 1,000 every 4–5 seconds, spread across FTI. 17 of 22 centers lose stability; several TRACONs follow. Communications and radar feeds drop.', state: { sites: ['ama', 'eld'], flood: true, blocked: false } },
    { id: 'stop', time: '15:36 – 15:54', title: 'Nationwide ground stop', text: 'The FAA halts all departures. Sources give the order as 15:36 or 15:54. L3Harris struggles to find where the trouble is coming from (CBS).', state: { sites: ['ama', 'eld'], flood: true, blocked: false } },
    { id: 'block', time: 'time not reported', title: 'Both sites blocked', text: 'L3Harris blocks traffic from El Dorado and Amarillo, and the network stabilizes.', state: { sites: ['ama', 'eld'], flood: false, blocked: true } },
    { id: 'lift', time: '20:15', title: 'Ground stop lifted', text: 'Traffic moves again. Afterwards the FAA disables the router feature on about 60 similar devices and pauses new Juniper router installs.', state: { sites: ['ama', 'eld'], flood: false, blocked: true } },
  ],
  defaultStep: 2,
  sources: [
    ['FAA: Nationwide Ground Stop Q&A', 'https://www.faa.gov/newsroom/nationwide-ground-stop-questions-and-answers'],
    ['The Hill: Arkansas router identified', 'https://thehill.com/policy/technology/6222677-faa-ground-stop-router/'],
    ['CNBC: engineers replicate the overload', 'https://www.cnbc.com/2026/11/18/faa-ground-stop-router-investigation.html'],
    ['CBS: L3Harris struggled to find the outage', 'https://www.cbsnews.com/news/ground-stop-l3harris-system-outage/'],
    ['CNN: router installations paused', 'https://www.cnn.com/2026/11/17/us/faa-ground-stop-juniper-router-installations'],
    ['CNN: little oversight of the work', 'https://us.cnn.com/2026/11/18/politics/faa-contractor-oversight-ground-stop'],
  ],
};

export const INCIDENTS = [NOV13];
export const INCIDENT_BY_ID = new Map(INCIDENTS.map((i) => [i.id, i]));

/** The step index from a hash value, clamped; the incident's default for junk. */
export function parseStep(incident, v) {
  const n = v === null || v === undefined || v === '' ? NaN : Number(v);
  if (!Number.isInteger(n)) return incident.defaultStep;
  return Math.max(0, Math.min(incident.steps.length - 1, n));
}

/** The hash value for a step: null for the default, so links stay short. */
export const stepParam = (incident, k) => (k === incident.defaultStep ? null : String(k));

/**
 * What the map draws for an incident at a step: the sites (each with its
 * modelled home center), the modelled access lines site -> home, and the
 * flood's reach home -> every other center. Paths are great circles; `globe`
 * lifts them off the Earth.
 */
export function shapeIncident(incident, k, { globe = false } = {}) {
  const step = incident.steps[k];
  const st = step.state;
  const lineAlt = globe ? 6e3 : 0;
  const sites = incident.sites
    .filter((s) => st.sites.includes(s.id))
    .map((s) => ({ ...s, home: nearestCenter(s), focus: st.focus === s.id, blocked: st.blocked }));
  const access = sites.map((s) => ({
    kind: 'access',
    site: s,
    from: s,
    to: s.home,
    km: distanceKm(s, s.home),
    path: greatCircle([s.lon, s.lat], [s.home.lon, s.home.lat], { alt: lineAlt }),
  }));
  const homes = [...new Set(sites.map((s) => s.home))];
  const reach = st.flood
    ? homes.flatMap((h) =>
        CENTERS.filter((c) => c !== h).map((c) => {
          const km = distanceKm(h, c);
          const lift = globe ? Math.min(km * 1000 * 0.08, 400e3) : 0;
          return { kind: 'reach', from: h, to: c, km, path: greatCircle([h.lon, h.lat], [c.lon, c.lat], { alt: lineAlt, lift }) };
        }),
      )
    : [];
  return { step, sites, access, reach, homes, flood: st.flood, blocked: st.blocked };
}

/** [west, south, east, north] around the lower 48, for ctx.flyTo. */
export const CONUS_BBOX = [-125, 24, -66.5, 49.5];
