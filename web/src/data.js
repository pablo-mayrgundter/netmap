// Loading a map bundle written by `netmap build` (see pipeline/netmap/export.py).

const TYPED = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
};

export async function listDatasets(base) {
  const r = await fetch(`${base}/datasets.json`);
  if (!r.ok) return [];
  return r.json();
}

export async function loadBundle(base, id) {
  const root = `${base}/${id}`;
  const meta = await (await fetch(`${root}/meta.json`)).json();
  const [buf, names] = await Promise.all([
    fetch(`${root}/graph.bin`).then((r) => r.arrayBuffer()),
    fetch(`${root}/names.json`).then((r) => r.json()),
  ]);
  const a = {};
  for (const [key, s] of Object.entries(meta.sections)) {
    a[key] = new TYPED[s.dtype](buf, s.offset, s.length);
  }
  const n = meta.counts.nodes;
  const e = meta.counts.edges;

  // CSR adjacency for neighbour lookups.
  const deg = new Uint32Array(n + 1);
  for (let i = 0; i < e; i++) {
    deg[a.edges[2 * i] + 1]++;
    deg[a.edges[2 * i + 1] + 1]++;
  }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adj = new Uint32Array(2 * e);
  const adjEdge = new Uint32Array(2 * e);
  const fill = deg.slice(0, n);
  for (let i = 0; i < e; i++) {
    const s = a.edges[2 * i];
    const d = a.edges[2 * i + 1];
    adj[fill[s]] = d;
    adjEdge[fill[s]++] = i;
    adj[fill[d]] = s;
    adjEdge[fill[d]++] = i;
  }

  const byAsn = new Map();
  for (let i = 0; i < n; i++) byAsn.set(a.asn[i], i);

  const infoCache = new Map();
  async function info(i) {
    const k = Math.floor(i / meta.info_chunk);
    if (!infoCache.has(k)) {
      infoCache.set(k, fetch(`${root}/info/${k}.json`).then((r) => r.json()));
    }
    return (await infoCache.get(k))[i - k * meta.info_chunk];
  }

  function neighbours(i) {
    const out = [];
    for (let p = deg[i]; p < deg[i + 1]; p++) out.push({ node: adj[p], edge: adjEdge[p] });
    return out;
  }

  return { id, root, meta, names, n, e, ...a, byAsn, info, neighbours };
}
