import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMissing, nextLineSet, shownLinks } from './lineSet.js';

const ids = (...a) => Uint32Array.from(a);
const opts = (o) => ({ trig: 'geo', sec: 'pos_geo', owner: 'G', live: true, applied: true, now: 0, moveMs: 1500, count: 10, ...o });

test('shown links: the kept indices, ascending', () => {
  assert.deepEqual([...shownLinks(8, (k) => k % 3 === 0)], [0, 3, 6]);
  assert.equal(shownLinks(4, () => false).length, 0);
});

test('append missing: the first set, then what it lacks; itself when it lacks nothing', () => {
  const a = ids(4, 1, 7);
  assert.deepEqual([...appendMissing(a, ids(1, 2, 7, 9), 10)], [4, 1, 7, 2, 9]);
  assert.equal(appendMissing(a, ids(7, 4), 10), a);
});

test('line set: the same set while nothing changes, a new layer for new links at rest', () => {
  const shown = ids(1, 2, 3);
  const s0 = nextLineSet(null, shown, opts({ live: false }));
  assert.equal(s0.gen, 0);
  assert.equal(s0.ids, shown);
  assert.equal(s0.data.length, 3);
  // a second render before deck has the layer: no new layer
  assert.equal(nextLineSet(s0, shown, opts({ live: false })), s0);
  const s1 = nextLineSet(s0, shown, opts({ now: 10 }));
  assert.equal(s1, s0);
  const fewer = ids(2);
  const s2 = nextLineSet(s1, fewer, opts({ now: 20 }));
  assert.equal(s2.gen, 1);
  assert.equal(s2.ids, fewer);
  assert.equal(s2.data.length, 1);
  // another dataset: a new layer
  assert.equal(nextLineSet(s2, fewer, opts({ owner: 'H' })).gen, 2);
});

test('line set: links the move shows are added at the old layout, then the layout moves', () => {
  const s0 = nextLineSet(null, ids(1, 2, 3), opts({ trig: 'geo', sec: 'pos_geo', live: false }));
  // geo to hybrid shows more links: they go after the others, at the old layout
  const hybrid = ids(2, 3, 5);
  const s1 = nextLineSet(s0, hybrid, opts({ trig: 'hybrid', sec: 'pos_hybrid', now: 100 }));
  assert.equal(s1.gen, 0); // the same layer, so its transitions carry on
  assert.deepEqual([...s1.ids], [1, 2, 3, 5]);
  assert.equal(s1.held, true);
  assert.equal(s1.trig, 'geo');
  assert.equal(s1.sec, 'pos_geo');
  // until deck has them, nothing changes
  assert.equal(nextLineSet(s1, hybrid, opts({ trig: 'hybrid', sec: 'pos_hybrid', now: 110, applied: false })), s1);
  // then the layout moves, with every link in place
  const s2 = nextLineSet(s1, hybrid, opts({ trig: 'hybrid', sec: 'pos_hybrid', now: 120 }));
  assert.equal(s2.held, false);
  assert.equal(s2.ids, s1.ids);
  assert.equal(s2.data, s1.data);
  assert.equal(s2.sec, 'pos_hybrid');
  assert.equal(s2.until, 1620);
  // zooming during the move changes nothing
  assert.equal(nextLineSet(s2, hybrid, opts({ trig: 'hybrid', sec: 'pos_hybrid', now: 200 })), s2);
  // links shown mid-move (no layout change) join the end at once
  const s3 = nextLineSet(s2, ids(2, 3, 5, 7), opts({ trig: 'hybrid', sec: 'pos_hybrid', now: 300 }));
  assert.deepEqual([...s3.ids], [1, 2, 3, 5, 7]);
  assert.equal(s3.held, false);
  assert.equal(s3.gen, 0);
  // once the move is over, the set is rebuilt to the links shown
  const s4 = nextLineSet(s3, hybrid, opts({ trig: 'hybrid', sec: 'pos_hybrid', now: 1700 }));
  assert.equal(s4.gen, 1);
  assert.equal(s4.ids, hybrid);
  assert.equal(s4.until, 0);
});

test('line set: a move that only hides links keeps them in place, filtered', () => {
  const s0 = nextLineSet(null, ids(1, 2, 3), opts({ trig: 'hybrid', sec: 'pos_hybrid', live: false }));
  const s1 = nextLineSet(s0, ids(2), opts({ trig: 'geo', sec: 'pos_geo', now: 100 }));
  assert.equal(s1.held, false);
  assert.equal(s1.ids, s0.ids);
  assert.equal(s1.sec, 'pos_geo');
  assert.equal(s1.until, 1600);
});

test('line set: a layout move with the same links keeps the set and only times the move', () => {
  const shown = ids(1, 2);
  const s0 = nextLineSet(null, shown, opts({ trig: 'cyber', live: false }));
  const s1 = nextLineSet(s0, shown, opts({ trig: 'hybrid', now: 50 }));
  assert.equal(s1.ids, s0.ids);
  assert.equal(s1.data, s0.data);
  assert.equal(s1.until, 1550);
  const s2 = nextLineSet(s1, shown, opts({ trig: 'hybrid', now: 2000 }));
  assert.equal(s2.ids, s0.ids);
  assert.equal(s2.data, s0.data);
  assert.equal(s2.until, 0);
});
