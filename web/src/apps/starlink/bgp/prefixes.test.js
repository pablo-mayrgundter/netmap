import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contains, coverPrefixes, createPrefixTable, formatCidr, parseCidr } from './prefixes.js';

const sample = JSON.parse(readFileSync(new URL('./fixtures/prefixes-sample.json', import.meta.url)));
const table = createPrefixTable(sample);

test('parseCidr and formatCidr: v4 and v6 round trips, host bits cleared, junk refused', () => {
  for (const s of ['9.246.166.0/24', '0.0.0.0/0', '2a0d:3341:cd00::/40', '2605:59c0::/29', '::/0', '2001:db8::1/128', '::ffff:192.0.2.0/120']) {
    assert.equal(formatCidr(parseCidr(s)), s === '::ffff:192.0.2.0/120' ? '::ffff:c000:200/120' : s);
  }
  assert.equal(formatCidr(parseCidr('9.246.166.77/23')), '9.246.166.0/23');
  assert.equal(formatCidr(parseCidr('2A0D:3341:CDFF:1::/40')), '2a0d:3341:cd00::/40');
  assert.equal(formatCidr(parseCidr('2001:0:0:1:0:0:0:1/128')), '2001:0:0:1::1/128'); // the longer zero run
  assert.equal(parseCidr('192.0.2.1').len, 32);
  for (const bad of ['', '1.2.3/24', '1.2.3.256/24', '1.2.3.4/33', '1::2::3/64', '2001:db8::/129', 'x/1', '1.2.3.4/2a', null]) assert.equal(parseCidr(bad), null, bad);
});

test('contains: same family only, by length', () => {
  const p = parseCidr;
  assert.ok(contains(p('9.246.166.0/23'), p('9.246.167.0/24')));
  assert.ok(!contains(p('9.246.167.0/24'), p('9.246.166.0/23')));
  assert.ok(!contains(p('0.0.0.0/0'), p('::/0')));
  assert.ok(contains(p('2a0d:3340::/29'), p('2a0d:3344:4000::/38')));
});

test('lookup: a prefix inside a feed row (longest match), v4 and v6', () => {
  const v4 = table.lookup('9.246.166.128/25');
  assert.equal(v4.kind, 'within');
  assert.equal(v4.prefix, '9.246.166.0/24');
  assert.equal(v4.pop, 'frntdeu1');
  assert.deepEqual(v4.place, ['DE', 'DE-BE', 'Berlin']);
  const v6 = table.lookup('2a0d:3341:d400::/48'); // a /48 out of the feed's /40
  assert.equal(v6.kind, 'within');
  assert.equal(v6.prefix, '2a0d:3341:d400::/40');
  assert.equal(v6.pop, 'msctomn1');
  assert.equal(table.lookup('2a0d:3344:4000::/38').prefix, '2a0d:3344:4000::/38'); // exact
});

test('lookup: longest match wins over a covering row', () => {
  const t = createPrefixTable({ pops: ['big', 'small'], regions: [['US', 'US-WA', 'Seattle']], prefix: ['10.0.0.0/8', '10.1.0.0/16'], pop: [0, 1], region: [0, -1] });
  assert.equal(t.lookup('10.1.2.0/24').pop, 'small');
  assert.equal(t.lookup('10.1.2.0/24').place, null);
  assert.equal(t.lookup('10.2.0.0/24').pop, 'big');
  const agg = t.lookup('10.0.0.0/7'); // holds both rows
  assert.equal(agg.kind, 'covers');
  assert.deepEqual(agg.pops, [{ code: 'big', n: 1 }, { code: 'small', n: 1 }]);
  assert.equal(t.lookup('12.0.0.0/8'), null);
});

test('lookup: an announced aggregate covering feed rows reports their PoPs', () => {
  const hit = table.lookup('9.246.166.0/23');
  assert.equal(hit.kind, 'covers');
  assert.equal(hit.rows, 2);
  assert.equal(hit.pop, 'frntdeu1');
  assert.deepEqual(hit.pops, [{ code: 'frntdeu1', n: 2 }]);
  assert.equal(table.lookup('150.228.30.0/23').pop, 'wrswpol1');
});

test('lookup: outside the feed, or a row without a PoP', () => {
  assert.equal(table.lookup('74.245.197.0/24'), null);
  assert.equal(table.lookup('2605:59c0:502c::/48'), null);
  assert.equal(table.lookup('not a prefix'), null);
  const nopop = table.lookup('9.161.65.0/24');
  assert.equal(nopop.pop, null);
  assert.deepEqual(nopop.place, ['CA', 'CA-NU', 'Hope Bay']);
  assert.equal(table.size, sample.prefix.length);
});

test('coverPrefixes: cut to /16 and /32, contained dropped, siblings merged', () => {
  assert.deepEqual(coverPrefixes(['9.246.166.0/24', '9.246.167.0/24', '9.161.65.0/24', '9.160.0.0/16', '8.0.0.0/7', '2a0d:3341:cd00::/40', '2a0d:3341:d400::/40', '2a0d:3340::/32', '2605:59c0::/29', '2605:59c1:1::/48']), [
    '8.0.0.0/7',
    '2605:59c0::/29',
    '2a0d:3340::/31',
  ]);
  assert.deepEqual(coverPrefixes(['9.246.166.0/24', '9.161.65.0/24']), ['9.161.0.0/16', '9.246.0.0/16']);
  assert.deepEqual(coverPrefixes(['9.160.0.0/16', '9.161.0.0/16', '9.162.0.0/16', '9.163.0.0/16']), ['9.160.0.0/14']);
  assert.deepEqual(coverPrefixes(['bad', '1.2.3.0/24'], { maxV4: 24 }), ['1.2.3.0/24']);
});
