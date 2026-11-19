// The Incidents app's data: incidents, each made of events (outages that may
// or may not share a cause), each event a timeline of steps that set what the
// map shows. First incident: the 2026 air traffic control (ATC) telecom
// outages, from Minneapolis in August to the nationwide ground stop in
// November. DOM-free, so node's tests import it.
//
// What's measured and what's modelled (apps/README.md: anything modelled says
// so). The facilities' places are public (city- or airport-level here). The
// events' sites, times and counts come from the FAA and press reports, with
// conflicts kept as ranges. The circuits aren't public: which center a remote
// site homes to, the FTI backbone between centers, and the route of a
// TRACON's circuits are modelled, and their tooltips say so.

import { greatCircle } from '../starlink/pops/data.js';

// [id, name, city, lat, lon]: the 20 CONUS en route centers (ARTCCs),
// Anchorage and Honolulu.
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

export const CENTERS = CENTER_ROWS.map(([id, name, city, lat, lon]) => ({ id, name, city, lat, lon, kind: 'center' }));
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

// --- events ---
//
// An event: { id, title, short, date, summary, bbox, points, links, steps,
// defaultStep, numbers, sources }.
//   points: its own places, { id, name, label? (short, for the map), kind, lat, lon,
//     precision?, what?, detail?, labelLeft? }
//     (kind: 'site' | 'tracon' | 'airport'); centers are referred to by id.
//   links: { id, from, to, kind, modelled, label, bend? }. from/to are point
//     or center ids; to '*' fans out to every other center (the flood's reach).
//   steps: { time, title, text, status: { <point|link|center id>: status },
//     centers?: status for every center, focus?: point id }.
//     Points and links not in a step's status aren't drawn at that step.
//     Point and center statuses: 'ok' | 'alert' | 'down' | 'blocked'.
//     Link statuses: 'ok' | 'flood' | 'down'.

export const NOV13 = {
  id: 'nov13',
  title: 'Nationwide ground stop',
  short: 'Two routers flood FTI',
  date: '13 Nov 2026',
  summary:
    'Two newly installed routers on the FAA\'s telecom network (FTI, run by L3Harris) flooded it with connection attempts, ' +
    'over 1,000 every 4–5 seconds. The network went unstable at 17 of the 22 en route centers and spread into several TRACONs, ' +
    'taking out communications and radar feeds. The FAA stopped all departures nationwide, the second time since 9/11.',
  bbox: [-125, 24, -66.5, 49.5],
  points: [
    {
      id: 'eld',
      name: 'El Dorado, AR',
      kind: 'site',
      lat: 33.207,
      lon: -92.666,
      precision: 'town',
      what:
        'Remote site. L3Harris was replacing its router while moving the site from copper to fiber. The FAA was told on 9 Nov; an FAA technician ' +
        'tested and signed off on the swap. Within about eight minutes the new router began flooding the network.',
      detail: 'new router (Juniper, as reported), installed 13 Nov',
    },
    {
      id: 'ama',
      name: 'Amarillo, TX',
      kind: 'site',
      lat: 35.222,
      lon: -101.831,
      precision: 'town',
      what: 'Radar site. Its router had been replaced about three weeks earlier. The FAA says the overload could have started here or at El Dorado.',
      detail: 'new router, installed about three weeks earlier',
    },
  ],
  links: [
    { id: 'eld-home', from: 'eld', to: 'ZME', kind: 'access', modelled: true, label: 'El Dorado → its home center (modelled: the nearest). The real circuit isn\'t public.' },
    { id: 'ama-home', from: 'ama', to: 'ZAB', kind: 'access', modelled: true, label: 'Amarillo → its home center (modelled: the nearest). The real circuit isn\'t public.' },
    { id: 'reach-zme', from: 'ZME', to: '*', kind: 'reach', modelled: true, label: 'Flood reach (modelled). FTI\'s backbone topology isn\'t public; this shows reach, not the path.' },
    { id: 'reach-zab', from: 'ZAB', to: '*', kind: 'reach', modelled: true, label: 'Flood reach (modelled). FTI\'s backbone topology isn\'t public; this shows reach, not the path.' },
  ],
  steps: [
    { time: 'late Oct – 13 Nov', title: 'New routers go in', text: 'Amarillo\'s router is replaced about three weeks before. On 9 Nov L3Harris tells the FAA it will replace El Dorado\'s.', status: { eld: 'ok', ama: 'ok', 'eld-home': 'ok', 'ama-home': 'ok' } },
    { time: 'shortly before 15:30 ET', title: 'El Dorado swap signed off', text: 'An FAA technician tests and signs off on the new router at El Dorado. Within about eight minutes it starts sending far too much data into the network.', status: { eld: 'ok', ama: 'ok', 'eld-home': 'ok', 'ama-home': 'ok' }, focus: 'eld' },
    { time: '15:30 ET', title: 'The network goes unstable', text: 'Connection attempts, over 1,000 every 4–5 seconds, spread across FTI. 17 of 22 centers lose stability (the FAA hasn\'t said which, so all are marked); several TRACONs follow. Communications and radar feeds drop.', status: { eld: 'alert', ama: 'alert', 'eld-home': 'flood', 'ama-home': 'flood', 'reach-zme': 'flood', 'reach-zab': 'flood' }, centers: 'alert' },
    { time: '15:36 – 15:54 ET', title: 'Nationwide ground stop', text: 'The FAA halts all departures. Sources give the order as 15:36 or 15:54. L3Harris struggles to find where the trouble is coming from (CBS).', status: { eld: 'alert', ama: 'alert', 'eld-home': 'flood', 'ama-home': 'flood', 'reach-zme': 'flood', 'reach-zab': 'flood' }, centers: 'alert' },
    { time: 'time not reported', title: 'Both sites blocked', text: 'L3Harris blocks traffic from El Dorado and Amarillo, and the network stabilizes.', status: { eld: 'blocked', ama: 'blocked', 'eld-home': 'down', 'ama-home': 'down' } },
    { time: '20:15 ET', title: 'Ground stop lifted', text: 'Traffic moves again. Afterwards the FAA disables the router feature on about 60 similar devices and pauses new Juniper router installs.', status: { eld: 'blocked', ama: 'blocked', 'eld-home': 'down', 'ama-home': 'down' } },
  ],
  defaultStep: 2,
  numbers: [
    ['Centers hit', '17 of 22 (not named)'],
    ['Aircraft landed safely', 'about 3,500'],
    ['Flights cancelled', '1,900 – 12,462 (sources differ; the FAA cites 12,462)'],
    ['Ground stop', 'over four hours'],
    ['Cyberattack', 'no indication found (FAA, DHS)'],
    ['Root cause', 'not determined yet'],
  ],
  sources: [
    ['FAA: Nationwide Ground Stop Q&A', 'https://www.faa.gov/newsroom/nationwide-ground-stop-questions-and-answers'],
    ['The Hill: Arkansas router identified', 'https://thehill.com/policy/technology/6222677-faa-ground-stop-router/'],
    ['CNBC: engineers replicate the overload', 'https://www.cnbc.com/2026/11/18/faa-ground-stop-router-investigation.html'],
    ['CBS: L3Harris struggled to find the outage', 'https://www.cbsnews.com/news/ground-stop-l3harris-system-outage/'],
    ['CNN: router installations paused', 'https://www.cnn.com/2026/11/17/us/faa-ground-stop-juniper-router-installations'],
    ['CNN: little oversight of the work', 'https://us.cnn.com/2026/11/18/politics/faa-contractor-oversight-ground-stop'],
  ],
};

export const SEP21 = {
  id: 'sep21',
  title: 'Philadelphia TRACON outage',
  short: 'Primary circuit fails, backup already cut',
  date: '21 Sep 2026',
  summary:
    'The primary telecom circuit at Philadelphia TRACON, which has handled the Newark area\'s airspace since July 2024, failed. ' +
    'When it tried to switch over, the backup fiber turned out to have been cut in New Jersey. Ground stops followed at ' +
    'Teterboro, Philadelphia, Newark, JFK and LaGuardia.',
  bbox: [-77.2, 38.9, -72.6, 41.7],
  points: [
    { id: 'pct', label: 'PHL TRACON', name: 'Philadelphia TRACON', kind: 'tracon', lat: 39.872, lon: -75.241, precision: 'airport (PHL)', what: 'The approach control for Philadelphia and, since 28 July 2024, the Newark area\'s airspace (Area C), moved there from New York TRACON.' },
    { id: 'ewr', label: 'EWR', name: 'Newark (EWR)', kind: 'airport', lat: 40.692, lon: -74.169, what: 'Ground stop from about 10:00. About eight hours without arriving commercial flights; more than 600 cancellations.' },
    { id: 'teb', label: 'TEB', name: 'Teterboro (TEB)', kind: 'airport', lat: 40.85, lon: -74.061, what: 'One of the first ground stops.' },
    { id: 'phl', label: 'PHL', name: 'Philadelphia (PHL)', kind: 'airport', lat: 39.88, lon: -75.215, labelLeft: true, what: 'One of the first ground stops, and a second one before traffic resumed in the afternoon.' },
    { id: 'jfk', label: 'JFK', name: 'New York JFK', kind: 'airport', lat: 40.641, lon: -73.778, what: 'Added to the ground stop at about 13:00; it ran past 18:00.' },
    { id: 'lga', label: 'LGA', name: 'LaGuardia (LGA)', kind: 'airport', lat: 40.777, lon: -73.874, what: 'Added to the ground stop at about 13:00; it ran past 18:00.' },
  ],
  links: [
    { id: 'primary', from: 'pct', to: 'ewr', kind: 'primary', modelled: true, bend: 0.12, label: 'Primary circuit (modelled route): the TRACON\'s link toward the Newark area. Its real route isn\'t public.' },
    { id: 'backup', from: 'pct', to: 'ewr', kind: 'backup', modelled: true, bend: -0.12, label: 'Backup fiber (modelled route), cut in New Jersey. Who cut it is disputed: DOT blamed an Amtrak crew; Verizon blamed construction contractors; NJ Transit says one of its crews was digging about 10 ft from the utility markings.' },
  ],
  steps: [
    { time: 'before the failure', title: 'The backup is already cut', text: 'A crew digging in New Jersey cuts the backup fiber. Nobody notices until it is needed. Who cut it is disputed (Amtrak, construction contractors, NJ Transit).', status: { pct: 'ok', ewr: 'ok', 'primary': 'ok', 'backup': 'down' } },
    { time: 'morning ET', title: 'The primary circuit fails', text: 'Philadelphia TRACON\'s primary telecom circuit fails, and switching to the backup doesn\'t work. Ground stops start at Teterboro and Philadelphia.', status: { pct: 'down', ewr: 'ok', teb: 'alert', phl: 'alert', 'primary': 'down', 'backup': 'down' } },
    { time: '≈10:00 ET', title: 'Newark ground stop', text: 'Newark is stopped. It goes about eight hours without arriving commercial flights.', status: { pct: 'down', ewr: 'alert', teb: 'alert', phl: 'alert', 'primary': 'down', 'backup': 'down' }, focus: 'ewr' },
    { time: '≈13:00 ET', title: 'JFK and LaGuardia added', text: 'The ground stop spreads to Kennedy and LaGuardia. Some reports mention knock-on restrictions at Boston.', status: { pct: 'down', ewr: 'alert', teb: 'alert', phl: 'alert', jfk: 'alert', lga: 'alert', 'primary': 'down', 'backup': 'down' } },
    { time: 'afternoon – night', title: 'Traffic resumes', text: 'Philadelphia resumes after a second ground stop; JFK and LaGuardia\'s run past 18:00, and delays go on into the night. Newark cancels more than 600 flights.', status: { pct: 'ok', ewr: 'ok', teb: 'ok', phl: 'ok', jfk: 'ok', lga: 'ok', 'primary': 'ok', 'backup': 'down' } },
  ],
  defaultStep: 1,
  numbers: [
    ['Airports stopped', 'TEB, PHL, EWR, JFK, LGA'],
    ['Newark cancellations', 'more than 600'],
    ['Cause', 'primary circuit failed; backup fiber already cut'],
    ['Who cut the fiber', 'disputed'],
  ],
  sources: [
    ['CNN: operations resume after Northeast meltdown', 'https://www.cnn.com/2026/09/21/us/northeast-airport-delays-equipment-failure'],
    ['AvWeb: telecom failure disrupts Northeast', 'https://avweb.com/aviation-news/telecom-failure-disrupts-ne-air-traffic/'],
    ['KSL: fiber cut by construction crew', 'https://www.ksl.com/article/51626747/fiber-cut-by-construction-crew-leads-to-ground-stop-and-delays-at-several-major-airports'],
    ['AeroCorner: Philadelphia TRACON outage', 'https://aerocorner.com/news/philadelphia-tracon-outage-newark-ground-stop/'],
  ],
};

export const AUG6 = {
  id: 'aug6',
  title: 'Minneapolis Center outage',
  short: 'One center goes ATC Zero',
  date: '6 Aug 2026',
  summary:
    'Minneapolis Center lost its telecommunication and navigation equipment and went "ATC Zero": it could not control traffic at all. ' +
    'Departures were stopped across nine states for about two hours, and airborne flights were rerouted around its airspace. ' +
    'The FAA hasn\'t said what failed.',
  bbox: [-105, 36, -82, 50],
  points: [],
  links: [],
  steps: [
    { time: '≈14:00 CT (15:00 ET)', title: 'ATC Zero', text: 'Telecom and navigation equipment at Minneapolis Center fails, and the center can\'t provide any control.', status: { ZMP: 'down' } },
    { time: 'afternoon', title: 'Ground stops across nine states', text: 'Departures stop across Minnesota, the Dakotas, Wisconsin, Michigan, Iowa, Nebraska, Kansas and Missouri (one report says ten states). Airborne flights are rerouted or diverted outside the region.', status: { ZMP: 'down' } },
    { time: '≈16:00 CT', title: 'Radar and radio restored', text: 'After about two hours, service returns. Descriptions of the cause vary, from a processing fault to a wider Twin Cities telecom failure; none is confirmed.', status: { ZMP: 'ok' } },
  ],
  defaultStep: 0,
  numbers: [
    ['Duration', 'about two hours'],
    ['Region', 'nine states (one report: ten), about 330,000 square miles'],
    ['Cause', 'not disclosed'],
  ],
  sources: [
    ['AeroCorner: Minneapolis ARTCC outage', 'https://aerocorner.com/news/minneapolis-artcc-atc-zero-outage/'],
    ['Cyviation: one facility, two hours, nine states', 'https://cyviation.substack.com/p/one-facility-two-hours-nine-states'],
    ['Destination: outage halts Midwest flights', 'https://www.destination.com/news/minneapolis-air-traffic-control-outage-halts-midwest-flights'],
  ],
};

export const ATC_2026 = {
  id: 'atc2026',
  title: 'ATC Nationwide ground stop',
  summary:
    'On 13 November 2026 a failure on the FAA\'s air traffic control (ATC) telecom network stopped every departure in the US. ' +
    'It came after two regional outages that year, at Minneapolis Center in August and Philadelphia TRACON in September.',
  linked:
    'Whether these are one incident isn\'t established. All three hit the same network: FTI, the FAA\'s leased telecom network, ' +
    'run by L3Harris and partway through moving from copper to fiber. The reported causes differ: an unexplained equipment failure, ' +
    'a failed circuit with its backup already cut, and two new routers flooding the network.',
  events: [NOV13, SEP21, AUG6],
  defaultEvent: 'nov13',
};

export const INCIDENTS = [ATC_2026];

/** The events in date order (they're listed newest first). */
export const chronological = (incident) => [...incident.events].reverse();

/** An event by id, or the incident's default. */
export const eventById = (incident, id) => incident.events.find((e) => e.id === id) ?? incident.events.find((e) => e.id === incident.defaultEvent);

/** The step index from a hash value, clamped; the event's default for junk. */
export function parseStep(event, v) {
  const n = v === null || v === undefined || v === '' ? NaN : Number(v);
  if (!Number.isInteger(n)) return event.defaultStep;
  return Math.max(0, Math.min(event.steps.length - 1, n));
}

/** The hash value for a step: null for the default, so links stay short. */
export const stepParam = (event, k) => (k === event.defaultStep ? null : String(k));

// A path from a to b: a great circle, or bent sideways by `bend` (a fraction
// of its length) so two links between the same places stay apart.
function linkPath(a, b, { bend = 0, alt = 0, lift = 0 }) {
  if (!bend) return greatCircle([a.lon, a.lat], [b.lon, b.lat], { alt, lift });
  const dx = b.lon - a.lon, dy = b.lat - a.lat;
  const n = 16, out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, s = bend * 4 * t * (1 - t);
    out.push([a.lon + dx * t - dy * s, a.lat + dy * t + dx * s, alt]);
  }
  return out;
}

/**
 * What the map draws for an event at a step: every center with its status,
 * the event's points and links that the step shows, each with its status.
 * `globe` lifts paths off the Earth.
 */
export function shapeEvent(event, k, { globe = false } = {}) {
  const step = event.steps[k];
  const status = step.status ?? {};
  const own = new Map(event.points.map((p) => [p.id, p]));
  const place = (id) => own.get(id) ?? CENTER_BY_ID.get(id) ?? null;
  const centers = CENTERS.map((c) => ({ ...c, status: status[c.id] ?? step.centers ?? 'ok' }));
  const points = event.points.filter((p) => status[p.id]).map((p) => ({ ...p, status: status[p.id], focus: step.focus === p.id }));
  const lineAlt = globe ? 6e3 : 0;
  const links = [];
  for (const l of event.links) {
    const st = status[l.id];
    if (!st) continue;
    const from = place(l.from);
    const tos = l.to === '*' ? CENTERS.filter((c) => c.id !== l.from) : [place(l.to)];
    for (const to of tos) {
      if (!from || !to) continue;
      const km = distanceKm(from, to);
      const lift = globe && l.kind === 'reach' ? Math.min(km * 1000 * 0.08, 400e3) : 0;
      links.push({ ...l, status: st, from, to, km, path: linkPath(from, to, { bend: l.bend, alt: lineAlt, lift }) });
    }
  }
  return { step, centers, points, links };
}
