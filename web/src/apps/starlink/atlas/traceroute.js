// RIPE Atlas traceroutes from Starlink dishes, as paths: the dish (and the
// home router) -> the PoP's gateway (the CGNAT hop, 100.64.0.1, on IPv4) ->
// Starlink's routers -> the internet. DOM-free, so node's tests import it.

import { addressKind, parseCidr, within } from './ip.js';
import { stats } from './latency.js';
import { STARLINK_ASN } from './probes.js';

// Router space seen in Atlas traceroutes from Starlink dishes that RIPEstat's
// network-info can't name (unannounced): SpaceX's 74.244.0.0/15 (ARIN,
// "SpaceX Services") and 2620:134:b000::/40 (part announced by AS14593),
// with 206.224.64.0/18, announced by AS14593.
export const STARLINK_INFRA = ['206.224.64.0/18', '74.244.0.0/15', '2620:134:b000::/40'].map(parseCidr);
export const isStarlinkInfra = (ip) => {
  const p = parseCidr(ip);
  return !!p && STARLINK_INFRA.some((q) => within(p, q));
};

/**
 * One Atlas traceroute result as { probe, msm, ts, endtime, af, proto, dst,
 * dstAddr, from, src, reached, hops }, or null if it isn't a traceroute.
 * Each hop is { hop, ip, ips, rtts, rtt (median), lost, kind } where `ip` is
 * the address that answered most (null: no reply), `kind` its addressKind
 * ('private', 'cgnat', 'public') and `lost` the probes with no answer.
 */
export function parseTraceroute(r) {
  if (!r || r.type !== 'traceroute') return null;
  const hops = (r.result ?? []).map((h) => {
    const replies = (h.result ?? []).filter((x) => x && typeof x === 'object');
    const answered = replies.filter((x) => typeof x.from === 'string' && !x.late);
    const n = new Map();
    for (const x of answered) n.set(x.from, (n.get(x.from) ?? 0) + 1);
    let ip = null;
    for (const [a, k] of n) if (ip === null || k > n.get(ip)) ip = a;
    const rtts = answered.map((x) => x.rtt).filter(Number.isFinite);
    return {
      hop: h.hop,
      ip,
      ips: [...n.keys()],
      rtts,
      rtt: stats(rtts).median,
      lost: replies.filter((x) => x.x === '*').length,
      error: h.error ?? null,
      kind: ip ? addressKind(ip) : null,
    };
  });
  return {
    probe: r.prb_id,
    msm: r.msm_id,
    ts: r.timestamp,
    endtime: r.endtime ?? null,
    af: r.af ?? null,
    proto: r.proto ?? null,
    dst: r.dst_name ?? r.dst_addr ?? null,
    dstAddr: r.dst_addr ?? null,
    from: r.from ?? null,
    src: r.src_addr ?? null,
    reached: !!r.destination_ip_responded,
    hops,
  };
}

// Past the dish, every hop is over a satellite and back: 20 ms or more. The
// home router and the dish answer within a few ms.
export const SATELLITE_MS = 8;

/**
 * The traceroute's hops with their part of the path. `role` is
 *  * 'lan': the home network, the router and the dish;
 *  * 'pop': the first hop past the satellite, Starlink's gateway at the PoP
 *    (on IPv4 the CGNAT address 100.64.0.1; on IPv6, and on public-IP
 *    plans, the first Starlink address SATELLITE_MS or more away);
 *  * 'starlink': AS14593's routers past it;
 *  * 'internet', and 'dest' for the target.
 * `asn` is the hop's origin AS from `asnOf(ip)` (null: unknown). A hop is
 * Starlink's if its AS is 14593, or, unknown, if it's in STARLINK_INFRA or in
 * `table` (prefixTable of prefixes.json: customer space). Private addresses
 * and hops with no reply take the role the path is in.
 */
export function pathRoles(tr, { asnOf = () => null, table = null } = {}) {
  let state = 'lan';
  return tr.hops.map((h) => {
    const asn = h.ip && h.kind === 'public' ? asnOf(h.ip) ?? null : null;
    let role = state;
    if (h.kind === 'cgnat' && state === 'lan') {
      role = 'pop';
      state = 'starlink';
    } else if (h.kind === 'public') {
      const customer = !!table?.lookup(h.ip);
      const starlink = asn === STARLINK_ASN || (asn === null && (customer || isStarlinkInfra(h.ip)));
      if (h.ip === tr.dstAddr) state = role = 'dest';
      else if (state === 'lan') {
        if (starlink && customer && !(h.rtt >= SATELLITE_MS)) role = 'lan';
        else if (starlink) (role = 'pop'), (state = 'starlink');
        else state = role = 'internet';
      } else if (state === 'starlink' && !starlink) state = role = 'internet';
    }
    return { ...h, asn, role };
  });
}

/**
 * The path drawn on the map: consecutive hops merged into stops where they
 * sit at the same place. `place(hop)` -> [lon, lat] or null (unknown: the
 * hop joins the last stop). Returns [{ pos, role, hops: [hop numbers], label }].
 */
export function pathStops(hops, place) {
  const stops = [];
  for (const h of hops) {
    const pos = place(h);
    const last = stops[stops.length - 1];
    if (!pos) {
      if (last) last.hops.push(h.hop);
      continue;
    }
    if (last && last.pos[0] === pos[0] && last.pos[1] === pos[1]) {
      last.hops.push(h.hop);
      if (h.role === 'dest') last.role = 'dest';
      continue;
    }
    stops.push({ pos, role: h.role, hops: [h.hop], asn: h.asn ?? null });
  }
  return stops;
}

/** The RTT to the PoP's gateway (the dish to the ground, over the satellites), ms, or null. Takes pathRoles' hops. */
export const popRtt = (hops) => hops.find((h) => h.role === 'pop')?.rtt ?? null;
