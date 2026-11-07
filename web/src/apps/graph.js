// The loaded graph as apps see it (ctx.node, ctx.neighbours, ctx.dataset;
// README in this folder): by ASN, never by main.js's node indices, which
// change with every dataset. DOM-free, so node's tests import it.
//
// `G` is data.js's bundle: asn, names, degree, level, region, flags, edges,
// edge_rel, byAsn, neighbours(i), meta.

/** The node index of an ASN, or undefined. On router maps, the AS's best-connected PoP. */
export const indexOf = (G, asn) => (G ? G.byAsn.get(Number(asn)) : undefined);

/**
 * What the neighbour across link k is to node i: 'provider', 'customer' or
 * 'peer' (and 'backbone' for a router map's links inside one AS). edge_rel
 * is -1 transit (edges[2k] the provider), 0 peering, 1 intra-AS backbone.
 */
export function relOf(G, i, k) {
  const rel = G.edge_rel[k];
  if (rel === 1) return 'backbone';
  if (rel !== -1) return 'peer';
  return G.edges[2 * k] === i ? 'customer' : 'provider';
}

/** The dataset: { id, base, root, name, kind, synthetic, counts, generated }, or null while none is loaded. */
export function datasetOf(G, base) {
  if (!G) return null;
  const m = G.meta;
  return { id: G.id, base, root: G.root, name: m.name ?? G.id, kind: m.kind ?? 'as', synthetic: !!m.synthetic, counts: { ...m.counts }, generated: m.generated ?? null };
}

/**
 * A node's summary from the graph, at once (no fetch): { asn, name, degree,
 * level (0 edge .. 1 core), region, geolocated }, or null if the ASN isn't on
 * this map. ctx.info adds the details record (cone, k-core, prefixes, ...).
 */
export function nodeSummary(G, asn) {
  const i = indexOf(G, asn);
  if (i === undefined) return null;
  return {
    asn: G.asn[i],
    name: G.names[i] || `AS${G.asn[i]}`,
    degree: G.degree[i],
    level: G.level ? +G.level[i].toFixed(3) : null,
    region: G.meta.regions?.[G.region?.[i]]?.name ?? null,
    geolocated: G.flags ? (G.flags[i] & 1) === 1 : null,
  };
}

/**
 * A node's neighbours: [{ asn, name, rel, degree }], one per AS (a router
 * map's PoPs of one AS fold into the first link seen, and its own backbone is
 * left out), most links first.
 */
export function neighboursOf(G, asn) {
  const i = indexOf(G, asn);
  if (i === undefined) return [];
  const self = G.asn[i];
  const seen = new Map();
  for (const { node, edge } of G.neighbours(i)) {
    const a = G.asn[node];
    if (a === self || seen.has(a)) continue;
    seen.set(a, { asn: a, name: G.names[node] || `AS${a}`, rel: relOf(G, i, edge), degree: G.degree[node] });
  }
  return [...seen.values()].sort((x, y) => y.degree - x.degree || x.asn - y.asn);
}
