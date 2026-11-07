import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrefixTable } from './prefixes.js';
import {
  createStatCache,
  fetchRipestat,
  parseUtc,
  ripestatPage,
  ripestatUrl,
  shapeAnnounced,
  shapeNeighbours,
  shapePrefixCount,
  shapeRoutingStatus,
  shapeVisibility,
  sparkPath,
} from './ripestat.js';

// Real responses for AS14593 (2026-11-07), trimmed to a few rows each.
const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const table = createPrefixTable(load('prefixes-sample'));

test('urls: the data call with sourceapp, and the AS page', () => {
  assert.equal(ripestatUrl('asn-neighbours', { resource: 'AS14593' }), 'https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS14593&sourceapp=netmap');
  assert.equal(ripestatPage(14593), 'https://stat.ripe.net/resource/AS14593');
  assert.equal(parseUtc('2026-11-06T16:00:00'), Date.UTC(2026, 10, 6, 16));
  assert.equal(parseUtc('2026-11-06T16:00:00Z'), Date.UTC(2026, 10, 6, 16));
  assert.equal(parseUtc(''), null);
  assert.equal(parseUtc('soon'), null);
});

test('announced-prefixes: those still announced at the latest time, by PoP', () => {
  const s = shapeAnnounced(load('ripestat-announced-prefixes').data, table);
  assert.equal(s.windowCount, 8);
  assert.equal(s.prefixes.length, 6, 'two ended before the latest time');
  assert.ok(!s.prefixes.includes('143.105.109.0/24'));
  assert.equal(s.v4, 4);
  assert.equal(s.v6, 2);
  assert.deepEqual(s.byPop, [
    { code: 'frntdeu1', v4: 2, v6: 0 }, // 9.246.166.0/23 and 209.198.158.0/23 cover feed /24s
    { code: 'mlnnita1', v4: 0, v6: 1 },
    { code: 'nrbiken1', v4: 0, v6: 1 },
    { code: 'wrswpol1', v4: 1, v6: 0 },
  ]);
  assert.equal(s.inFeed, 5);
  assert.equal(s.notInFeed, 1); // 74.245.197.0/24
  assert.equal(s.noPop, 0);
  assert.equal(s.time, Date.UTC(2026, 10, 6, 16));
  // without the table: counts only
  const bare = shapeAnnounced(load('ripestat-announced-prefixes').data);
  assert.deepEqual([bare.v4, bare.v6, bare.byPop.length, bare.notInFeed], [4, 2, 0, 6]);
  assert.deepEqual(shapeAnnounced(null).prefixes, []);
});

test('asn-neighbours: left and right by power, the counts from RIPEstat', () => {
  const s = shapeNeighbours(load('ripestat-asn-neighbours').data);
  assert.deepEqual(s.counts, { left: 168, right: 14, uncertain: 138, unique: 314 });
  assert.equal(s.left.length, 4);
  assert.deepEqual(s.left.map((n) => n.power), [...s.left.map((n) => n.power)].sort((a, b) => b - a));
  assert.deepEqual(s.right[0], { asn: 10075, power: 5174, v4: 13926, v6: 4565 });
  assert.equal(s.uncertain.length, 1);
  assert.equal(s.time, Date.UTC(2026, 10, 6));
  assert.deepEqual(shapeNeighbours({}).counts, { left: 0, right: 0, uncertain: 0, unique: 0 });
});

test('routing-status: RIS visibility and the announced counts', () => {
  const s = shapeRoutingStatus(load('ripestat-routing-status').data);
  assert.deepEqual(s.visibility, { v4: { seeing: 321, total: 321 }, v6: { seeing: 312, total: 312 } });
  assert.deepEqual(s.announced, { v4: 2173, v6: 1056 });
  assert.equal(s.neighbours, 314);
  assert.equal(s.time, Date.UTC(2026, 10, 6, 16));
  assert.deepEqual(shapeRoutingStatus({}).visibility, { v4: null, v6: null });
});

test('visibility: full-table peers per collector, and the ones not seeing', () => {
  const data = load('ripestat-visibility').data;
  const s = shapeVisibility(data);
  assert.equal(s.collectors, 3);
  assert.deepEqual(s.missing, { v4: 0, v6: 0 });
  assert.deepEqual(s.fullTable, { v4: 39 + 28 + 26, v6: 31 + 28 + 29 });
  assert.deepEqual(s.worst, []);
  // a collector with peers missing some prefix
  const worse = structuredClone(data);
  worse.visibilities[1].ipv4_full_table_peers_not_seeing = [{ asn: 1 }, { asn: 2 }];
  assert.deepEqual(shapeVisibility(worse).worst, [{ name: 'RRC01', city: 'London', v4: 2, v6: 0 }]);
});

test('prefix-count: the two series oldest first, and a sparkline path', () => {
  const s = shapePrefixCount(load('ripestat-prefix-count').data);
  assert.equal(s.v4.length, 4);
  assert.equal(s.v6.length, 4);
  assert.ok(s.v4[0].t < s.v4[3].t);
  assert.equal(s.resolution, '12d');
  assert.equal(sparkPath([1, 2, 3], 10, 10, { pad: 0 }), 'M0.0 10.0L5.0 5.0L10.0 0.0');
  assert.equal(sparkPath([5, 5], 10, 4, { pad: 0 }), 'M0.0 4.0L10.0 4.0');
  assert.equal(sparkPath([1], 10, 10), '');
});

test('fetchRipestat: data and server time; errors carry RIPEstat\'s message', async () => {
  const ok = load('ripestat-routing-status');
  const seen = [];
  const fakeFetch = (body, status = 200) => async (url, opts) => (seen.push([url, opts]), { ok: status < 400, status, json: async () => body });
  const r = await fetchRipestat('routing-status', { resource: 'AS14593' }, { fetch: fakeFetch(ok) });
  assert.equal(r.data.observed_neighbours, 314);
  assert.equal(r.time, parseUtc(ok.time));
  assert.match(seen[0][0], /routing-status\/data\.json\?resource=AS14593&sourceapp=netmap$/);
  await assert.rejects(fetchRipestat('x', {}, { fetch: fakeFetch({ status: 'error', messages: [['error', 'Unknown resource']] }, 400) }), /RIPEstat x: Unknown resource/);
  await assert.rejects(fetchRipestat('x', {}, { fetch: async () => ({ ok: false, status: 503, json: async () => { throw new Error('html'); } }) }), /HTTP 503/);
});

test('cache: per session, in memory and storage, until the TTL', () => {
  let t = 0;
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const a = createStatCache({ storage, ttl: 1000, now: () => t });
  assert.equal(a.get('k'), null);
  a.set('k', { n: 1 });
  assert.deepEqual(a.get('k').value, { n: 1 });
  // a second cache on the same storage (a reload) finds it
  const b = createStatCache({ storage, ttl: 1000, now: () => t });
  assert.deepEqual(b.get('k'), { at: 0, value: { n: 1 } });
  t = 1000;
  assert.equal(a.get('k'), null, 'stale');
  a.delete('k');
  assert.equal(store.size, 0);
  // storage that throws still caches in memory
  const c = createStatCache({ storage: { getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() {} } });
  c.set('k', 1);
  assert.equal(c.get('k').value, 1);
});
