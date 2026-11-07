import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacency, dijkstra, pathFrom } from './route.js';

//   0 —1— 1 —1— 2 —1— 3        terminals: 3 (down cost 1) and 5 (down cost 10)
//   |                 |
//   4 ———— 2 ———— 5 ——1
const A = Int32Array.from([0, 1, 2, 0, 4, 5]);
const B = Int32Array.from([1, 2, 3, 4, 5, 3]);
const W = Float64Array.from([1, 1, 1, 4, 2, 1]);

test('dijkstra: to the cheapest way down, terminals end paths', () => {
  const adj = adjacency(6, A, B);
  const t = dijkstra(adj, W, [[3, 1], [5, 10]]);
  // 4: by 0 to 3 costs 4 + 3 + 1 = 8; down at 5 would cost 2 + 10.
  assert.deepEqual([...t.dist], [4, 3, 2, 1, 8, 10]);
  assert.deepEqual([...t.root], [3, 3, 3, 3, 3, 5]);
  assert.deepEqual(pathFrom(t, 4).nodes, [4, 0, 1, 2, 3]);
  assert.deepEqual(pathFrom(t, 0).nodes, [0, 1, 2, 3]);
  assert.deepEqual(pathFrom(t, 0).edges, [0, 1, 2]);
  assert.deepEqual(pathFrom(t, 3).nodes, [3]);
  // Terminals aren't transit: 5 goes down itself even though 5→3 is cheaper.
  assert.equal(t.prev[5], -1);
});

test('dijkstra: links that are down are left out; unreachable nodes stay at Infinity', () => {
  const up = Uint8Array.from([1, 0, 1, 1, 1, 1]); // 1–2 down
  const adj = adjacency(6, A, B, up);
  const t = dijkstra(adj, W, [[3, 1]]);
  assert.deepEqual(pathFrom(t, 1).nodes, [1, 0, 4, 5, 3]);
  assert.equal(t.dist[1], 1 + 4 + 2 + 1 + 1);
  const cut = adjacency(6, A, B, Uint8Array.from([1, 0, 1, 0, 0, 1]));
  const u = dijkstra(cut, W, [[3, 1]]);
  assert.equal(u.dist[0], Infinity);
  assert.equal(u.root[0], -1);
});

test('dijkstra: a larger random graph agrees with Bellman-Ford', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 300, m = 1200;
  const a = new Int32Array(m), b = new Int32Array(m), w = new Float64Array(m);
  for (let e = 0; e < m; e++) (a[e] = Math.floor(rnd() * n)), (b[e] = Math.floor(rnd() * n)), (w[e] = 0.1 + rnd());
  const src = [[0, 0.5], [17, 0.2], [250, 1.5]];
  const t = dijkstra(adjacency(n, a, b), w, src);
  const d = new Float64Array(n).fill(Infinity);
  const term = new Set(src.map(([s]) => s));
  for (const [s, c] of src) d[s] = c;
  for (let it = 0; it < n; it++)
    for (let e = 0; e < m; e++)
      for (const [x, y] of [[a[e], b[e]], [b[e], a[e]]]) if (!term.has(y) && d[x] + w[e] < d[y]) d[y] = d[x] + w[e];
  for (let i = 0; i < n; i++) assert.ok(Math.abs(t.dist[i] - d[i]) < 1e-9 || (t.dist[i] === Infinity && d[i] === Infinity), `${i}`);
});
