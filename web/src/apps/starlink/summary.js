// What the Starlink app shows of AS14593 from the loaded graph. DOM-free, so
// node's tests import it.

export const STARLINK_ASN = 14593;
// The neighbours listed in full; the rest are counted.
export const LIST_MAX = 30;

/**
 * The summary: { present, asn, name, country, cone, coreness, rank, level,
 * degree, providers, customers, peers, upstreams, peering, more }, from
 * ctx.node (the graph, at once), ctx.info (the details record, fetched; null
 * while loading) and ctx.neighbours. upstreams and peering are the
 * provider and peer neighbours, most links first, up to LIST_MAX each;
 * `more` counts the ones left out.
 */
export function starlinkSummary(node, info, neighbours) {
  if (!node) return { present: false, asn: STARLINK_ASN };
  const ups = neighbours.filter((n) => n.rel === 'provider');
  const peers = neighbours.filter((n) => n.rel === 'peer');
  const count = (rel) => neighbours.filter((n) => n.rel === rel).length;
  return {
    present: true,
    asn: node.asn,
    name: info?.name || node.name,
    country: info?.country ?? null,
    cone: info?.cone ?? null,
    coreness: info?.coreness ?? null,
    rank: info?.rank ?? null,
    level: node.level,
    degree: node.degree,
    providers: info?.providers ?? ups.length,
    customers: info?.customers ?? count('customer'),
    peers: info?.peers ?? peers.length,
    upstreams: ups.slice(0, LIST_MAX),
    peering: peers.slice(0, LIST_MAX),
    more: { upstreams: Math.max(0, ups.length - LIST_MAX), peering: Math.max(0, peers.length - LIST_MAX) },
    loading: !info,
  };
}
