import test from 'node:test';
import assert from 'node:assert/strict';
import { COARSE, FINE, arcChunks, arcSegmentCounts, arcSegments, buildArcs, chunkRanges, perVertex } from './arcs.js';

// main.js's builder before the arcs moved here, ends by callback: the fine
// subdivision must stay bit for bit what it was (the default view's picture).
const D2R = Math.PI / 180;
function oldBuildArcs(count, ends, liftK) {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const segs = new Uint8Array(count);
  let total = 0;
  for (let k = 0; k < count; k++) {
    ends(k, a, b);
    const dLat = (b[1] - a[1]) * D2R;
    const dLon = (b[0] - a[0]) * D2R;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
    const ang = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    segs[k] = Math.max(1, Math.min(16, Math.ceil(ang / (4 * D2R))));
    total += segs[k] + 1;
  }
  const path = new Float32Array(total * 3);
  const startIndices = new Uint32Array(count);
  let v = 0;
  for (let k = 0; k < count; k++) {
    ends(k, a, b);
    startIndices[k] = v;
    const n = segs[k];
    const la0 = a[1] * D2R, lo0 = a[0] * D2R, la1 = b[1] * D2R, lo1 = b[0] * D2R;
    const x0 = Math.cos(la0) * Math.cos(lo0), y0 = Math.cos(la0) * Math.sin(lo0), z0 = Math.sin(la0);
    const x1 = Math.cos(la1) * Math.cos(lo1), y1 = Math.cos(la1) * Math.sin(lo1), z1 = Math.sin(la1);
    const ang = Math.acos(Math.max(-1, Math.min(1, x0 * x1 + y0 * y1 + z0 * z1)));
    const lift = Math.min(ang * 6.371e6 * liftK, 250e3);
    const so = Math.sin(ang);
    let prevLon = a[0];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      let x, y, z;
      if (so < 1e-6) {
        x = x0 + (x1 - x0) * t; y = y0 + (y1 - y0) * t; z = z0 + (z1 - z0) * t;
      } else {
        const w0 = Math.sin((1 - t) * ang) / so;
        const w1 = Math.sin(t * ang) / so;
        x = w0 * x0 + w1 * x1; y = w0 * y0 + w1 * y1; z = w0 * z0 + w1 * z1;
      }
      let lon = Math.atan2(y, x) / D2R;
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
      prevLon = lon;
      path[3 * v] = lon;
      path[3 * v + 1] = Math.atan2(z, Math.hypot(x, y)) / D2R;
      path[3 * v + 2] = a[2] + (b[2] - a[2]) * t + lift * Math.sin(Math.PI * t);
      v++;
    }
  }
  return { length: count, startIndices, attributes: { getPath: { value: path, size: 3 } } };
}

// Links of every length, across the antimeridian, zero-length and antipodal.
function sampleEnds(n) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const e = new Float64Array(6 * n);
  for (let k = 0; k < n; k++) {
    e.set([rnd() * 360 - 180, rnd() * 170 - 85, rnd() * 7e5, rnd() * 360 - 180, rnd() * 170 - 85, rnd() * 7e5], 6 * k);
  }
  e.set([179.5, 10, 0, -179.5, 12, 1e5], 0); // across the antimeridian
  e.set([2, 48, 0, 2, 48, 0], 6); // zero length
  e.set([0, 0, 0, 180, 0, 0], 12); // antipodal
  e.set([2.35, 48.85, 0, 2.4, 48.9, 3e5], 18); // short
  return e;
}
const at = (e) => (k, a, b) => {
  for (let i = 0; i < 3; i++) (a[i] = e[6 * k + i]), (b[i] = e[6 * k + 3 + i]);
};

test('fine arcs: bit for bit the old builder', () => {
  const e = sampleEnds(500);
  const got = buildArcs(e, 0.03);
  const want = oldBuildArcs(500, at(e), 0.03);
  assert.equal(got.length, 500);
  assert.deepEqual(got.startIndices, want.startIndices);
  assert.deepEqual(got.attributes.getPath.value, want.attributes.getPath.value);
});

test('segments: 4° each up to 16, or 12° up to 12 for coarse links', () => {
  assert.equal(arcSegments(0, FINE), 1);
  assert.equal(arcSegments(10 * D2R, FINE), 3);
  assert.equal(arcSegments(170 * D2R, FINE), 16);
  assert.equal(arcSegments(10 * D2R, COARSE), 1);
  assert.equal(arcSegments(30 * D2R, COARSE), 3);
  assert.equal(arcSegments(170 * D2R, COARSE), 12);
  const e = sampleEnds(200);
  const coarse = new Uint8Array(200).fill(1);
  coarse[3] = 0;
  const fine = arcSegmentCounts(e, 0, 200, null);
  const some = arcSegmentCounts(e, 0, 200, coarse);
  assert.equal(some[3], fine[3]);
  for (let k = 0; k < 200; k++) assert.ok(some[k] <= fine[k]);
  assert.ok(some.reduce((s, x) => s + x, 0) < fine.reduce((s, x) => s + x, 0) * 0.75);
});

test('coarse arcs keep their ends and stay continuous across the antimeridian', () => {
  const e = sampleEnds(50);
  const coarse = new Uint8Array(50).fill(1);
  const { startIndices, attributes } = buildArcs(e, 0.03, { coarse });
  const p = attributes.getPath.value;
  for (let k = 0; k < 50; k++) {
    const s = startIndices[k];
    const end = (k + 1 < 50 ? startIndices[k + 1] : p.length / 3) - 1;
    assert.ok(Math.abs(p[3 * s + 1] - e[6 * k + 1]) < 1e-4, `link ${k} starts at its first end`);
    assert.ok(Math.abs(p[3 * end + 1] - e[6 * k + 4]) < 1e-4, `link ${k} ends at its second end`);
    assert.ok(Math.abs(p[3 * end + 2] - e[6 * k + 5]) < 1, `link ${k} ends at its second end's altitude`);
    for (let v = s + 1; v <= end; v++) assert.ok(Math.abs(p[3 * v] - p[3 * v - 3]) <= 180);
  }
});

test('chunks: cover every link once, each about the budget', () => {
  const segs = Uint8Array.from({ length: 1000 }, (_, k) => 1 + (k % 16));
  const ranges = chunkRanges(segs, 500);
  assert.equal(ranges[0][0], 0);
  assert.equal(ranges.at(-1)[1], 1000);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1]);
  for (const [from, to] of ranges.slice(0, -1)) {
    let v = 0;
    for (let k = from; k < to; k++) v += segs[k] + 1;
    assert.ok(v >= 500 && v < 500 + 17);
  }
  assert.deepEqual(chunkRanges(new Uint8Array(0), 500), []);
  assert.deepEqual(chunkRanges(Uint8Array.of(3, 3), 500), [[0, 2]]);
});

test('arcs in chunks: the same as all at once', () => {
  const e = sampleEnds(800);
  const coarse = Uint8Array.from({ length: 800 }, (_, k) => k % 3 && 1);
  const whole = buildArcs(e, 0.03, { coarse });
  const chunks = [];
  arcChunks(e, 0.03, { coarse, budget: 700 }, (c) => chunks.push(c));
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.total === chunks.length));
  let v = 0;
  for (const c of chunks) {
    for (let j = 0; j < c.to - c.from; j++) assert.equal(c.startIndices[j] + v, whole.startIndices[c.from + j]);
    assert.deepEqual(c.path, whole.attributes.getPath.value.subarray(3 * v, 3 * v + c.path.length));
    v += c.path.length / 3;
  }
  assert.equal(v * 3, whole.attributes.getPath.value.length);
});

test('per-vertex values: every vertex of a path gets the path values', () => {
  const startIndices = Uint32Array.of(0, 2, 5);
  const got = perVertex(startIndices, 7, Uint8ClampedArray.of(1, 2, 3, 4, 5, 6), 2);
  assert.deepEqual([...got], [1, 2, 1, 2, 3, 4, 3, 4, 3, 4, 5, 6, 5, 6]);
  assert.deepEqual([...perVertex(Uint32Array.of(0), 3, Float32Array.of(0.5), 1)], [0.5, 0.5, 0.5]);
  const rgba = perVertex(Uint32Array.of(0, 1), 3, Uint8ClampedArray.of(1, 2, 3, 4, 250, 251, 252, 253), 4);
  assert.ok(rgba instanceof Uint8ClampedArray);
  assert.deepEqual([...rgba], [1, 2, 3, 4, 250, 251, 252, 253, 250, 251, 252, 253]);
  const xyz = perVertex(Uint32Array.of(0, 2), 3, Float32Array.of(1, 2, 3, 4, 5, 6), 3);
  assert.deepEqual([...xyz], [1, 2, 3, 1, 2, 3, 4, 5, 6]);
});
