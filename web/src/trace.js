// Pasted traceroutes -> route waypoints.
//
// Parses the common text formats (traceroute on macOS/Linux/BSD, with or
// without -n; Windows tracert; mtr --report), resolves each hop's IPv4
// address to its origin AS with the RouteViews table the pipeline writes
// (ip2asn.bin.gz), and reads location hints from router hostnames (airport
// codes like "dfw" or city names), which pick the PoP on router-level maps.

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/;
const DASHED_IP = /(?:^|[^\d])(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?:[^\d]|$)/;

function ipNum(a, b, c, d) {
  const o = [a, b, c, d].map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
export const ipText = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

// Addresses that never appear in BGP: private, CGNAT, loopback, link-local,
// multicast and reserved.
const BOGONS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
].map(([ip, bits]) => [ipNum(...ip.split('.')), bits]);
export function isBogon(n) {
  return BOGONS.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
}

/**
 * Hops from traceroute-ish text: [{ hop, ip (number|null), host }], in order.
 * A hop with no reply (* * *) has ip null and host ''. When several routers
 * answer one hop, the first is taken.
 */
export function parseTrace(text) {
  const hops = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    // hop number: "  6  host…", " 6.|-- host" (mtr), "  6    13 ms …" (tracert)
    const m = line.match(/^\s*(\d{1,3})(?:\.\|--|\.|\s)\s*(.*)$/);
    if (!m) continue;
    const hop = Number(m[1]);
    const rest = m[2];
    if (/^traceroute|^tracing/i.test(rest)) continue;
    let ip = null;
    let host = '';
    const lit = rest.match(IPV4);
    if (lit) {
      ip = ipNum(lit[1], lit[2], lit[3], lit[4]);
      // "host (ip)" or "host [ip]": the name before the bracketed address
      const named = rest.match(/([A-Za-z0-9][\w.-]*\.[A-Za-z]{2,})\s*[([]\s*\d{1,3}(?:\.\d{1,3}){3}\s*[)\]]/);
      if (named) host = named[1];
    } else {
      // mtr without -b shows only names; some names embed the address
      const name = rest.match(/([A-Za-z0-9][\w-]*(?:\.[\w-]+)*\.[A-Za-z]{2,})\b/);
      if (name) {
        host = name[1];
        const d = host.match(DASHED_IP);
        if (d) ip = ipNum(d[1], d[2], d[3], d[4]);
      }
    }
    if (hops.length && hops[hops.length - 1].hop === hop) continue; // continuation line
    hops.push({ hop, ip, host, nameOnly: ip === null && !!host });
  }
  return hops;
}

// --- lookups ---------------------------------------------------------------

let lookupsPromise = null;
/** Lazily load ip2asn.bin.gz and iata.json from the data root. */
export function loadLookups(base) {
  lookupsPromise ??= (async () => {
    const res = await fetch(`${base}/ip2asn.bin.gz`);
    if (!res.ok) throw new Error(`ip2asn.bin.gz: HTTP ${res.status}`);
    let buf = await res.arrayBuffer();
    const b = new Uint8Array(buf, 0, 2);
    if (b[0] === 0x1f && b[1] === 0x8b) {
      // not already decoded by the server
      buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    const head = new Uint8Array(buf, 0, 4);
    if (String.fromCharCode(...head) !== 'NMIP') throw new Error('ip2asn.bin.gz: bad header');
    const count = new DataView(buf).getUint32(8, true);
    const starts = new Uint32Array(buf, 12, count);
    const asns = new Uint32Array(buf, 12 + 4 * count, count);
    let iata = { codes: {}, cities: {} };
    try {
      const r = await fetch(`${base}/iata.json`);
      if (r.ok) iata = await r.json();
    } catch {
      /* hints are optional */
    }
    return { starts, asns, iata };
  })();
  lookupsPromise.catch(() => (lookupsPromise = null)); // allow a retry
  return lookupsPromise;
}

export function asnOf(L, ip) {
  let lo = 0;
  let hi = L.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (L.starts[mid] <= ip) lo = mid;
    else hi = mid - 1;
  }
  return L.starts[lo] <= ip ? L.asns[lo] : 0;
}

// Router-role words that look like airport codes (as in pipeline/netmap/iata.py).
const STOP = new Set(
  `net com org edu gov mil int biz info gin ntt bbr ccr agr rtr bdr cor core dsl cpe pop
   ipv dyn ptr res mpr hsd fbr cus srv gig ten eth vla vlan lag lan wan sfp mgt mgmt
   oob bgp isp tel pts asr mxs csr ers acc agg dis bng lns cmt olt hub dia cdn web dns
   ftp ssl tls ptp p2p atm pos ser loo tun gre lo0 xe0 ge0 et0 ae0 the and ixp nap`.split(/\s+/),
);
const TOKEN = /^([a-z]{3})(\d{1,3}(?:[a-z]{1,2}\d{0,3})?)?$/;

/** Best location hint in a router hostname: { code, lat, lon, name } or null. */
export function hostHint(host, iata) {
  if (!host || !iata) return null;
  const labels = host.toLowerCase().split('.');
  const tokens = host.toLowerCase().split(/[.\-_]/).filter(Boolean);
  const domain = new Set(labels.length >= 2 ? labels.slice(-2).join('.').split(/[.\-_]/) : []);
  let best = null;
  tokens.forEach((tok, i) => {
    if (domain.has(tok)) return;
    const city = tok.replace(/\d+$/, '');
    if (city.length >= 5 && iata.cities[city]) {
      const code = iata.cities[city];
      best = { rank: 0, code };
      return;
    }
    const m = tok.match(TOKEN);
    if (m && !STOP.has(m[1]) && iata.codes[m[1]] && (m[2] || (i > 0 && i < tokens.length - 2))) {
      const rank = m[2] ? 1 : 2;
      if (!best || rank < best.rank) best = { rank, code: m[1] };
    }
  });
  if (!best) return null;
  const [lat, lon, name] = iata.codes[best.code];
  return { code: best.code.toUpperCase(), lat, lon, name };
}

// --- resolution --------------------------------------------------------------

const nodesByAsn = new WeakMap();
function nodesOf(G, asn) {
  if (!nodesByAsn.has(G)) {
    const m = new Map();
    for (let i = 0; i < G.n; i++) {
      const a = G.asn[i];
      if (!m.has(a)) m.set(a, []);
      m.get(a).push(i);
    }
    nodesByAsn.set(G, m);
  }
  return nodesByAsn.get(G).get(asn) || [];
}

const KM = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Resolve parsed hops against a bundle. Each row gets a status — 'ok',
 * 'timeout', 'nameonly' (a hostname but no address), 'private', 'unrouted'
 * (no BGP origin) or 'missing' (an AS this map doesn't have) — and for 'ok'
 * the node: the AS on AS maps; on router maps one of the AS's PoPs: nearest
 * the hostname's location hint, else nearest the previous located hop (or
 * the next one), else the best-connected. Waypoints are the resolved nodes
 * with repeats merged.
 */
export function resolveTrace(hops, L, G) {
  const routers = G.meta.kind === 'routers';
  const near = (cands, lat, lon) => {
    let best = cands[0];
    let bestD = Infinity;
    for (const v of cands) {
      const d = KM(lat, lon, G.pos_geo[2 * v + 1], G.pos_geo[2 * v]);
      if (d < bestD) (bestD = d), (best = v);
    }
    return best;
  };
  const rows = hops.map((h) => {
    const row = { ...h, status: 'ok', asn: 0, node: -1, hint: null, cands: null };
    if (h.ip === null) return { ...row, status: h.nameOnly ? 'nameonly' : 'timeout' };
    if (isBogon(h.ip)) return { ...row, status: 'private' };
    row.asn = asnOf(L, h.ip);
    row.hint = hostHint(h.host, L.iata);
    if (!row.asn) return { ...row, status: 'unrouted' };
    const cands = nodesOf(G, row.asn);
    if (!cands.length) return { ...row, status: 'missing' };
    row.node = G.byAsn.get(row.asn);
    row.cands = cands;
    if (routers && row.hint && cands.length > 1) row.node = near(cands, row.hint.lat, row.hint.lon);
    return row;
  });
  if (routers) {
    // hops without a hint: the PoP nearest the closest located neighbour hop
    const located = rows.map((r) => r.status === 'ok' && (r.hint || r.cands.length === 1));
    const at = (r) => [G.pos_geo[2 * r.node + 1], G.pos_geo[2 * r.node]];
    rows.forEach((r, j) => {
      if (r.status !== 'ok' || located[j]) return;
      let k = j - 1;
      while (k >= 0 && !located[k]) k--;
      if (k < 0) for (k = j + 1; k < rows.length && !located[k]; k++);
      if (k >= 0 && k < rows.length) {
        r.node = near(r.cands, ...at(rows[k]));
        located[j] = true; // it now anchors the hops after it
      }
    });
  }
  for (const r of rows) delete r.cands;
  const waypoints = [];
  for (const r of rows) if (r.status === 'ok' && r.node !== waypoints[waypoints.length - 1]) waypoints.push(r.node);
  return { rows, waypoints };
}
