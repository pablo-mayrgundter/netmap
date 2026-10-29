// The 2D map's link lines: which links its LineLayer holds, and in what order.
// Apart from src/main.js so tests can import it without deck.gl or a DOM.
//
// The layer holds only the links the toggles show (#17, as #12 did for the
// globe's arcs), so a change of toggles changes its data. Its positions move
// with deck.gl attribute transitions when the layout changes, and a transition
// starts from the previous buffer by instance: an instance must stay the same
// link while one runs, or lines fly between unrelated links. So:
// - at rest, a new set of links is a new layer (a new `gen`, so a new id),
//   whose transitions start from its own positions;
// - while the layout moves, the set only grows: links newly shown go after
//   the others, and links no longer shown stay, hidden by the GPU filter.
//   Once the move has ended, the set is rebuilt to the shown links.
// - links that the move itself shows (geo to hybrid shows the fibers'
//   members) are first added at the old layout (`held`), and the layout
//   moves once deck.gl has them, so they move in with the rest.

/** The indices `k` in [0, count) with `keep(k)`, ascending. */
export function shownLinks(count, keep) {
  const out = new Uint32Array(count);
  let n = 0;
  for (let k = 0; k < count; k++) if (keep(k)) out[n++] = k;
  return out.slice(0, n);
}

/**
 * `a` followed by the members of `b` that aren't in `a` (both index arrays
 * under `count`); `a` itself when it already holds all of `b`.
 */
export function appendMissing(a, b, count) {
  const seen = new Uint8Array(count);
  for (let i = 0; i < a.length; i++) seen[a[i]] = 1;
  let extra = 0;
  for (let i = 0; i < b.length; i++) if (!seen[b[i]]) extra++;
  if (!extra) return a;
  const out = new Uint32Array(a.length + extra);
  out.set(a);
  let n = a.length;
  for (let i = 0; i < b.length; i++) if (!seen[b[i]]) out[n++] = b[i];
  return out;
}

const make = (ids, trig, sec, owner, gen) => ({ ids, data: { length: ids.length }, trig, sec, owner, gen, until: 0, held: false });

/**
 * The line set to draw, from the last one (`prev`, or null) and the links
 * shown now (`shown`, a memoised index array: the same array while the toggles
 * are unchanged). `trig` is the positions' key and `sec` the layout they are
 * at, `owner` the dataset, `live` whether `prev`'s layer is on the GPU and
 * `applied` whether it holds `prev`'s data yet, `now` and `moveMs` the clock
 * and how long a layout move lasts, `count` the links. The positions are drawn
 * at the set's `sec`, which lags the layout's while the set is `held`.
 * Returns `prev` itself when nothing changed, so deck.gl sees the same data.
 */
export function nextLineSet(prev, shown, { trig, sec, owner, live, applied, now, moveMs, count }) {
  if (!prev || prev.owner !== owner) return make(shown, trig, sec, owner, prev ? prev.gen + 1 : 0);
  if (!live) {
    // Nothing on the GPU to keep in place (the layer is new, or not drawn).
    if (prev.ids !== shown) return make(shown, trig, sec, owner, prev.gen + 1);
    return prev.trig === trig ? prev : { ...prev, trig, sec, until: 0, held: false };
  }
  if (prev.held) {
    if (!applied) return prev; // the layer doesn't have the new links yet
    prev = { ...prev, held: false };
  }
  const moving = trig !== prev.trig;
  const until = moving ? now + moveMs : prev.until;
  if (now < until) {
    const ids = appendMissing(prev.ids, shown, count);
    const data = ids === prev.ids ? prev.data : { length: ids.length };
    if (moving && ids !== prev.ids) return { ...prev, ids, data, held: true }; // at the old layout first
    if (ids === prev.ids && !moving && until === prev.until) return prev;
    return { ...prev, ids, data, trig, sec, until };
  }
  if (prev.ids !== shown) return make(shown, trig, sec, owner, prev.gen + 1);
  return prev.until ? { ...prev, until: 0 } : prev;
}
