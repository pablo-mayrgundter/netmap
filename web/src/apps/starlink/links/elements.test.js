import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCompact, epochStats, loadElements } from './elements.js';

// celestiary's compact columns, as its starlink.json has them (two launches).
const COMPACT = {
  format: 'celestiary-compact-omm-1',
  epochBase: '2026-10-21T00:00:00.000Z',
  namePrefix: 'STARLINK-',
  id: [44714, 4, 4400],
  name: ['1008', '1012', '3001'],
  intlId: ['2019-074B', 'F', '2021-082A'],
  epoch: [691202999, 682731096, 0],
  n: [1568231680, 1568569944, 1530000000],
  e: [2090, 5099, 1000],
  i: [531436, 531455, 700000],
  raan: [1415664, 1386781, 1200000],
  argp: [1603523, 1185984, 900000],
  ma: [1997575, 2415547, 0],
  bstar: [292012, 301437, 100000],
};

test('decodeCompact: ids, names, designators, epochs and scales', () => {
  const r = decodeCompact(COMPACT);
  assert.deepEqual(r.map((x) => x.NORAD_CAT_ID), [44714, 44718, 49118]);
  assert.deepEqual(r.map((x) => x.OBJECT_NAME), ['STARLINK-1008', 'STARLINK-1012', 'STARLINK-3001']);
  assert.deepEqual(r.map((x) => x.OBJECT_ID), ['2019-074B', '2019-074F', '2021-082A']);
  assert.equal(r[0].EPOCH, new Date(Date.parse('2026-10-21T00:00:00Z') + 691202999).toISOString());
  assert.equal(r[0].MEAN_MOTION, 15.6823168);
  assert.equal(r[0].ECCENTRICITY, 0.000209);
  assert.equal(r[0].INCLINATION, 53.1436);
  assert.equal(r[0].BSTAR, 0.000292012);
  assert.throws(() => decodeCompact({ format: 'other' }));
  const e = epochStats(r);
  assert.equal(e.max, Date.parse('2026-10-21T00:00:00Z') + 691202999);
});

test('loadElements: the first source that answers, else every error', async () => {
  const calls = [];
  const res = (status, body) => ({ ok: status === 200, status, headers: { get: () => 'application/json' }, json: async () => body });
  const fetchFn = async (url) => (calls.push(url), url.includes('celestiary') ? res(503, null) : res(200, { fields: ['NORAD_CAT_ID', 'EPOCH'], rows: [[1, '2026-11-01T00:00:00']], generated: 'x' }));
  const got = await loadElements({ dataBase: '/data', fetchFn });
  assert.equal(got.source.id, 'netmap');
  assert.equal(got.omm.length, 1);
  assert.deepEqual(got.tried, [{ id: 'celestiary', error: 'HTTP 503' }]);
  assert.equal(calls[1], '/data/starlink/gp.json');
  await assert.rejects(loadElements({ dataBase: '/data', fetchFn: async () => res(404, null) }), /celestiary: HTTP 404; netmap: HTTP 404; celestrak: HTTP 404/);
});
