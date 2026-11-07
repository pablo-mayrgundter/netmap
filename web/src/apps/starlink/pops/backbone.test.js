import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKBONE_FILE, loadBackboneFile, normaliseBackbone, onBackbone, publishBackbone, publishedBackbone } from './backbone.js';

const P = (code, city, lon, lat) => ({ code, city, lon, lat, placed: lon !== null });
const byCode = new Map([P('lsancax1', 'Los Angeles', -118.4, 33.9), P('sttlwax1', 'Seattle', -122.3, 47.4), P('staging2', null, null, null)].map((p) => [p.code, p]));

test('normaliseBackbone: known placed PoPs only, each pair once, labelled', () => {
  const b = normaliseBackbone(
    {
      source: 'RIPE Atlas traceroutes',
      kind: 'measured',
      measured_at: '2026-11-06T00:00:00Z',
      links: [
        { from: 'sttlwax1', to: 'lsancax1', rtt_ms: 21.5, samples: 3 },
        { from: 'lsancax1', to: 'sttlwax1', rtt_ms: 22.1, samples: 9 },
        { from: 'lsancax1', to: 'lsancax1' },
        { from: 'lsancax1', to: 'staging2' },
        { from: 'lsancax1', to: 'nowhere' },
      ],
    },
    byCode,
  );
  assert.equal(b.kind, 'measured');
  assert.equal(b.links.length, 1);
  assert.deepEqual([b.links[0].from, b.links[0].to, b.links[0].samples, b.links[0].rtt_ms], ['lsancax1', 'sttlwax1', 9, 22.1]);
  assert.equal(b.links[0].a.city, 'Los Angeles');
  assert.equal(normaliseBackbone({ kind: 'whatever', links: [{ from: 'lsancax1', to: 'sttlwax1' }] }, byCode).kind, 'modelled'); // unless it says measured
  assert.equal(normaliseBackbone({ links: [] }, byCode), null);
  assert.equal(normaliseBackbone(null, byCode), null);
});

test('publishBackbone: listeners hear it, off() stops them', () => {
  const heard = [];
  const off = onBackbone((raw) => heard.push(raw));
  publishBackbone({ source: 'x', links: [] });
  off();
  publishBackbone(null);
  assert.equal(heard.length, 1);
  assert.equal(publishedBackbone(), null);
});

test('loadBackboneFile: null when missing or not JSON', async () => {
  const urls = [];
  const res = (ok, type, body) => async (url) => (urls.push(url), { ok, headers: { get: () => type }, json: async () => body });
  assert.deepEqual(await loadBackboneFile({ base: '/data', fetch: res(true, 'application/json', { links: [] }) }), { links: [] });
  assert.equal(urls[0], `/data/${BACKBONE_FILE}`);
  assert.equal(await loadBackboneFile({ base: '/data', fetch: res(false, 'text/plain') }), null);
  assert.equal(await loadBackboneFile({ base: '/data', fetch: res(true, 'text/html') }), null); // a dev server's index.html
  assert.equal(await loadBackboneFile({ base: '/data', fetch: async () => { throw new TypeError('offline'); } }), null);
});
