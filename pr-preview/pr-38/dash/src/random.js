// Small deterministic PRNG helpers, mirrored bit for bit in bizdash/demo.py so
// the browser demo and `bizdash serve --demo` produce the same numbers.
// Only integer ops, +, *, / and Math.sqrt are used on purpose: those are
// correctly rounded in IEEE 754 in both languages, where exp/sin/log are not
// guaranteed to agree in the last bit.

/** FNV-1a over the UTF-16 code units of `s` (ASCII seeds only, for parity). */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a uniform [0, 1) generator seeded from a string. */
export function rng(seed) {
  let a = fnv1a(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An approximately Poisson count with this mean, from four uniforms (no exp). */
export function countAround(r, mean) {
  if (mean <= 0) return 0;
  const u = r() + r() + r() + r() - 2;          // mean 0, variance 1/3
  return Math.max(0, Math.floor(mean + u * Math.sqrt(3 * mean) + 0.5));
}

/** Weighted pick from [[value, weight], ...]. */
export function pick(r, table) {
  let total = 0;
  for (const [, w] of table) total += w;
  let x = r() * total;
  for (const [v, w] of table) { x -= w; if (x < 0) return v; }
  return table[table.length - 1][0];
}
