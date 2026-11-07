// Shortest paths over the laser mesh: Dijkstra with a binary heap, from
// every satellite at once to the nearest way down. The sources are the
// satellites that see a gateway, each starting at its own cost of going down
// there (downlink plus backhaul); traffic that reaches one goes down at it
// (a satellite with a gateway in view doesn't pass traffic on). Then every
// satellite's path to the ground is its chain of `prev`. DOM-free.

/** An undirected graph's adjacency (CSR) from links a[e]–b[e] that are up. */
export function adjacency(n, a, b, up, m = a.length) {
  const deg = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) if (!up || up[e]) deg[a[e]]++, deg[b[e]]++;
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const fill = start.slice(0, n);
  const to = new Int32Array(start[n]);
  const edge = new Int32Array(start[n]);
  for (let e = 0; e < m; e++) {
    if (up && !up[e]) continue;
    const i = a[e], j = b[e];
    (to[fill[i]] = j), (edge[fill[i]++] = e);
    (to[fill[j]] = i), (edge[fill[j]++] = e);
  }
  return { n, start, to, edge };
}

/** A min-heap of (key, value) in typed arrays, with lazy deletion. */
class Heap {
  constructor(cap = 1024) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.size = 0;
  }
  push(key, val) {
    if (this.size === this.k.length) {
      const k = new Float64Array(this.size * 2), v = new Int32Array(this.size * 2);
      k.set(this.k), v.set(this.v);
      (this.k = k), (this.v = v);
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      (this.k[i] = this.k[p]), (this.v[i] = this.v[p]);
      i = p;
    }
    (this.k[i] = key), (this.v[i] = val);
  }
  pop() {
    const top = this.v[0], key = this.k[0];
    const k = this.k[--this.size], v = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= k) break;
      (this.k[i] = this.k[c]), (this.v[i] = this.v[c]);
      i = c;
    }
    (this.k[i] = k), (this.v[i] = v);
    this.popped = key;
    return top;
  }
}

/**
 * Dijkstra from many sources over `adj`, edge e weighing w[e]. `sources`:
 * [node, startCost] pairs. Sources are terminals: nothing is relaxed into
 * them (traffic goes down where it can). Returns { dist, prev, prevEdge,
 * root } (Float64Array / Int32Arrays of n; prev -1 at a source or where
 * unreached, root the source a node's path ends at).
 */
export function dijkstra(adj, w, sources) {
  const n = adj.n;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const root = new Int32Array(n).fill(-1);
  const terminal = new Uint8Array(n);
  const done = new Uint8Array(n);
  const h = new Heap(Math.max(16, sources.length * 2));
  for (const [s, c] of sources) {
    if (c < dist[s]) (dist[s] = c), (root[s] = s);
    terminal[s] = 1;
  }
  for (const [s] of sources) if (Number.isFinite(dist[s])) h.push(dist[s], s);
  while (h.size) {
    const u = h.pop();
    if (done[u] || h.popped > dist[u]) continue;
    done[u] = 1;
    for (let k = adj.start[u]; k < adj.start[u + 1]; k++) {
      const v = adj.to[k];
      if (terminal[v] || done[v]) continue;
      const e = adj.edge[k];
      const d = dist[u] + w[e];
      if (d < dist[v]) {
        dist[v] = d;
        prev[v] = u;
        prevEdge[v] = e;
        root[v] = root[u];
        h.push(d, v);
      }
    }
  }
  return { dist, prev, prevEdge, root };
}

/** The path from node `i` down the tree: [i, …, its root] (nodes), and the edges between. */
export function pathFrom(tree, i, max = 10000) {
  const nodes = [i], edges = [];
  let u = i;
  while (tree.prev[u] >= 0 && nodes.length < max) {
    edges.push(tree.prevEdge[u]);
    u = tree.prev[u];
    nodes.push(u);
  }
  return { nodes, edges };
}
