import test from 'node:test';
import assert from 'node:assert/strict';
import { linksKey, nearPattern, nearest, supportsNearAnchors } from './orbitsLinks.js';

test('links key: same ids and places, same key', () => {
  const a = [{ id: 'norad:1', ecef: [1, 2, 3] }];
  assert.equal(linksKey(a), linksKey([{ id: 'norad:1', ecef: [1, 2, 3], kind: 'starlink' }]));
  assert.notEqual(linksKey(a), linksKey([{ id: 'norad:1', ecef: [1, 2, 3.5] }]));
  assert.notEqual(linksKey(a), linksKey([]));
});

test('nearest: the closest few, closest first', () => {
  const at = (id, x) => ({ id, ecef: [x, 0, 0] });
  assert.deepEqual(
    nearest([at('a', 10), at('b', 1), at('c', -3), at('d', 7)], [0, 0, 0], 2).map((a) => a.id),
    ['b', 'c'],
  );
});

test('near subscriptions only for a guest that says it answers them', () => {
  assert.equal(supportsNearAnchors(null), false);
  // celestiary#296 and #304 as they are: anchors, but no near in hello.
  assert.equal(supportsNearAnchors({ ext: { 'portal.anchors/1': { publish: ['norad', 'dsn'] } } }), false);
  assert.equal(supportsNearAnchors({ ext: { 'portal.anchors/1': { publish: ['norad'], near: true } } }), true);
  assert.equal(supportsNearAnchors({ ext: { 'portal.anchors/1': { near: 64 } } }), true);
  assert.equal(supportsNearAnchors({ ext: { 'portal.anchors/1': { queries: ['near'] } } }), true);
  assert.deepEqual(nearPattern([1, 2, 3], 4), { near: { p: [1, 2, 3], n: 4 }, pattern: 'norad:*' });
});
