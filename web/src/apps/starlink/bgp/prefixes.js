// CIDR prefixes for the BGP looking glass: parsing and printing IPv4 and
// IPv6, the Starlink geofeed's prefix -> PoP table (prefixes.json, README
// "Starlink data") with longest-prefix match, and the short list of covering
// blocks RIS Live is subscribed to for withdrawals. DOM-free; addresses are
// BigInts so v4 and v6 share the code.

const BITS = { 4: 32, 6: 128 };

/** "192.0.2.0/24" -> { v: 4, addr: BigInt (the network, host bits cleared), len }, or null. */
export function parseCidr(s) {
  if (typeof s !== 'string') return null;
  const slash = s.indexOf('/');
  const ip = slash < 0 ? s : s.slice(0, slash);
  const parsed = ip.includes(':') ? parseV6(ip) : parseV4(ip);
  if (parsed === null) return null;
  const v = ip.includes(':') ? 6 : 4;
  const len = slash < 0 ? BITS[v] : Number(s.slice(slash + 1));
  if (!Number.isInteger(len) || len < 0 || len > BITS[v] || (slash >= 0 && !/^\d{1,3}$/.test(s.slice(slash + 1)))) return null;
  return { v, addr: parsed & mask(v, len), len };
}

function parseV4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let a = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    a = (a << 8n) | BigInt(Number(p));
  }
  return a;
}

function parseV6(ip) {
  // an embedded IPv4 tail (::ffff:192.0.2.1) becomes two groups
  const lastColon = ip.lastIndexOf(':');
  const last = ip.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (v4 === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const words = (h) => (h === '' ? [] : h.split(':'));
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const n = head.length + rest.length;
  if (halves.length === 1 ? n !== 8 : n > 7) return null;
  let a = 0n;
  for (const w of [...head, ...Array(8 - n).fill('0'), ...rest]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return null;
    a = (a << 16n) | BigInt(parseInt(w, 16));
  }
  return a;
}

const mask = (v, len) => {
  const bits = BigInt(BITS[v]);
  const all = (1n << bits) - 1n;
  return len === 0 ? 0n : (all >> (bits - BigInt(len))) << (bits - BigInt(len));
};
const lastAddr = (p) => p.addr | (((1n << BigInt(BITS[p.v])) - 1n) ^ mask(p.v, p.len));

/** The canonical string of a parsed prefix (IPv6 with the longest zero run as ::). */
export function formatCidr({ v, addr, len }) {
  if (v === 4) return `${[24n, 16n, 8n, 0n].map((s) => Number((addr >> s) & 255n)).join('.')}/${len}`;
  const w = [];
  for (let s = 112n; s >= 0n; s -= 16n) w.push(Number((addr >> s) & 0xffffn));
  let best = -1, bestLen = 1; // compress a run of 2 or more zero groups
  for (let i = 0; i < 8; ) {
    if (w[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > bestLen) (best = i), (bestLen = j - i);
    i = j;
  }
  const hex = (a) => a.map((x) => x.toString(16)).join(':');
  const s = best < 0 ? hex(w) : `${hex(w.slice(0, best))}::${hex(w.slice(best + bestLen))}`;
  return `${s}/${len}`;
}

/** Does prefix a contain prefix b (both parsed)? */
export const contains = (a, b) => a.v === b.v && a.len <= b.len && (b.addr & mask(a.v, a.len)) === a.addr;

/**
 * The geofeed's table (prefixes.json: { pops, regions, prefix, pop, region })
 * with lookup(cidr): the feed row that contains the prefix (longest match),
 * or else the rows it covers (an announced /23 over two feed /24s), as
 * { kind: 'within' | 'covers', prefix, pop, pops: [{ code, n }], place, rows }.
 * `pop` is the PoP code (most rows first when it covers several; null if
 * none), `place` the feed's [country, region, city] or null. null when
 * the prefix isn't in the feed at all.
 */
export function createPrefixTable(json) {
  const pops = json?.pops ?? [];
  const regions = json?.regions ?? [];
  const rows = [];
  const exact = { 4: new Map(), 6: new Map() }; // len -> Map(addr -> row)
  for (let k = 0; k < (json?.prefix?.length ?? 0); k++) {
    const p = parseCidr(json.prefix[k]);
    if (!p) continue;
    const row = { k, p, cidr: json.prefix[k], pop: json.pop?.[k] >= 0 ? pops[json.pop[k]] ?? null : null, place: json.region?.[k] >= 0 ? regions[json.region[k]] ?? null : null };
    rows.push(row);
    const byLen = exact[p.v];
    if (!byLen.has(p.len)) byLen.set(p.len, new Map());
    byLen.get(p.len).set(p.addr, row);
  }
  const lens = { 4: [...exact[4].keys()].sort((a, b) => b - a), 6: [...exact[6].keys()].sort((a, b) => b - a) };
  const sorted = { 4: rows.filter((r) => r.p.v === 4), 6: rows.filter((r) => r.p.v === 6) };
  for (const v of [4, 6]) sorted[v].sort((a, b) => (a.p.addr < b.p.addr ? -1 : a.p.addr > b.p.addr ? 1 : a.p.len - b.p.len));

  const summarise = (kind, hit, found) => {
    const n = new Map();
    for (const r of found) if (r.pop) n.set(r.pop, (n.get(r.pop) ?? 0) + 1);
    const list = [...n].map(([code, c]) => ({ code, n: c })).sort((a, b) => b.n - a.n || (a.code < b.code ? -1 : 1));
    return { kind, prefix: hit, pop: list[0]?.code ?? null, pops: list, place: found.find((r) => r.place)?.place ?? null, rows: found.length };
  };

  function lookup(cidr) {
    const p = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
    if (!p) return null;
    for (const len of lens[p.v]) {
      if (len > p.len) continue;
      const row = exact[p.v].get(len).get(p.addr & mask(p.v, len));
      if (row) return summarise('within', row.cidr, [row]);
    }
    // the feed rows inside p: binary search for the first starting at or after p
    const list = sorted[p.v];
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].p.addr < p.addr) lo = mid + 1;
      else hi = mid;
    }
    const end = lastAddr(p);
    const found = [];
    for (let i = lo; i < list.length && list[i].p.addr <= end; i++) if (contains(p, list[i].p)) found.push(list[i]);
    return found.length ? summarise('covers', formatCidr(p), found) : null;
  }

  return { lookup, size: rows.length, prefixes: () => rows.map((r) => r.cidr) };
}

/**
 * The few blocks that cover `prefixes` (strings), for a RIS Live prefix
 * subscription: each cut to at most /maxV4 or /maxV6, then the contained
 * ones dropped and siblings merged. Sorted, IPv4 first.
 */
export function coverPrefixes(prefixes, { maxV4 = 16, maxV6 = 32 } = {}) {
  const out = [];
  for (const v of [4, 6]) {
    const max = v === 4 ? maxV4 : maxV6;
    const seen = new Map();
    for (const s of prefixes) {
      const p = parseCidr(s);
      if (!p || p.v !== v) continue;
      const len = Math.min(p.len, max);
      const q = { v, addr: p.addr & mask(v, len), len };
      seen.set(`${q.addr}/${len}`, q);
    }
    let list = [...seen.values()].sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : a.len - b.len));
    // drop the contained, then merge sibling pairs until nothing changes
    for (let changed = true; changed; ) {
      changed = false;
      const kept = [];
      for (const p of list) {
        const prev = kept[kept.length - 1];
        if (prev && contains(prev, p)) continue;
        if (prev && prev.len === p.len && p.len > 0) {
          const parent = { v, addr: prev.addr & mask(v, p.len - 1), len: p.len - 1 };
          if (contains(parent, p) && parent.addr === prev.addr && prev.addr !== p.addr) {
            kept[kept.length - 1] = parent;
            changed = true;
            continue;
          }
        }
        kept.push(p);
      }
      list = kept;
    }
    out.push(...list.map(formatCidr));
  }
  return out;
}
