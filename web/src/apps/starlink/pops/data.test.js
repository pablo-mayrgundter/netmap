import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsAround, DEFAULT_LAYERS, farthest, greatCircle, haversineKm, layersParam, markerRadius, parseLayers, popColour, popDetail, POP_RADIUS,
  popWeight, regionLabel, servedBy, shapeStarlink,
} from './data.js';

// A slice of pops.json and regions.json (the README's schema), with real places.
const POPS = [
  { code: 'lsancax1', iata: 'lax', airport: 'LAX', located: 'iata', name: 'Los Angeles International Airport', city: 'Los Angeles', country: 'US', lat: 33.9425, lon: -118.4081, v4_prefixes: 65, v6_prefixes: 10, v4_addresses: 16640, regions: [{ id: 0, country: 'US', region: 'US-CA', city: 'Los Angeles', prefixes: 60 }, { id: 3, country: 'MX', region: '', city: 'Tijuana', prefixes: 15 }] },
  { code: 'nrbiken1', iata: 'nbo', airport: 'NBO', located: 'iata', name: 'Jomo Kenyatta International Airport', city: 'Nairobi', country: 'KE', lat: -1.3192, lon: 36.9278, v4_prefixes: 106, v6_prefixes: 33, v4_addresses: 26880, regions: [{ id: 1, country: 'KE', region: '', city: 'Nairobi', prefixes: 100 }, { id: 2, country: 'YE', region: '', city: "Sana'a", prefixes: 6 }] },
  { code: 'staging2', iata: 'staging2', airport: null, located: null, name: null, city: null, country: null, lat: null, lon: null, v4_prefixes: 2, v6_prefixes: 0, v4_addresses: 0, regions: [] },
  { code: 'acklnzl1', iata: 'akl', airport: 'AKL', located: 'iata', name: 'Auckland International Airport', city: 'Auckland', country: 'NZ', lat: -37.012, lon: 174.7863, v4_prefixes: 22, v6_prefixes: 5, v4_addresses: 5632, regions: [{ id: 4, country: 'PN', region: '', city: 'Adamstown', prefixes: 3 }] },
];
const R = (id, country, country_name, city, lat, lon, pops, extra = {}) => ({ id, country, country_name, region: '', region_name: '', city, lat, lon, precision: 'city', v4_prefixes: 1, v6_prefixes: 0, v4_addresses: 256, pops, no_pop_prefixes: 0, ...extra });
const REGIONS = [
  R(0, 'US', 'United States', 'Los Angeles', 34.05, -118.25, [{ pop: 0, code: 'lsancax1', prefixes: 60 }], { v4_addresses: 15000 }),
  R(1, 'KE', 'Kenya', 'Nairobi', -1.29, 36.82, [{ pop: 1, code: 'nrbiken1', prefixes: 100 }], { v4_addresses: 25000 }),
  R(2, 'YE', 'Yemen', "Sana'a", 15.35, 44.21, [{ pop: 1, code: 'nrbiken1', prefixes: 6 }], { precision: 'country' }),
  R(3, 'MX', 'Mexico', 'Tijuana', 32.53, -117.04, [{ pop: 0, code: 'lsancax1', prefixes: 15 }]),
  R(4, 'PN', 'Pitcairn', 'Adamstown', null, null, [{ pop: 3, code: 'acklnzl1', prefixes: 3 }], { precision: null }),
  R(5, 'AQ', 'Antarctica', 'McMurdo', -77.85, 166.67, [], { no_pop_prefixes: 1 }),
];

test('haversineKm: known distances', () => {
  assert.equal(haversineKm(0, 0, 0, 0), 0);
  // LAX to Nairobi is about 15,500 km; a degree of the equator about 111.2 km.
  assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 111.19) < 0.1);
  const d = haversineKm(-118.4081, 33.9425, 36.9278, -1.3192);
  assert.ok(d > 15400 && d < 15600, `${d}`);
  // Symmetric, and the short way across the antimeridian.
  assert.ok(Math.abs(haversineKm(179, 0, -179, 0) - 222.4) < 0.5);
});

test('markerRadius: area follows the value, clamped to the range', () => {
  assert.equal(markerRadius(0, 100), POP_RADIUS.min);
  assert.equal(markerRadius(100, 100), POP_RADIUS.max);
  assert.equal(markerRadius(400, 100), POP_RADIUS.max);
  assert.equal(markerRadius(5, 0), POP_RADIUS.min);
  const q = markerRadius(25, 100); // a quarter of the value: half the extra radius
  assert.ok(Math.abs(q - (POP_RADIUS.min + (POP_RADIUS.max - POP_RADIUS.min) / 2)) < 1e-9);
});

test('popWeight: IPv4 addresses, else prefixes', () => {
  assert.equal(popWeight(POPS[0]), 16640);
  assert.equal(popWeight(POPS[2]), 2);
});

test('popColour: stable, distinct, valid RGB', () => {
  const cs = Array.from({ length: 66 }, (_, i) => popColour(i));
  for (const c of cs) assert.ok(c.length === 3 && c.every((x) => Number.isInteger(x) && x >= 0 && x <= 255));
  assert.deepEqual(popColour(5), popColour(5));
  for (let i = 1; i < cs.length; i++) assert.notDeepEqual(cs[i], cs[i - 1]);
});

test('shapeStarlink: sizes, serving PoPs, distances, unplaced things', () => {
  const s = shapeStarlink(POPS, REGIONS);
  assert.equal(s.pops.length, 4);
  const [lax, nbo, staging, akl] = s.pops;
  assert.equal(nbo.radius, POP_RADIUS.max); // the most addresses
  assert.ok(lax.radius < nbo.radius && akl.radius < lax.radius && akl.radius > POP_RADIUS.min);
  assert.equal(staging.placed, false);
  assert.equal(nbo.prefixes, 139);
  assert.equal(s.byCode.get('nrbiken1'), nbo);

  const yemen = s.regions[2];
  assert.equal(yemen.pop, 1);
  assert.deepEqual(yemen.colour, nbo.colour);
  assert.ok(yemen.km > 1950 && yemen.km < 2100, `${yemen.km}`); // Sana'a -> Nairobi, about 2,000 km
  assert.ok(s.regions[0].km < 30);
  assert.equal(s.regions[4].km, null); // Pitcairn: not placed
  assert.equal(s.regions[4].placed, false);
  assert.equal(s.regions[5].pop, -1); // no PoP
  assert.equal(s.regions[5].km, null);

  // One assignment per placed (region, PoP), farthest first; Pitcairn and McMurdo have none.
  assert.equal(s.assignments.length, 4);
  assert.deepEqual(s.assignments.map((a) => a.region), [2, 3, 0, 1]);
  for (let i = 1; i < s.assignments.length; i++) assert.ok(s.assignments[i - 1].km >= s.assignments[i].km);
});

test('shapeStarlink: a region served by two PoPs is coloured by the one with most prefixes', () => {
  const regions = [R(0, 'MX', 'Mexico', 'Tijuana', 32.53, -117.04, [{ pop: 1, code: 'nrbiken1', prefixes: 2 }, { pop: 0, code: 'lsancax1', prefixes: 5 }])];
  const s = shapeStarlink(POPS, regions);
  assert.equal(s.regions[0].pop, 0);
  assert.equal(s.assignments.length, 2);
  assert.equal(s.pops[s.assignments[0].pop].code, 'nrbiken1'); // the far one first
});

test('farthest: the top n, with their records', () => {
  const s = shapeStarlink(POPS, REGIONS);
  const f = farthest(s, { n: 2 });
  assert.equal(f.length, 2);
  assert.equal(f[0].regionRec.country_name, 'Yemen');
  assert.equal(f[0].popRec.code, 'nrbiken1');
  assert.equal(farthest(s, { minKm: 100 }).length, 2);
});

test('popDetail: regions by prefixes with their share and distance', () => {
  const s = shapeStarlink(POPS, REGIONS);
  const d = popDetail(s, 'lsancax1', { n: 1 });
  assert.equal(d.pop.code, 'lsancax1');
  assert.equal(d.regions.length, 1);
  assert.equal(d.regions[0].region.city, 'Los Angeles');
  assert.equal(d.regions[0].share, 0.8);
  assert.ok(d.regions[0].km < 30);
  assert.equal(d.more, 1);
  assert.equal(d.countries, 2);
  assert.equal(popDetail(s, 'nope'), null);
  assert.equal(popDetail(s, 'acklnzl1').regions[0].km, null); // Pitcairn isn't placed
  assert.deepEqual([...servedBy(s.byCode.get('nrbiken1'))], [1, 2]);
  assert.equal(servedBy(null).size, 0);
});

test('regionLabel', () => {
  assert.equal(regionLabel(REGIONS[2]), "Sana'a, Yemen");
  assert.equal(regionLabel({ country: 'SG', country_name: 'Singapore', city: 'Singapore' }), 'Singapore');
  assert.equal(regionLabel({ country: 'XX', city: '' }), 'XX');
});

test('greatCircle: ends, continuity across the antimeridian, lift', () => {
  const p = greatCircle([170, -40], [-170, -20], { segs: 8 });
  assert.equal(p.length, 9);
  assert.deepEqual(p[0].map((x) => +x.toFixed(6)), [170, -40, 0]);
  assert.ok(Math.abs(p[8][0] - 190) < 1e-6); // -170 unwrapped to 190: the short way
  for (let i = 1; i < p.length; i++) assert.ok(Math.abs(p[i][0] - p[i - 1][0]) < 10);
  const up = greatCircle([0, 0], [10, 0], { segs: 2, alt: 100, lift: 1000 });
  assert.equal(up[1][2], 1100);
  assert.equal(up[2][2].toFixed(6), '100.000000');
  assert.equal(greatCircle([5, 5], [5, 5]).length, 2); // a point: one segment
});

test('boundsAround: pads, wraps across the antimeridian, gives up on the whole world', () => {
  assert.deepEqual(boundsAround({ lon: 10, lat: 10 }, [{ lon: 20, lat: 0 }], { pad: 0 }), [10, 0, 20, 10]);
  const b = boundsAround({ lon: 174.8, lat: -37 }, [{ lon: -130.1, lat: -25.1 }], { pad: 1 }); // Auckland and Pitcairn
  assert.ok(b[0] > b[2], `${b}`); // west > east: crosses the antimeridian
  assert.ok(Math.abs(b[0] - 173.8) < 1e-9 && Math.abs(b[2] - -129.1) < 1e-9);
  assert.equal(boundsAround({ lon: 0, lat: 0 }, [{ lon: 170, lat: 0 }, { lon: -170, lat: 0 }]), null);
  assert.equal(boundsAround({ lon: null, lat: null }, []), null);
  assert.deepEqual(boundsAround({ lon: 0, lat: 84 }, [{ lon: null, lat: 5 }], { pad: 3 }), [-3, 81, 3, 85]);
});

test('layers param: default out of the link, unknown names dropped, none', () => {
  assert.deepEqual([...parseLayers(null)], DEFAULT_LAYERS);
  assert.equal(layersParam(parseLayers(null)), null);
  assert.deepEqual([...parseLayers('regions,pops,bogus')].sort(), ['pops', 'regions']);
  assert.equal(layersParam(new Set(['regions', 'pops'])), 'pops,regions');
  assert.equal(layersParam(new Set()), 'none');
  assert.equal(parseLayers('none').size, 0);
});
