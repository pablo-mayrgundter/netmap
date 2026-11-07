import test from 'node:test';
import assert from 'node:assert/strict';
import { appHashChanges, readAppHash, sameParams, writeAppHash } from './appHash.js';

const q = (s) => new URLSearchParams(s);
const known = (id) => ['starlink', 'bgp'].includes(id);

test('no app: no keys, and side defaults to shown', () => {
  assert.deepEqual(readAppHash(q('data=internet&z=2'), known), { app: null, side: true, params: {} });
  assert.equal(writeAppHash(q('data=internet'), { app: null, side: false, params: { a: '1' } }).toString(), 'data=internet');
});

test('the open app, its panel and its own params', () => {
  const h = q('data=internet&app=starlink&side=0&starlink.pop=sea&starlink.about=0&bgp.peer=1&other=1');
  assert.deepEqual(readAppHash(h, known), { app: 'starlink', side: false, params: { pop: 'sea', about: '0' } });
});

test('an unknown app reads as none, and so do its params', () => {
  assert.deepEqual(readAppHash(q('app=nope&nope.x=1'), known), { app: null, side: true, params: {} });
});

test('round trip: what is written reads back the same', () => {
  const state = { app: 'starlink', side: false, params: { pop: 'sea', 'k-2': 'a b&c', about: '0' } };
  const h = writeAppHash(q('data=internet&lon=1.000'), state);
  assert.equal(h.get('data'), 'internet'); // the rest of the permalink stays
  const back = readAppHash(q(h.toString()), known);
  assert.deepEqual(back, state);
  // and through the URL itself (the hash is a string)
  assert.deepEqual(readAppHash(new URLSearchParams(`#${h}`.slice(1)), known), state);
});

test('written keys are sorted, empty params dropped, old app keys replaced', () => {
  const h = writeAppHash(q('app=bgp&side=1&bgp.peer=1&data=x'), { app: 'starlink', params: { z: '1', a: '2', gone: '', nil: null } });
  assert.equal(h.toString(), 'data=x&app=starlink&side=1&starlink.a=2&starlink.z=1');
});

test('param keys a URL would escape are not read', () => {
  assert.deepEqual(readAppHash(q('app=starlink&starlink.Bad=1&starlink.a%20b=2&starlink.ok=3'), known).params, { ok: '3' });
});

test('changes: app, side, params', () => {
  const now = { app: 'starlink', side: true, params: { a: '1' } };
  assert.deepEqual(appHashChanges({ ...now }, now), { app: false, side: false, params: false });
  assert.deepEqual(appHashChanges({ ...now, app: 'bgp' }, now), { app: true, side: false, params: false });
  assert.deepEqual(appHashChanges({ app: null, side: true, params: {} }, now), { app: true, side: false, params: false });
  assert.deepEqual(appHashChanges({ ...now, side: false }, now), { app: false, side: true, params: false });
  assert.deepEqual(appHashChanges({ ...now, params: { a: '2' } }, now), { app: false, side: false, params: true });
  assert.deepEqual(appHashChanges({ ...now, params: {} }, now), { app: false, side: false, params: true });
  assert.equal(sameParams({ a: '1', b: null }, { a: 1 }), true);
});
