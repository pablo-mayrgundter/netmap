// Starlink's IXes and facilities from PeeringDB, fetched live from the
// browser (PeeringDB's API answers CORS for any origin) and kept for the
// session. DOM-free: fetch and storage are passed in, so node's tests drive it
// with fakes.
//
// Five anonymous requests, in three rounds:
//   netixlan?asn=   its ports at IXes (speed in Mbps, addresses, route server)
//   netfac?net__asn= the facilities it's in (`local_asn=` is not a filter:
//                   it returns every netfac row)
//   ix?id__in=      those IXes' names and cities
//   ixfac?ix_id__in= the facilities each IX is in
//   fac?id__in=     coordinates: Starlink's facilities, and a few of each
//                   IX's in its city (some facilities have none)
// An IX is placed at its facilities in its own city (PeeringDB's `city`),
// Starlink's first; then in its country; then anywhere. Many IXes span
// cities (NL-ix lists twelve), so a mean over all of them would be nowhere.

export const PDB_API = 'https://www.peeringdb.com/api';
export const PDB_WEB = 'https://www.peeringdb.com';
export const CACHE_KEY = 'netmap.starlink.peeringdb.v2';

const FIELDS = {
  netixlan: 'ix_id,name,speed,ipaddr4,ipaddr6,is_rs_peer,operational',
  netfac: 'fac_id,name,city,country',
  ix: 'id,name,name_long,city,country,region_continent,website',
  ixfac: 'ix_id,fac_id,city,country',
  fac: 'id,name,org_name,city,country,latitude,longitude',
};

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const ids = (rows, key) => [...new Set(rows.map((r) => r[key]).filter((x) => Number.isInteger(x)))].sort((a, b) => a - b);

/** A city name for matching: lower case, no accents, the part before a comma. */
export const cityKey = (s) =>
  String(s ?? '')
    .split(',')[0]
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const PER_IX = 3;

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) (m.get(r[key]) ?? m.set(r[key], []).get(r[key])).push(r);
  return m;
};

/**
 * The facility ids whose coordinates are needed: every facility Starlink is
 * in, plus, for each IX (`ix` records), its first PER_IX facilities in its
 * city (by ixfac's city; Starlink's first, then the lowest-numbered: some
 * have no coordinates), else its lowest-numbered one when it shares none.
 */
export function facilitiesToFetch(netfac, ixfac, ix) {
  const mine = new Set(ids(netfac, 'fac_id'));
  const want = new Set(mine);
  const byIx = groupBy(ixfac.filter((r) => Number.isInteger(r.fac_id)), 'ix_id');
  for (const x of ix) {
    const facs = [...(byIx.get(x.id) ?? [])].sort((a, b) => a.fac_id - b.fac_id);
    const city = cityKey(x.city);
    const local = facs.filter((r) => city && cityKey(r.city) === city).sort((a, b) => mine.has(b.fac_id) - mine.has(a.fac_id));
    const pick = local.length ? local.slice(0, PER_IX) : facs.some((r) => mine.has(r.fac_id)) ? [] : facs.slice(0, 1);
    for (const r of pick) want.add(r.fac_id);
  }
  return [...want].sort((a, b) => a - b);
}

/**
 * PeeringDB's rows -> what the app shows:
 *
 * * `ixes`: [{ id, name, name_long, city, country, continent, website, lon,
 *   lat, located: 'shared' (at Starlink's facilities) | 'ix' (at the IX's
 *   own) | null (placeAtPops can make it 'pop'), ports, speed (Mbps, summed), speeds: [Mbps], rs, ipv4: [],
 *   ipv6: [], facilities: [fac id] }], the fastest first. `facilities` are
 *   the IX's facilities Starlink is in too.
 * * `facilities`: [{ id, name, org, city, country, lon, lat, ixes: [ix id] }]
 *   Starlink's, by country and city.
 * * `totals`: { ixes, ports, speed, facilities }.
 */
export function parsePeering({ netixlan = [], netfac = [], ix = [], ixfac = [], fac = [] }) {
  const facById = new Map(fac.map((f) => [f.id, f]));
  const mine = new Set(ids(netfac, 'fac_id'));
  const ixFacs = new Map();
  for (const r of ixfac) (ixFacs.get(r.ix_id) ?? ixFacs.set(r.ix_id, []).get(r.ix_id)).push(r.fac_id);
  const ixById = new Map(ix.map((x) => [x.id, x]));
  const ports = new Map();
  for (const p of netixlan) {
    if (p.operational === false || !Number.isInteger(p.ix_id)) continue;
    if (!ports.has(p.ix_id)) ports.set(p.ix_id, []);
    ports.get(p.ix_id).push(p);
  }
  const coords = (facIds) => facIds.map((id) => facById.get(id)).filter((f) => num(f?.latitude) !== null && num(f?.longitude) !== null);
  const mean = (fs) => [fs.reduce((s, f) => s + f.longitude, 0) / fs.length, fs.reduce((s, f) => s + f.latitude, 0) / fs.length];
  // Where to put an IX: the mean of the first non-empty group of its placed
  // facilities, from Starlink's in its city to any of its own.
  function place(rec, facs) {
    const all = coords(facs);
    const city = cityKey(rec.city);
    const inCity = (f) => city && cityKey(f.city) === city;
    const inCountry = (f) => rec.country && f.country === rec.country;
    const groups = [
      [(f) => mine.has(f.id) && inCity(f), 'shared'],
      [inCity, 'ix'],
      [(f) => mine.has(f.id) && inCountry(f), 'shared'],
      [inCountry, 'ix'],
      [(f) => mine.has(f.id), 'shared'],
      [() => true, 'ix'],
    ];
    for (const [ok, how] of groups) {
      const fs = all.filter(ok);
      if (fs.length) return { at: mean(fs), located: how };
    }
    return { at: null, located: null };
  }

  const ixes = [...ports].map(([id, list]) => {
    const rec = ixById.get(id) ?? {};
    const facs = (ixFacs.get(id) ?? []).sort((a, b) => a - b);
    const shared = facs.filter((f) => mine.has(f));
    const { at, located } = place(rec, facs);
    const speeds = list.map((p) => num(p.speed) ?? 0).sort((a, b) => b - a);
    return {
      id,
      name: rec.name || list[0].name || `IX ${id}`,
      name_long: rec.name_long || '',
      city: rec.city || '',
      country: rec.country || '',
      continent: rec.region_continent || '',
      website: rec.website || '',
      lon: at ? at[0] : null,
      lat: at ? at[1] : null,
      located,
      ports: list.length,
      speed: speeds.reduce((s, x) => s + x, 0),
      speeds,
      rs: list.some((p) => p.is_rs_peer),
      ipv4: list.map((p) => p.ipaddr4).filter(Boolean),
      ipv6: list.map((p) => p.ipaddr6).filter(Boolean),
      facilities: shared,
    };
  });
  ixes.sort((a, b) => b.speed - a.speed || a.name.localeCompare(b.name));

  const ixesAt = new Map();
  for (const x of ixes) for (const f of x.facilities) (ixesAt.get(f) ?? ixesAt.set(f, []).get(f)).push(x.id);
  const facilities = netfac
    .filter((r) => Number.isInteger(r.fac_id))
    .map((r) => {
      const f = facById.get(r.fac_id) ?? {};
      return {
        id: r.fac_id,
        name: f.name || r.name || `facility ${r.fac_id}`,
        org: f.org_name || '',
        city: f.city || r.city || '',
        country: f.country || r.country || '',
        lon: num(f.longitude),
        lat: num(f.latitude),
        ixes: ixesAt.get(r.fac_id) ?? [],
      };
    })
    .filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i)
    .sort((a, b) => a.country.localeCompare(b.country) || a.city.localeCompare(b.city) || a.name.localeCompare(b.name));

  return {
    ixes,
    facilities,
    totals: { ixes: ixes.length, ports: ixes.reduce((s, x) => s + x.ports, 0), speed: ixes.reduce((s, x) => s + x.speed, 0), facilities: facilities.length },
  };
}

/**
 * The IXes PeeringDB has no coordinates for, put at a Starlink PoP in the
 * same city and country (`located: 'pop'`), when there's one. `pops` are
 * pops.json records. Returns a new peering record; `pops_placed` counts them.
 */
export function placeAtPops(peering, pops) {
  const at = new Map();
  for (const p of pops) if (Number.isFinite(p.lon) && Number.isFinite(p.lat) && p.city) at.set(`${cityKey(p.city)}|${p.country}`, p);
  let n = 0;
  const ixes = peering.ixes.map((x) => {
    if (x.lon !== null) return x;
    const p = at.get(`${cityKey(x.city)}|${x.country}`);
    if (!p) return x;
    n++;
    return { ...x, lon: p.lon, lat: p.lat, located: 'pop' };
  });
  return { ...peering, ixes, pops_placed: n };
}

/** Mbps -> "100G", "10G", "500M"; 1.2 Tbps -> "1.2T". */
export function speedLabel(mbps) {
  if (!(mbps > 0)) return '—';
  if (mbps >= 1e6) return `${+(mbps / 1e6).toFixed(1)}T`;
  if (mbps >= 1000) return `${+(mbps / 1000).toFixed(1)}G`;
  return `${mbps}M`;
}

/** An IX's ports: "2 × 100G" when they're alike, else "100G + 10G". */
export function portsLabel(speeds) {
  if (!speeds?.length) return '—';
  if (speeds.every((s) => s === speeds[0])) return speeds.length > 1 ? `${speeds.length} × ${speedLabel(speeds[0])}` : speedLabel(speeds[0]);
  return speeds.map(speedLabel).join(' + ');
}

function readCache(storage, asn) {
  try {
    const v = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null');
    return v && v.asn === asn && Array.isArray(v.ixes) ? v : null;
  } catch {
    return null;
  }
}

function writeCache(storage, value) {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    /* full or blocked: the next open fetches again */
  }
}

/**
 * Starlink's peering from PeeringDB: parsePeering's result plus `asn`,
 * `fetched_at` (ISO) and `cached` (it came from `storage`, this session's).
 * Throws on a network or HTTP error (and on abort); the caller says it's
 * offline.
 */
export async function fetchPeering({ asn = 14593, fetch = globalThis.fetch, signal, storage = null, now = () => new Date() } = {}) {
  const hit = readCache(storage, asn);
  if (hit) return { ...hit, cached: true };
  const get = async (path, fields) => {
    const res = await fetch(`${PDB_API}/${path}&fields=${fields}`, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`PeeringDB ${path.split('?')[0]}: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.data)) throw new Error(`PeeringDB ${path.split('?')[0]}: no data`);
    return body.data;
  };
  const [netixlan, netfac] = await Promise.all([get(`netixlan?asn=${asn}`, FIELDS.netixlan), get(`netfac?net__asn=${asn}`, FIELDS.netfac)]);
  const ixIds = ids(netixlan.filter((p) => p.operational !== false), 'ix_id');
  const [ix, ixfac] = ixIds.length
    ? await Promise.all([get(`ix?id__in=${ixIds.join(',')}`, FIELDS.ix), get(`ixfac?ix_id__in=${ixIds.join(',')}`, FIELDS.ixfac)])
    : [[], []];
  const facIds = facilitiesToFetch(netfac, ixfac, ix);
  const fac = facIds.length ? await get(`fac?id__in=${facIds.join(',')}`, FIELDS.fac) : [];
  const out = { asn, fetched_at: now().toISOString(), ...parsePeering({ netixlan, netfac, ix, ixfac, fac }) };
  writeCache(storage, out);
  return { ...out, cached: false };
}
