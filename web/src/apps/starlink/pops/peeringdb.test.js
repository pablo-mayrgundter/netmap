import test from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_KEY, cityKey, facilitiesToFetch, fetchPeering, parsePeering, placeAtPops, portsLabel, speedLabel } from './peeringdb.js';

// Trimmed from PeeringDB's answers for AS14593 (November 2026), with the
// fields fetchPeering asks for.
const NETIXLAN = [
  { ix_id: 1, name: 'Equinix Ashburn', speed: 400000, ipaddr4: '206.126.236.1', ipaddr6: '2001:504:0:2::1', is_rs_peer: false, operational: true },
  { ix_id: 1, name: 'Equinix Ashburn', speed: 400000, ipaddr4: '206.126.236.2', ipaddr6: null, is_rs_peer: true, operational: true },
  { ix_id: 249, name: 'KCIX', speed: 200000, ipaddr4: '206.51.7.7', ipaddr6: '2001:504:1b:1::7', is_rs_peer: true, operational: true },
  { ix_id: 31, name: 'DE-CIX Frankfurt', speed: 100000, ipaddr4: '80.81.192.1', ipaddr6: null, is_rs_peer: false, operational: true },
  { ix_id: 31, name: 'DE-CIX Frankfurt', speed: 10000, ipaddr4: null, ipaddr6: null, is_rs_peer: false, operational: true },
  { ix_id: 64, name: 'NL-ix', speed: 1000, ipaddr4: null, ipaddr6: null, is_rs_peer: false, operational: true },
  { ix_id: 99, name: 'Down IX', speed: 10000, ipaddr4: null, ipaddr6: null, is_rs_peer: false, operational: false },
];
const NETFAC = [
  { fac_id: 1, name: 'Equinix DC1-DC15,DC21-DC22 - Ashburn', city: 'Ashburn', country: 'US' },
  { fac_id: 6, name: 'Equinix SV1/SV5/SV10 - Silicon Valley, San Jose', city: 'San Jose', country: 'US' },
  { fac_id: 7, name: 'Equinix DC2', city: 'Ashburn', country: 'US' },
];
const IX = [
  { id: 1, name: 'Equinix Ashburn', name_long: 'Equinix Internet Exchange Ashburn', city: 'Ashburn', country: 'US', region_continent: 'North America', website: 'https://ix.equinix.com' },
  { id: 249, name: 'KCIX', name_long: 'Kansas City Internet Exchange', city: 'Kansas City', country: 'US', region_continent: 'North America', website: '' },
  { id: 31, name: 'DE-CIX Frankfurt', name_long: '', city: 'Frankfurt', country: 'DE', region_continent: 'Europe', website: '' },
  // spans cities: placed in the first one it names, not at the mean of them all
  { id: 64, name: 'NL-ix', name_long: '', city: 'Amsterdam, Rotterdam, Frankfurt', country: 'NL', region_continent: 'Europe', website: '' },
];
const IXFAC = [
  { ix_id: 1, fac_id: 1, city: 'Ashburn', country: 'US' }, { ix_id: 1, fac_id: 7, city: 'Ashburn', country: 'US' }, { ix_id: 1, fac_id: 710, city: 'Reston', country: 'US' },
  { ix_id: 249, fac_id: 300, city: 'Kansas City', country: 'US' }, { ix_id: 249, fac_id: 120, city: 'Kansas City', country: 'US' },
  { ix_id: 31, fac_id: 55, city: 'Frankfurt', country: 'DE' },
  { ix_id: 64, fac_id: 6, city: 'San Jose', country: 'US' }, { ix_id: 64, fac_id: 18, city: 'Frankfurt', country: 'DE' }, { ix_id: 64, fac_id: 200, city: 'Amsterdam', country: 'NL' },
];
const FAC = [
  { id: 1, name: 'Equinix DC1-DC15,DC21-DC22 - Ashburn', org_name: 'Equinix, Inc.', city: 'Ashburn', country: 'US', latitude: 39.0, longitude: -77.4 },
  { id: 6, name: 'Equinix SV1/SV5/SV10 - Silicon Valley, San Jose', org_name: 'Equinix, Inc.', city: 'San Jose', country: 'US', latitude: 37.24, longitude: -121.78 },
  { id: 7, name: 'Equinix DC2', org_name: 'Equinix, Inc.', city: 'Ashburn', country: 'US', latitude: 39.2, longitude: -77.6 },
  { id: 120, name: '1102 Grand', org_name: 'Netrality', city: 'Kansas City', country: 'US', latitude: 39.1, longitude: -94.58 },
  // fac 55 (Frankfurt) has no coordinates
  { id: 55, name: 'Interxion FRA1', org_name: 'Interxion', city: 'Frankfurt', country: 'DE', latitude: null, longitude: null },
  { id: 200, name: 'Equinix AM7', org_name: 'Equinix, Inc.', city: 'Amsterdam', country: 'NL', latitude: 52.3, longitude: 4.94 },
];

test('facilitiesToFetch: Starlink\'s own, and one in its city for each IX that shares none there', () => {
  // KCIX: 120 and 300 in Kansas City; DE-CIX: 55; NL-ix: 200 in Amsterdam (it shares 6, in San Jose)
  assert.deepEqual(facilitiesToFetch(NETFAC, IXFAC, IX), [1, 6, 7, 55, 120, 200, 300]);
  // at most three in its city, Starlink's first (its one there may have no coordinates)
  const many = [10, 11, 12, 13].map((fac_id) => ({ ix_id: 5, fac_id, city: 'A' }));
  assert.deepEqual(facilitiesToFetch([], many, [{ id: 5, city: 'A' }]), [10, 11, 12]);
  assert.deepEqual(facilitiesToFetch([{ fac_id: 13 }], many, [{ id: 5, city: 'A' }]), [10, 11, 13]);
  // an IX whose facilities are all elsewhere: its lowest-numbered one, unless it shares one
  assert.deepEqual(facilitiesToFetch([], [{ ix_id: 5, fac_id: 9, city: 'B' }, { ix_id: 5, fac_id: 3, city: 'C' }], [{ id: 5, city: 'A' }]), [3]);
  assert.deepEqual(facilitiesToFetch([{ fac_id: 9 }], [{ ix_id: 5, fac_id: 9, city: 'B' }, { ix_id: 5, fac_id: 3, city: 'C' }], [{ id: 5, city: 'A' }]), [9]);
  assert.deepEqual(facilitiesToFetch([], [], []), []);
});

test('cityKey: case, accents and the first of a list', () => {
  assert.equal(cityKey('São Paulo/SP'), 'sao paulo sp');
  assert.equal(cityKey('Amsterdam, Rotterdam'), 'amsterdam');
  assert.equal(cityKey(null), '');
});

test('parsePeering: IXes placed at shared facilities, ports summed, down ports dropped', () => {
  const p = parsePeering({ netixlan: NETIXLAN, netfac: NETFAC, ix: IX, ixfac: IXFAC, fac: FAC });
  assert.deepEqual(p.ixes.map((x) => x.id), [1, 249, 31, 64]); // fastest first; 99 isn't operational
  const [eqix, kcix, decix] = p.ixes;
  assert.equal(eqix.ports, 2);
  assert.equal(eqix.speed, 800000);
  assert.deepEqual(eqix.speeds, [400000, 400000]);
  assert.equal(eqix.rs, true);
  assert.deepEqual(eqix.facilities, [1, 7]);
  assert.equal(eqix.located, 'shared');
  assert.ok(Math.abs(eqix.lat - 39.1) < 1e-9 && Math.abs(eqix.lon - -77.5) < 1e-9); // the mean of fac 1 and 7
  assert.deepEqual(eqix.ipv4, ['206.126.236.1', '206.126.236.2']);
  assert.deepEqual(eqix.ipv6, ['2001:504:0:2::1']);
  assert.equal(eqix.continent, 'North America');
  // KCIX shares no facility: placed at its lowest-numbered one with coordinates
  assert.equal(kcix.located, 'ix');
  assert.equal(kcix.lat, 39.1);
  assert.deepEqual(kcix.facilities, []);
  // DE-CIX: its only facility has no coordinates
  assert.equal(decix.located, null);
  assert.equal(decix.lon, null);
  assert.deepEqual(decix.speeds, [100000, 10000]);
  // NL-ix: at its Amsterdam facility, not at the San Jose one it shares with Starlink
  const nlix = p.ixes[3];
  assert.deepEqual([nlix.lon, nlix.lat, nlix.located], [4.94, 52.3, 'ix']);
  assert.deepEqual(nlix.facilities, [6]);

  assert.deepEqual(p.facilities.map((f) => f.id), [1, 7, 6]); // by country, city, name
  assert.deepEqual(p.facilities[0].ixes, [1]);
  assert.deepEqual(p.facilities[2].ixes, [64]); // San Jose
  assert.equal(p.facilities[0].org, 'Equinix, Inc.');
  assert.equal(p.facilities[2].lat, 37.24);
  assert.deepEqual(p.totals, { ixes: 4, ports: 6, speed: 1111000, facilities: 3 });
});

test('parsePeering: tolerates missing records', () => {
  const p = parsePeering({ netixlan: [{ ix_id: 5, name: 'Lonely IX', speed: 1000, operational: true }], netfac: [{ fac_id: 9 }] });
  assert.equal(p.ixes[0].name, 'Lonely IX');
  assert.equal(p.ixes[0].lon, null);
  assert.equal(p.facilities[0].name, 'facility 9');
  assert.deepEqual(parsePeering({}).totals, { ixes: 0, ports: 0, speed: 0, facilities: 0 });
});

test('placeAtPops: an unplaced IX goes to a Starlink PoP in its city', () => {
  const p = parsePeering({ netixlan: NETIXLAN, netfac: NETFAC, ix: IX, ixfac: IXFAC, fac: FAC });
  const pops = [
    { code: 'frntdeu1', city: 'Frankfurt am Main', country: 'DE', lon: 8.57, lat: 50.03 }, // not the same city name
    { code: 'frntdeu9', city: 'Frankfurt', country: 'US', lon: 0, lat: 0 }, // nor country
  ];
  assert.equal(placeAtPops(p, pops).pops_placed, 0);
  const q = placeAtPops(p, [...pops, { code: 'frxdeu1', city: 'Frankfurt', country: 'DE', lon: 8.57, lat: 50.03 }]);
  assert.equal(q.pops_placed, 1);
  const decix = q.ixes.find((x) => x.id === 31);
  assert.deepEqual([decix.lon, decix.lat, decix.located], [8.57, 50.03, 'pop']);
  assert.equal(q.ixes.find((x) => x.id === 1), p.ixes.find((x) => x.id === 1)); // placed ones untouched
  assert.equal(p.ixes.find((x) => x.id === 31).lon, null); // the input isn't changed
});

test('speedLabel and portsLabel', () => {
  assert.equal(speedLabel(100000), '100G');
  assert.equal(speedLabel(1200000), '1.2T');
  assert.equal(speedLabel(2500), '2.5G');
  assert.equal(speedLabel(500), '500M');
  assert.equal(speedLabel(0), '—');
  assert.equal(portsLabel([400000, 400000]), '2 × 400G');
  assert.equal(portsLabel([100000]), '100G');
  assert.equal(portsLabel([100000, 10000]), '100G + 10G');
  assert.equal(portsLabel([]), '—');
});

function fakeFetch(fail = null) {
  const calls = [];
  const tables = { netixlan: NETIXLAN, netfac: NETFAC, ix: IX, ixfac: IXFAC, fac: FAC };
  const fn = async (url) => {
    calls.push(url);
    const name = new URL(url).pathname.split('/').pop();
    if (fail === name) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: tables[name] }) };
  };
  return { fn, calls };
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m };
}

test('fetchPeering: five requests, the right filters, cached for the session', async () => {
  const { fn, calls } = fakeFetch();
  const storage = memoryStorage();
  const now = () => new Date('2026-11-07T01:00:00Z');
  const p = await fetchPeering({ fetch: fn, storage, now });
  assert.equal(calls.length, 5);
  assert.ok(calls[0].startsWith('https://www.peeringdb.com/api/netixlan?asn=14593&fields='));
  assert.ok(calls[1].includes('/netfac?net__asn=14593&')); // local_asn= isn't a filter
  assert.ok(calls.some((u) => u.includes('/ix?id__in=1,31,64,249&')));
  assert.ok(calls.some((u) => u.includes('/ixfac?ix_id__in=1,31,64,249&fields=ix_id,fac_id,city,country')));
  assert.ok(calls.at(-1).includes('/fac?id__in=1,6,7,55,120,200,300&'));
  assert.equal(p.cached, false);
  assert.equal(p.fetched_at, '2026-11-07T01:00:00.000Z');
  assert.equal(p.ixes.length, 4);
  assert.ok(storage.m.has(CACHE_KEY));

  const again = await fetchPeering({ fetch: fn, storage, now });
  assert.equal(calls.length, 5); // from the cache
  assert.equal(again.cached, true);
  assert.deepEqual(again.ixes, p.ixes);
});

test('fetchPeering: an HTTP error throws; a bad or blocked cache is ignored', async () => {
  const { fn } = fakeFetch('ix');
  await assert.rejects(fetchPeering({ fetch: fn }), /PeeringDB ix: HTTP 429/);
  const bad = { getItem: () => '{not json', setItem: () => {} };
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  for (const storage of [bad, blocked]) assert.equal((await fetchPeering({ fetch: fakeFetch().fn, storage })).cached, false);
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(fetchPeering({ fetch: offline }), /Failed to fetch/);
});
