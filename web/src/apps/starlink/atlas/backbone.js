// PoP -> PoP links inferred from RIPE Atlas traceroutes, for the backbone
// map (#31). Inferred, not published: label them so. DOM-free, so node's
// tests import it.
//
// Each traceroute's dish is behind the PoP its source address is in
// (prefixes.json). Two kinds of evidence tie it to another PoP:
//  * 'prefix': a hop in a prefix pops.csv gives to another PoP (that PoP's
//    customer gateway, x.x.x.1, on the way);
//  * 'transit': one of Starlink's routers that dishes behind two PoPs both
//    cross, and that is the first Starlink router for one of them but
//    deeper in the path for the other: traffic carried from one PoP through
//    the other;
//  * 'shared': a router that is the first past the PoP's gateway for both.
//    A router the two share, or (as the ones seen so far look, at the same
//    hop with the next hops apart) an address each PoP reuses: weak
//    evidence, `confidence` 'low'.
// Only the Starlink part of each path counts (pathRoles): past the first
// hop of another AS, routers aren't Starlink's.
//
// With the built-in measurements, traffic to the anycast root servers
// leaves at the dish's own PoP, so the root traceroutes (5001-5016,
// 6001-6016) give next to nothing. The topology traceroutes (5051, 5151,
// 6052, 6152) go to unicast targets everywhere and give the few links there
// are.

import { prefixTable } from './ip.js';
import { BUILTIN } from './api.js';
import { parseTraceroute, pathRoles } from './traceroute.js';

// The traceroutes worth feeding it: the topology ones (unicast targets)
// and the IPv6 root ones, where the shared routers show up.
export const BACKBONE_MSMS = [BUILTIN.topology[4].id, 5151, BUILTIN.topology[6].id, 6152, BUILTIN.traceroute[6].id];

/**
 * Their latest results for these probes, with atlasClient(): feed them to
 * inferPopLinks. A measurement that fails is left out.
 */
export async function backboneTraceroutes(client, probeIds, signal) {
  const got = await Promise.allSettled(BACKBONE_MSMS.map((m) => client.latest(m, probeIds, signal)));
  return got.flatMap((g) => (g.status === 'fulfilled' ? g.value : []));
}

/**
 * inferPopLinks(traceroutes, prefixes, { asnOf, minEvidence }) ->
 * [{ a, b, evidence, kinds, confidence, routers, probes, msms, ts }], most
 * evidence first, `confidence` 'low' when 'shared' is all there is. `a` < `b` are PoP codes (the link is undirected); `evidence` counts
 * the traceroutes that show it, `routers` the shared router addresses,
 * `probes` and `msms` the Atlas probe and measurement ids, `ts` the newest
 * traceroute's time (Unix s).
 *
 * `traceroutes` are Atlas traceroute results (raw, or parseTraceroute's),
 * `prefixes` prefixes.json (or its prefixTable), `asnOf(ip)` the hop's
 * origin AS if known (RIPEstat), else Starlink's routers are known by
 * STARLINK_INFRA. Links with less than `minEvidence` traceroutes are left
 * out.
 */
export function inferPopLinks(traceroutes, prefixes, { asnOf = () => null, minEvidence = 1 } = {}) {
  const table = typeof prefixes?.lookup === 'function' ? prefixes : prefixTable(prefixes);
  const links = new Map(); // "a|b" -> link
  const routers = new Map(); // ip -> Map(pop -> { trs, depth })
  const add = (p, q, tr, kind, router = null) => {
    if (!p || !q || p === q) return;
    const [a, b] = p < q ? [p, q] : [q, p];
    const k = `${a}|${b}`;
    if (!links.has(k)) links.set(k, { a, b, trs: new Set(), kinds: new Set(), routers: new Set(), probes: new Set(), msms: new Set(), ts: 0 });
    const l = links.get(k);
    l.trs.add(tr);
    l.kinds.add(kind);
    if (router) l.routers.add(router);
    l.probes.add(tr.probe);
    l.msms.add(tr.msm);
    l.ts = Math.max(l.ts, tr.ts ?? 0);
  };
  const parsed = [];
  for (const raw of traceroutes ?? []) {
    const tr = raw?.hops ? raw : parseTraceroute(raw);
    if (!tr?.from) continue;
    const home = table.lookup(tr.from)?.pop;
    if (!home) continue;
    parsed.push({ tr, home });
  }
  for (const { tr, home } of parsed) {
    let depth = 0; // Starlink routers past the PoP's gateway so far
    for (const h of pathRoles(tr, { asnOf, table })) {
      if (!h.ip || h.kind !== 'public' || (h.role !== 'starlink' && h.role !== 'pop')) continue;
      const hit = table.lookup(h.ip);
      if (hit) {
        if (hit.pop) add(home, hit.pop, tr, 'prefix');
        continue;
      }
      if (!routers.has(h.ip)) routers.set(h.ip, new Map());
      const byPop = routers.get(h.ip);
      if (!byPop.has(home)) byPop.set(home, { trs: [], depth });
      const r = byPop.get(home);
      r.trs.push(tr);
      r.depth = Math.min(r.depth, depth++);
    }
  }
  for (const [ip, byPop] of routers) {
    if (byPop.size < 2) continue;
    const pops = [...byPop.keys()];
    for (let i = 0; i < pops.length; i++)
      for (let j = i + 1; j < pops.length; j++) {
        const [p, q] = [byPop.get(pops[i]), byPop.get(pops[j])];
        const kind = p.depth === 0 && q.depth === 0 ? 'shared' : 'transit';
        for (const tr of [...p.trs, ...q.trs]) add(pops[i], pops[j], tr, kind, ip);
      }
  }
  return [...links.values()]
    .map((l) => ({
      a: l.a,
      b: l.b,
      evidence: l.trs.size,
      kinds: [...l.kinds].sort(),
      confidence: l.kinds.size === 1 && l.kinds.has('shared') ? 'low' : 'medium',
      routers: [...l.routers].sort(),
      probes: [...l.probes].sort((x, y) => x - y),
      msms: [...l.msms].sort((x, y) => x - y),
      ts: l.ts || null,
    }))
    .filter((l) => l.evidence >= minEvidence)
    .sort((x, y) => y.evidence - x.evidence || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}
