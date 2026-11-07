// IPv4 and IPv6 addresses and prefixes, and a longest-prefix-match table over
// the pipeline's prefixes.json (README, "Starlink data"). DOM-free, so node's
// tests import it. Addresses are BigInts (v4 too), so both families share
// one code path.

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** { v: 4|6, n: BigInt } of an address, or null. Accepts "a.b.c.d", IPv6 (with ::, and a trailing dotted quad). */
export function parseIp(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  const m = s.match(V4);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    return { v: 4, n: BigInt(((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) };
  }
  if (!s.includes(':') || /[^0-9a-fA-F:.]/.test(s)) return null;
  let words = [];
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h) => {
    if (h === '') return [];
    const out = [];
    for (const w of h.split(':')) {
      if (w.includes('.')) {
        const q = parseIp(w);
        if (!q || q.v !== 4) return null;
        out.push(Number(q.n >> 16n), Number(q.n & 0xffffn));
      } else if (/^[0-9a-fA-F]{1,4}$/.test(w)) out.push(parseInt(w, 16));
      else return null;
    }
    return out;
  };
  const a = part(halves[0]);
  const b = halves.length === 2 ? part(halves[1]) : [];
  if (!a || !b) return null;
  if (halves.length === 2) {
    if (a.length + b.length > 7) return null;
    words = [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  } else words = a;
  if (words.length !== 8) return null;
  let n = 0n;
  for (const w of words) n = (n << 16n) | BigInt(w);
  return { v: 6, n };
}

const bitsOf = (v) => (v === 4 ? 32 : 128);
const maskOf = (v, len) => (len === 0 ? 0n : ((1n << BigInt(len)) - 1n) << BigInt(bitsOf(v) - len));

/** { v, n (the network), len } of "addr/len" (host bits cleared), or of a bare address as a host prefix; null if malformed. */
export function parseCidr(text) {
  if (typeof text !== 'string') return null;
  const [a, l, extra] = text.split('/');
  if (extra !== undefined) return null;
  const ip = parseIp(a);
  if (!ip) return null;
  const len = l === undefined ? bitsOf(ip.v) : Number(l);
  if (!Number.isInteger(len) || len < 0 || len > bitsOf(ip.v) || (l !== undefined && !/^\d+$/.test(l))) return null;
  return { v: ip.v, n: ip.n & maskOf(ip.v, len), len };
}

/** Is prefix (or address) `inner` inside prefix `outer`? Both from parseCidr. */
export const within = (inner, outer) => inner.v === outer.v && inner.len >= outer.len && (inner.n & maskOf(outer.v, outer.len)) === outer.n;

/** Starlink's CGNAT side: the dish's first hop past the home router is 100.64.0.1, at the PoP. */
export const CGNAT = parseCidr('100.64.0.0/10');

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8', '0.0.0.0/8', 'fc00::/7', 'fe80::/10', '::1/128'].map(parseCidr);

/** 'cgnat' (100.64/10), 'private' (RFC 1918, ULA, link-local, loopback), 'public' or null (not an address). */
export function addressKind(text) {
  const p = parseCidr(text);
  if (!p) return null;
  if (within(p, CGNAT)) return 'cgnat';
  if (PRIVATE.some((q) => within(p, q))) return 'private';
  return 'public';
}

/**
 * A longest-prefix-match table over prefixes.json ({ prefix: [cidr], pop:
 * [int], region: [int], pops: [code], regions: [[country, region, city]] }).
 * lookup(addr|cidr) -> { row, prefix, pop (code|null), popIndex, region,
 * regionIndex } of the longest table prefix holding it, or null.
 * inside(cidr) -> the rows inside a prefix that is wider than the table's
 * (a probe's announced /22, say).
 */
export function prefixTable(table) {
  const byLen = new Map(); // `${v}/${len}` -> Map(network -> row)
  const rows = [];
  (table?.prefix ?? []).forEach((c, row) => {
    const p = parseCidr(c);
    if (!p) return;
    rows.push([p, row]);
    const k = `${p.v}/${p.len}`;
    if (!byLen.has(k)) byLen.set(k, new Map());
    byLen.get(k).set(p.n, row);
  });
  const lens = { 4: [], 6: [] };
  for (const k of byLen.keys()) {
    const [v, len] = k.split('/').map(Number);
    lens[v].push(len);
  }
  lens[4].sort((a, b) => b - a);
  lens[6].sort((a, b) => b - a);
  const rec = (row) => {
    const pi = table.pop?.[row] ?? -1;
    const ri = table.region?.[row] ?? -1;
    return {
      row,
      prefix: table.prefix[row],
      popIndex: pi,
      pop: pi >= 0 ? table.pops?.[pi] ?? null : null,
      regionIndex: ri,
      region: ri >= 0 ? table.regions?.[ri] ?? null : null,
    };
  };
  return {
    size: rows.length,
    lookup(text) {
      const p = typeof text === 'string' ? parseCidr(text) : text;
      if (!p) return null;
      for (const len of lens[p.v]) {
        if (len > p.len) continue;
        const row = byLen.get(`${p.v}/${len}`).get(p.n & maskOf(p.v, len));
        if (row !== undefined) return rec(row);
      }
      return null;
    },
    inside(text) {
      const p = typeof text === 'string' ? parseCidr(text) : text;
      if (!p) return [];
      return rows.filter(([q]) => within(q, p)).map(([, row]) => rec(row));
    },
  };
}
