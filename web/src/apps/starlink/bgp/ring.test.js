import test from 'node:test';
import assert from 'node:assert/strict';
import { createRate, createRing, createThrottle } from './ring.js';

test('ring: keeps the newest cap items, newest first', () => {
  const r = createRing(3);
  assert.deepEqual(r.items(), []);
  r.push(1);
  r.push(2);
  assert.deepEqual(r.items(), [2, 1]);
  for (const x of [3, 4, 5]) r.push(x);
  assert.equal(r.size, 3);
  assert.deepEqual(r.items(), [5, 4, 3]);
  assert.deepEqual(r.items(2), [5, 4]);
  assert.deepEqual(r.items(10), [5, 4, 3]);
  r.clear();
  assert.equal(r.size, 0);
  assert.deepEqual(r.items(), []);
  assert.throws(() => createRing(0), RangeError);
});

test('ring: wraps many times', () => {
  const r = createRing(4);
  for (let i = 0; i < 1003; i++) r.push(i);
  assert.deepEqual(r.items(), [1002, 1001, 1000, 999]);
});

test('throttle: once per interval, the first at once', () => {
  const t = createThrottle(500);
  const at = [0, 100, 499, 500, 501, 999, 1000, 2500].filter((now) => t.allow(now));
  assert.deepEqual(at, [0, 500, 1000, 2500]);
  t.reset();
  assert.ok(t.allow(2600));
});

test('rate: a sliding minute in 1 s buckets', () => {
  const r = createRate();
  assert.equal(r.perMinute(0), 0);
  for (let s = 0; s < 60; s++) r.add(s * 1000 + 10, 2); // 2 a second for a minute
  assert.equal(r.total(59_999), 120);
  assert.equal(Math.round(r.perMinute(59_999)), 120);
  // 30 s later, half the window has rolled out
  assert.equal(r.total(89_999), 60);
  // and after two quiet minutes nothing is left
  assert.equal(r.total(200_000), 0);
  assert.equal(r.perMinute(200_000), 0);
});

test('rate: scaled to a minute while under one', () => {
  const r = createRate();
  r.add(0, 10);
  r.add(5000, 10);
  assert.equal(r.total(10_000), 20);
  assert.equal(r.perMinute(10_000), 120); // 20 in 10 s
  assert.equal(r.perMinute(100), 1200); // at least a bucket's span
  assert.equal(r.span(10_000), 10_000);
  assert.equal(r.span(500_000), 60_000);
  r.reset();
  assert.equal(r.total(10_000), 0);
});
