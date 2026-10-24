// The Orbits layer's globe redraws: how often netmap asks deck to draw for
// the layer, and how it keeps that to one draw for each thing that changed.
//
// deck.gl draws on demand. Its animation loop checks once an animation
// frame whether anything needs a redraw (a camera move, a layer update) and
// draws once if so; `deck.redraw(reason)` with a reason draws now,
// whatever else is pending. Three things ask for draws for the layer:
//   - the clock, once a tick, so the satellites move (`soon`);
//   - a new guest frame, which portal-netgl's deck adapter draws with a
//     forced `deck.redraw('netgl guest frame')` one animation frame later;
//   - new link endpoints (the Starlink satellites joined to AS14593's node),
//     which netmap applies with `deck.setProps({layers})`.
// Before this, the clock queued a requestAnimationFrame with a forced redraw
// every tick, so while frames stalled (a slow GPU, a long guest frame on the
// main thread) the callbacks piled up and ran in one burst of 60 to 164
// draws; and the links' update and the guest frame's forced redraw were
// two draws of one frame.
//
// Measured with ?orbits_perf=1 (src/orbitsPerf.js, README "Orbits").

/** The adapter's redraw for a guest frame that has arrived (portal-netgl 0.5.0). */
export const GUEST_FRAME_REASON = 'netgl guest frame';

/**
 * @param {object} deck the globe (a deck.gl Deck)
 * @param {object} [o]
 * @param {(cb: () => void) => void} [o.raf] the animation-frame scheduler (tests)
 */
export function makeRedraws(deck, { raf = (cb) => requestAnimationFrame(cb) } = {}) {
  const stats = { draws: 0, soon: 0, soonFallback: 0, guestFrames: 0, forced: 0, folded: 0 };
  let arrived = 0; // guest frames arrived
  let drawnUpTo = 0; // ... of which a deck draw has started since (and so replayed them)
  let pending = false; // the fallback's one animation-frame callback
  let stopped = false;

  // Every deck draw, whatever its reason: deck calls this first, and the
  // adapter replays every guest frame that has arrived at the end of it.
  const previous = deck.props?.onBeforeRender ?? null;
  const onBeforeRender = (ctx) => {
    stats.draws += 1;
    drawnUpTo = arrived;
    previous?.(ctx);
  };
  deck.setProps({ onBeforeRender });

  /**
   * A draw at deck's next animation frame, through its needs-redraw flag:
   * any number of asks before then make one draw, and a draw that happens
   * first for another reason takes them with it. A deck without the flag
   * gets at most one pending animation-frame callback, dropped if deck drew
   * meanwhile.
   */
  const soon = (reason) => {
    if (stopped) return;
    stats.soon += 1;
    const lm = deck.layerManager;
    if (typeof lm?.setNeedsRedraw === 'function') {
      lm.setNeedsRedraw(reason);
      return;
    }
    if (pending) return;
    pending = true;
    stats.soonFallback += 1;
    const at = stats.draws;
    raf(() => {
      pending = false;
      if (!stopped && stats.draws === at) deck.redraw(reason);
    });
  };

  /** A guest frame arrived (the adapter's receiver, `onFrame`). */
  const frameArrived = () => {
    arrived += 1;
    stats.guestFrames += 1;
  };

  /**
   * deck as the adapter sees it: the same object but for `redraw`. Its
   * forced redraw for a guest frame becomes an ordinary needs-redraw check
   * when a deck draw since the frame arrived has already replayed it (deck's
   * loop drew first, for a camera move, the clock or the links): the frame is
   * on screen, and a second draw would only re-run it.
   */
  const redraw = (reason) => {
    if (reason === GUEST_FRAME_REASON && drawnUpTo >= arrived) {
      stats.folded += 1;
      return deck.redraw();
    }
    if (reason) stats.forced += 1;
    return deck.redraw(reason);
  };
  const host = new Proxy(deck, {
    get(target, key) {
      if (key === 'redraw') return redraw;
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (deck.props?.onBeforeRender === onBeforeRender) deck.setProps({ onBeforeRender: previous ?? (() => {}) });
  };

  return { soon, frameArrived, host, stop, stats };
}

/**
 * A key for a set of link endpoints (anchors with an id and an ECEF
 * position): equal keys draw the same lines. While the camera moves the time
 * stays on its tick, so each guest frame's anchors are the same and the
 * links need no update; each tick moves them.
 */
export function linksKey(anchors) {
  let k = '';
  for (const a of anchors) k += `${a.id}@${a.ecef[0]},${a.ecef[1]},${a.ecef[2]};`;
  return k;
}
