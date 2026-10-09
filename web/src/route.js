// Paths between waypoints, the way BGP would route them.
//
// A route is valley-free (Gao-Rexford): it climbs customer -> provider links,
// crosses at most one peering link, then descends provider -> customer. Links
// inside one network (router maps' intra-AS backbone) can appear anywhere.
// This is a BFS over (node, phase) states: phase 0 may still climb, phase 1
// only descends. If the data has no valley-free route, the plain shortest
// path is returned and flagged.

const TRANSIT = -1; // edges[2k] is the provider of edges[2k+1]
const PEER = 0;
const INTRA = 1;

// Edge k taken from u: +1 up to a provider, -1 down to a customer, 0 across.
function direction(G, k, u) {
  const rel = G.edge_rel[k];
  if (rel === TRANSIT) return G.edges[2 * k] === u ? -1 : 1;
  return rel === INTRA ? 2 : 0; // 2: same network, phase unchanged
}

function walkBack(prevState, prevEdge, end, n) {
  const edges = [];
  const nodes = [end % n];
  for (let s = end; prevState[s] >= 0; s = prevState[s]) {
    edges.push(prevEdge[s]);
    nodes.push(prevState[s] % n);
  }
  return { edges: edges.reverse(), nodes: nodes.reverse() };
}

function valleyFree(G, a, b) {
  const n = G.n;
  const prevState = new Int32Array(2 * n).fill(-2); // -2 unseen, -1 start
  const prevEdge = new Int32Array(2 * n);
  const queue = new Int32Array(2 * n);
  let head = 0;
  let tail = 0;
  queue[tail++] = a; // state = phase * n + node
  prevState[a] = -1;
  while (head < tail) {
    const s = queue[head++];
    const u = s % n;
    const phase = s >= n ? 1 : 0;
    if (u === b) return walkBack(prevState, prevEdge, s, n);
    for (const { node: v, edge: k } of G.neighbours(u)) {
      const d = direction(G, k, u);
      let next;
      if (d === 2) next = phase;
      else if (d === 1) next = phase === 0 ? 0 : -1; // up: only while climbing
      else if (d === 0) next = phase === 0 ? 1 : -1; // one peering link, at the top
      else next = 1; // down
      if (next < 0) continue;
      const t = next * n + v;
      if (prevState[t] !== -2) continue;
      prevState[t] = s;
      prevEdge[t] = k;
      queue[tail++] = t;
    }
  }
  return null;
}

function shortest(G, a, b) {
  const n = G.n;
  const prevState = new Int32Array(n).fill(-2);
  const prevEdge = new Int32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  queue[tail++] = a;
  prevState[a] = -1;
  while (head < tail) {
    const u = queue[head++];
    if (u === b) return walkBack(prevState, prevEdge, u, n);
    for (const { node: v, edge: k } of G.neighbours(u)) {
      if (prevState[v] !== -2) continue;
      prevState[v] = u;
      prevEdge[v] = k;
      queue[tail++] = v;
    }
  }
  return null;
}

/** Route from a to b: { edges, nodes, valleyFree } or null if unreachable. */
export function route(G, a, b) {
  if (a === b) return { edges: [], nodes: [a], valleyFree: true };
  const vf = valleyFree(G, a, b);
  if (vf) return { ...vf, valleyFree: true };
  const sp = shortest(G, a, b);
  return sp ? { ...sp, valleyFree: false } : null;
}
