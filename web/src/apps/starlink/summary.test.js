import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHost } from '../host.js';
import { createRegistry } from '../registry.js';
import { fakeBridge, fakeGraph, mountPoints } from '../fixtures.js';
import starlink from './index.js';
import { LIST_MAX, STARLINK_ASN, starlinkSummary } from './summary.js';

test('absent: AS14593 not on the map', () => {
  assert.deepEqual(starlinkSummary(null, null, []), { present: false, asn: STARLINK_ASN });
});

test('present: the summary from ctx, upstreams and peers split, the details record once it lands', async () => {
  const bridge = fakeBridge();
  bridge.G = fakeGraph();
  const { mountPoint } = mountPoints();
  const host = createAppHost({ registry: createRegistry([{ ...starlink, load: async () => ({ mount() {}, unmount() {} }) }]), bridge, mountPoint });
  await host.open('starlink');
  const ctx = host.ctx();
  const node = ctx.node(STARLINK_ASN);
  const nb = ctx.neighbours(STARLINK_ASN);
  const loading = starlinkSummary(node, null, nb);
  assert.equal(loading.loading, true);
  assert.equal(loading.cone, null);
  assert.deepEqual(loading.upstreams.map((n) => n.asn), [3356]);
  assert.deepEqual(loading.peering.map((n) => n.asn), [714]);
  assert.equal(loading.customers, 1);
  const s = starlinkSummary(node, await ctx.info(STARLINK_ASN), nb);
  assert.equal(s.present, true);
  assert.equal(s.cone, 2);
  assert.equal(s.coreness, 3);
  assert.equal(s.level, 0.7);
  assert.equal(s.degree, 3);
  assert.equal(s.loading, false);
});

test('long lists are cut, and the rest counted', () => {
  const peers = Array.from({ length: LIST_MAX + 5 }, (_, k) => ({ asn: k + 1, name: `p${k}`, rel: 'peer', degree: 100 - k }));
  const s = starlinkSummary({ asn: STARLINK_ASN, name: 'S', degree: 40, level: 0.5 }, null, peers);
  assert.equal(s.peering.length, LIST_MAX);
  assert.equal(s.more.peering, 5);
  assert.equal(s.more.upstreams, 0);
});
