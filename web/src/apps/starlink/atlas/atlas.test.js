// The RIPE Atlas section's DOM-free parts, on real API responses recorded in
// November 2026 (fixtures/: probes, pings and traceroutes from /api/v2/,
// RIPEstat network-info, and the slice of prefixes.json and regions.json
// they touch).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addressKind, parseCidr, parseIp, prefixTable, within } from './ip.js';
import { matchProbe, mergeProbes, nearestRegion, normalizeProbe, popColours } from './probes.js';
import { latencyBy, parsePing, quantile, reconfigBoundaries, regionKey, resolvesReconfig, rttSeries, stats } from './latency.js';
import { isStarlinkInfra, parseTraceroute, pathRoles, pathStops, popRtt } from './traceroute.js';
import { BACKBONE_MSMS, backboneTraceroutes, inferPopLinks } from './backbone.js';
import { BUILTIN, chunks, createAtlasClient } from './api.js';
import { greatCircle } from './arc.js';

const F = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const prefixes = F('prefixes.json');
const regions = F('regions.json');
const table = prefixTable(prefixes);
const probes = F('probes.json').results.map(normalizeProbe);
const pings = F('ping-1001-latest.json');
const traceroutes = F('traceroutes.json');
const fromOf = Object.fromEntries(pings.map((r) => [r.prb_id, r.from]));

test('ip: v4, v6 (with ::), prefixes, containment, kinds', () => {
  assert.equal(parseIp('100.64.0.1').n, 0x64400001n);
  assert.equal(parseIp('256.1.1.1'), null);
  assert.equal(parseIp('2001:7fd::1').n, (0x2001n << 112n) | (0x7fdn << 96n) | 1n);
  assert.equal(parseIp('::ffff:1.2.3.4').n, (0xffffn << 32n) | 0x01020304n);
  assert.equal(parseIp('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(parseIp('nope'), null);
  assert.deepEqual(parseCidr('9.170.0.77/24'), { v: 4, n: parseIp('9.170.0.0').n, len: 24 });
  assert.equal(parseCidr('9.170.0.0/33'), null);
  assert.ok(within(parseCidr('2605:59c8:38e0::1'), parseCidr('2605:59c8:3800::/40')));
  assert.ok(!within(parseCidr('2605:59c9::1'), parseCidr('2605:59c8:3800::/40')));
  assert.equal(addressKind('100.64.0.1'), 'cgnat');
  assert.equal(addressKind('172.16.251.130'), 'private');
  assert.equal(addressKind('fdf8:f9:f113::3'), 'private');
  assert.equal(addressKind('206.224.64.180'), 'public');
});

test('prefix table: longest match, and the rows inside a wider prefix', () => {
  const hit = table.lookup('145.224.108.26');
  assert.equal(hit.prefix, '145.224.108.0/25');
  assert.equal(hit.pop, 'sfiabgr1');
  assert.deepEqual(hit.region, ['BG', 'BG-22', 'Sofia']);
  assert.equal(table.lookup('145.224.108.0/24'), null); // wider than the table's /25s
  assert.deepEqual(table.inside('145.224.108.0/24').map((r) => r.prefix), ['145.224.108.0/25', '145.224.108.128/25']);
  assert.equal(table.lookup('2605:59c8:38e0:c010:da58:d7ff:fe03:b3a').pop, 'mntlcan1');
  assert.equal(table.lookup('8.8.8.8'), null);
});

test('probe -> PoP: by address, by its latest result, by geometry; geometry cross-checked', () => {
  const m = Object.fromEntries(probes.map((p) => [p.id, matchProbe(p, table, { regions, from: fromOf[p.id] })]));
  assert.deepEqual([m[1012236].pop, m[1012236].via, m[1012236].prefix], ['nwyynyx1', 'address', '153.66.173.0/24']);
  // its geometry (Philadelphia) is nearest a region mostly served from Ashburn
  assert.equal(m[1012236].geo.pop, 'ashnvax2');
  assert.equal(m[1012236].agrees, false);
  // 72's address is private (hidden); its ping's source address isn't
  assert.equal(probes.find((p) => p.id === 72).v4, null);
  assert.deepEqual([m[72].pop, m[72].via, m[72].address, m[72].agrees], ['sfiabgr1', 'result', '145.224.108.26', true]);
  // 10092 is on Starlink by IPv6 only, with no address: geometry
  assert.deepEqual([m[10092].pop, m[10092].via, m[10092].geo.km], ['sfiabgr1', 'geometry', 2]);
  assert.equal(m[61631].pop, 'mntlcan1');
  assert.equal(m[65777].pop, 'nwyynyx1');
  // without its result, 11585's /23 holds two /24s of one PoP
  const p = probes.find((x) => x.id === 11585);
  assert.deepEqual([matchProbe(p, table).pop, matchProbe(p, table).via, matchProbe(p, table).share], ['stcmswe1', 'prefix', 1]);
  // nothing to go on
  assert.deepEqual(matchProbe({ id: 1, lon: 0, lat: 0 }, table, { regions }).pop, null);
});

test('probes: normalised, merged by id; colours stable per PoP; nearest region within reach', () => {
  const p = probes.find((x) => x.id === 1012236);
  assert.equal(p.lon, -75.1615);
  assert.ok(p.tags.includes('system-ipv4-works'));
  assert.equal(p.status, 'Connected');
  assert.deepEqual(mergeProbes([{ id: 3 }, { id: 1 }], [{ id: 1, x: 1 }]).map((x) => x.id), [1, 3]);
  const c = popColours(['b', 'a']);
  assert.deepEqual(c.get('a'), popColours(['a', 'b']).get('a'));
  assert.notDeepEqual(c.get('a'), c.get('b'));
  assert.equal(nearestRegion(regions, 0, 0), null);
  assert.equal(nearestRegion(regions, 23.4, 42.7).pop, 'sfiabgr1');
});

test('latency: quantiles, ping parsing, by PoP and by region', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([], 0.5), null);
  assert.deepEqual(stats([10, NaN, 30, 20]), { n: 3, median: 20, p90: 28, min: 10, max: 30 });
  const ping = Object.fromEntries(pings.map((r) => [r.prb_id, parsePing(r)]));
  assert.equal(ping[72].rtts.length, 2); // one of three lost
  assert.ok(Math.abs(ping[72].rtt - (58.859532 + 64.213261) / 2) < 1e-9);
  assert.equal(ping[1012236].msm, BUILTIN.ping[4].id);
  assert.equal(ping[1012236].dst, '193.0.14.129');
  assert.equal(parsePing({ type: 'traceroute' }), null);
  const match = Object.fromEntries(probes.map((p) => [p.id, matchProbe(p, table, { regions, from: fromOf[p.id] })]));
  const rtt = (id) => ping[id]?.rtt ?? null;
  const byPop = latencyBy(probes, (p) => match[p.id].pop, rtt);
  const ny = byPop.find((g) => g.key === 'nwyynyx1');
  assert.deepEqual(ny.probes.sort(), [1012236, 65777].sort());
  assert.equal(ny.n, 2);
  assert.ok(Math.abs(ny.median - (ping[1012236].rtt + ping[65777].rtt) / 2) < 1e-9);
  assert.ok(byPop.every((g, k) => k === 0 || byPop[k - 1].median <= g.median));
  // 10092 has no ping in the fixture: left out
  assert.ok(!byPop.some((g) => g.probes.includes(10092)));
  const byRegion = latencyBy(probes, (p) => regionKey(match[p.id], p), rtt);
  assert.deepEqual(byRegion.map((g) => g.key).sort(), ['BG-22', 'CA-ON', 'SE-AB', 'US-NH', 'US-PA']);
  assert.equal(regionKey({ region: null }, { country: 'BG' }), 'BG');
});

test('latency over time: a series from /results/, and the 15 s reconfiguration boundaries', () => {
  const s = rttSeries(F('ping-1001-results-1012236.json'));
  assert.equal(s.length, 14);
  assert.ok(s.every((p, k) => k === 0 || s[k - 1].ts < p.ts));
  assert.equal(resolvesReconfig(s), false); // built-in pings are 240 s apart
  assert.equal(resolvesReconfig([{ ts: 0 }, { ts: 5 }, { ts: 10 }]), true);
  // seconds 12, 27, 42, 57 of each minute
  assert.deepEqual(reconfigBoundaries(1_794_000_000, 1_794_000_060).map((t) => t % 60), [12, 27, 42, 57]);
  assert.deepEqual(reconfigBoundaries(1_794_000_013, 1_794_000_027).map((t) => t % 60), [27]);
  assert.deepEqual(reconfigBoundaries(10, 5), []);
});

test('traceroute: parsed, and split into the dish, the PoP, Starlink and the internet', () => {
  const tr = parseTraceroute(traceroutes.find((r) => r.prb_id === 1012236 && r.msm_id === 5001));
  assert.equal(tr.from, '153.66.173.77');
  assert.equal(tr.dstAddr, '193.0.14.129');
  assert.equal(tr.reached, true);
  assert.equal(tr.hops[2].ip, '100.64.0.1');
  assert.equal(tr.hops[2].kind, 'cgnat');
  assert.equal(tr.hops[7].ip, null); // * * *
  assert.equal(tr.hops[7].lost, 3);
  const asns = { '206.224.64.180': 14593, '206.224.64.171': 14593, '206.82.105.16': 42, '193.0.14.129': 25152 };
  const hops = pathRoles(tr, { asnOf: (ip) => asns[ip] ?? null, table });
  assert.deepEqual(hops.map((h) => h.role), ['lan', 'lan', 'pop', 'starlink', 'starlink', 'starlink', 'internet', 'internet', 'dest']);
  assert.equal(hops[6].asn, 42);
  assert.equal(popRtt(hops), tr.hops[2].rtt);
  // with no RIPEstat (offline), Starlink's routers are known by their space
  assert.ok(isStarlinkInfra('206.224.70.62') && isStarlinkInfra('2620:134:b0fe:250::110') && isStarlinkInfra('74.245.147.206'));
  const offline = pathRoles(parseTraceroute(traceroutes.find((r) => r.prb_id === 72)), { table });
  assert.deepEqual(offline.map((h) => h.role), ['lan', 'pop', 'starlink', 'starlink', 'starlink', 'internet', 'internet', 'dest']);
  // IPv6: no CGNAT; the home router answers in ~1 ms, the PoP's gateway past the satellite
  const v6 = pathRoles(parseTraceroute(traceroutes.find((r) => r.prb_id === 1012236 && r.msm_id === 6001)), { table });
  assert.deepEqual(v6.slice(0, 5).map((h) => h.role), ['lan', 'lan', 'pop', 'starlink', 'starlink']);
  assert.equal(v6[8].role, 'dest');
  // stops: hops at one place merge, unknown places join the last stop
  const place = (h) => (h.role === 'lan' ? [0, 0] : h.role === 'pop' || h.role === 'starlink' ? [1, 1] : h.asn ? [h.asn, 0] : null);
  const stops = pathStops(hops, place);
  assert.deepEqual(stops.map((s) => s.hops), [[1, 2], [3, 4, 5, 6], [7, 8], [9]]);
  assert.deepEqual(stops.map((s) => s.role), ['lan', 'pop', 'internet', 'dest']);
  assert.equal(parseTraceroute({ type: 'ping' }), null);
});

test('inferPopLinks: routers dishes behind two PoPs both cross, prefixes of another PoP', () => {
  const links = inferPopLinks(traceroutes, prefixes);
  assert.equal(links.length, 1);
  assert.deepEqual(
    { ...links[0], ts: null },
    { a: 'mntlcan1', b: 'nwyynyx1', evidence: 2, kinds: ['shared'], confidence: 'low', routers: ['2620:134:b0fe:250::110'], probes: [61631, 65777], msms: [6052], ts: null },
  );
  assert.equal(inferPopLinks(traceroutes, prefixes, { minEvidence: 3 }).length, 0);
  // a router deeper in one PoP's paths than the other's: transit
  const mk = (prb, from, hops) => ({ type: 'traceroute', prb_id: prb, msm_id: 5051, timestamp: 1, from, dst_addr: '9.9.9.9', result: hops.map((ip, k) => ({ hop: k + 1, result: [{ from: ip, rtt: k ? 30 : 1 }] })) });
  const a = mk(1, '153.66.173.77', ['192.168.1.1', '100.64.0.1', '206.224.64.1', '206.224.64.2', '9.9.9.9']); // nwyynyx1
  const b = mk(2, '145.224.108.26', ['192.168.1.1', '100.64.0.1', '206.224.64.2', '9.9.9.9']); // sfiabgr1
  const [l] = inferPopLinks([a, b], prefixes);
  assert.deepEqual([l.a, l.b, l.kinds, l.confidence, l.routers], ['nwyynyx1', 'sfiabgr1', ['transit'], 'medium', ['206.224.64.2']]);
  // a hop in another PoP's customer space
  const c = mk(3, '153.66.173.77', ['192.168.1.1', '100.64.0.1', '206.224.64.9', '212.105.145.1', '9.9.9.9']);
  const [p] = inferPopLinks([c], prefixes);
  assert.deepEqual([p.a, p.b, p.kinds], ['nwyynyx1', 'stcmswe1', ['prefix']]);
  // the anycast roots: each dish leaves at its own PoP, nothing to infer
  assert.deepEqual(inferPopLinks(traceroutes.filter((r) => r.msm_id === 5001), prefixes), []);
  // RIPEstat's AS for a hop wins over the fallback space
  assert.deepEqual(inferPopLinks([a, b], prefixes, { asnOf: (ip) => (ip === '206.224.64.2' ? 3356 : null) }), []);
});

test('backboneTraceroutes: the latest of each backbone measurement, failures left out', async () => {
  assert.deepEqual(BACKBONE_MSMS, [5051, 5151, 6052, 6152, 6001]);
  const client = { latest: async (m, ids) => (m === 5151 ? Promise.reject(new Error('503')) : traceroutes.filter((r) => r.msm_id === m && ids.includes(r.prb_id))) };
  const got = await backboneTraceroutes(client, [61631, 65777, 1012236], null);
  assert.deepEqual(got.map((r) => `${r.msm_id}:${r.prb_id}`), ['6052:61631', '6052:65777', '6001:1012236']);
  assert.equal(inferPopLinks(got, prefixes).length, 1);
});

test('api: batches of probe ids, the session cache, backoff on 429, abort', async () => {
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const urls = [];
  let fail = 1;
  const fetch = async (url) => {
    urls.push(url);
    if (url.includes('/latest/') && fail-- > 0) return { ok: false, status: 429, headers: { get: () => '2' } };
    if (url.includes('network-info')) return { ok: true, json: async () => F('network-info-193.0.14.129.json') };
    if (url.includes('/probes/')) return { ok: true, json: async () => (url.includes('?asn_v4=') ? F('probes.json') : { results: [{ id: 72 }, { id: 9 }], next: null }) };
    const ids = new URL(url).searchParams.get('probe_ids').split(',').map(Number);
    return { ok: true, json: async () => pings.filter((r) => ids.includes(r.prb_id)) };
  };
  const waits = [];
  const client = createAtlasClient({ fetch, wait: async (ms) => waits.push(ms) });
  const ids = Array.from({ length: 150 }, (_, k) => k + 1).concat([1012236]);
  const got = await client.latest(1001, ids, null);
  assert.deepEqual(got.map((r) => r.prb_id).sort((a, b) => a - b), [72, 1012236]);
  assert.equal(urls.filter((u) => u.includes('/latest/')).length, 3); // 2 batches, one retried
  assert.deepEqual(waits, [2000]); // Retry-After: 2
  await client.latest(1001, ids, null);
  assert.equal(urls.filter((u) => u.includes('/latest/')).length, 3); // cached
  const all = await client.probes(null);
  assert.deepEqual(all.map((p) => p.id), [9, 72, 10092, 11585, 61631, 65777, 1012236]);
  assert.deepEqual(await client.networkInfo('193.0.14.129', null), { asns: [25152], prefix: '193.0.14.0/24' });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(client.json('https://atlas.ripe.net/api/v2/x', ac.signal));
  assert.equal(client.cached('https://atlas.ripe.net/api/v2/x'), false); // a failure isn't kept
  const err = createAtlasClient({ fetch: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(err.json('https://atlas.ripe.net/api/v2/y', null), /404/);
});

test('arcs: great circles between two points, with lift', () => {
  const p = greatCircle([0, 0, 0], [90, 0, 0], { stepDeg: 10, lift: 0.1 });
  assert.equal(p.length, 10);
  assert.deepEqual(p[0].map((x) => Math.round(x)), [0, 0, 0]);
  assert.deepEqual(p.at(-1).map((x) => Math.round(x * 1e6) / 1e6), [90, 0, 0]);
  assert.ok(Math.abs(p[5][0] - 50) < 1e-6 && p[5][2] > 0);
  assert.equal(greatCircle([1, 2, 0], [1, 2, 0]).length, 2);
  // across the antimeridian, the short way
  assert.ok(greatCircle([170, 0, 0], [-170, 0, 0], { stepDeg: 5 }).every(([lon]) => Math.abs(lon) >= 170));
});
