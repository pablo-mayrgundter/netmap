// The Orbits layer: celestiary's satellites and space networks (Starlink,
// Iridium and its crosslinks, the Deep Space Network's live links), drawn
// into the globe's own WebGL context by celestiary itself.
//
// celestiary's layer mode (layer.html, celestiary/web#296) runs in a hidden
// cross-origin iframe. It renders with three.js into a NetGL recorder, and
// its GL calls arrive here by postMessage and replay into deck.gl's context
// right after deck draws (portal-netgl's attachNetGLDeckLayer). The guest
// draws in deck's own clip space, depth-tested against the globe, so the far
// side of the Earth hides what's behind it, and no pixels are copied.
//
//   netmap (host)                         celestiary layer.html (guest)
//   deck redraw → onAfterRender
//     replay the guest's last frame  ◄──  netgl:* calls … netgl:frame-end
//     layer:view (camera, time)      ──►  three renders one frame
//                                    ◄──  layer:anchors (DSN dishes, …)
//
// netmap owns the camera and the clock: the view carries UTC "now", rounded
// to a tick, and a timer redraws deck once a tick while the layer is on and
// the tab is visible. deck renders on demand, so without the tick the
// satellites would stand still between camera moves.

import { attachNetGLDeckLayer, iframeTransport, mat4InvertRigid, projectToPixels } from '@pablo-mayrgundter/portal-netgl';

/**
 * How long the guest's page may take to load, then to say hello once it
 * has, then to load its data, ms.
 */
export const LOAD_TIMEOUT_MS = 60_000;
export const HELLO_TIMEOUT_MS = 20_000;
export const READY_TIMEOUT_MS = 90_000;
/**
 * What the hover tooltip needs: the DSN's complexes and antennas, a few
 * dozen (`dsn:GDSCC`, `dsn:DSS-43`; RFC 0001 §8.2). A guest publishes
 * nothing until asked.
 */
export const BASE_SUBSCRIPTION = ['dsn:*'];
/** Starlink satellites joined to AS14593's node, re-picked this often, ms. */
const LINK_REPICK_MS = 60_000;

/** ECEF metres → [lng, lat, alt] on a sphere of `radius` (deck's globe). */
export function ecefToLngLatAlt([x, y, z], radius) {
  const r = Math.hypot(x, y, z);
  return [(Math.atan2(y, x) * 180) / Math.PI, (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, r - radius];
}

/** [lng, lat, alt] → ECEF metres on a sphere of `radius`. */
export function lngLatAltToEcef([lng, lat, alt], radius) {
  const l = (lng * Math.PI) / 180;
  const p = (lat * Math.PI) / 180;
  const r = radius + (alt || 0);
  return [r * Math.cos(p) * Math.cos(l), r * Math.cos(p) * Math.sin(l), r * Math.sin(p)];
}

/**
 * Start the layer: create the iframe and attach it to the globe.
 * @param {object} o
 * @param {import('@deck.gl/core').Deck} o.deck the globe
 * @param {object} o.device deck's luma device (onDeviceInitialized)
 * @param {string} o.src the guest page (orbitsConfig.resolveOrbitsSrc)
 * @param {string} o.origin its origin
 * @param {{nets: string, sats: string}} o.query what to draw
 * @param {number} o.tickMs the clock's tick
 * @param {() => number} [o.now] the clock, Unix ms UTC (default the wall clock)
 * @param {boolean} [o.live] tick (false for a stopped clock: frames only on camera moves)
 * @param {number} [o.timeoutMs] raise every timeout to at least this (slow machines, tests)
 * @param {(status: object) => void} [o.onStatus]
 * @param {(message: string) => void} [o.onFail] the layer gave up (it disposes itself first)
 * @param {() => void} [o.onAnchors] new anchors arrived
 */
export function startOrbits({ deck, device, src, origin, query, tickMs, now = Date.now, live = true, timeoutMs = 0, onStatus = () => {}, onFail = () => {}, onAnchors = () => {} }) {
  const url = new URL(src);
  url.searchParams.set('host', location.origin);
  url.searchParams.set('nets', query.nets);
  url.searchParams.set('sats', query.sats);

  // Hidden but rendering: no layout box, out of the accessibility tree and
  // the tab order. Not display:none, which Chromium may throttle a
  // cross-origin frame for (the guest draws on messages, not rAF, but its
  // timers and fetches still run there).
  const iframe = document.createElement('iframe');
  iframe.className = 'orbits-guest';
  iframe.title = 'celestiary orbits renderer (draws into the globe)';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  // Scripts and its own origin (it fetches its data from there); no
  // navigation of this page, popups, forms or downloads.
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.referrerPolicy = 'origin';
  iframe.src = url.href;
  document.body.appendChild(iframe);

  const stats = { status: 'connecting', loadedAt: 0, hello: null, ready: null, anchors: [], anchorsAt: 0, frames: 0, rejected: 0, replayErrors: 0, startedAt: performance.now(), readyAt: 0, firstFrameAt: 0 };
  let disposed = false;
  let active = true;
  let failed = false;
  const timers = new Set();
  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t) => {
    clearTimeout(t);
    timers.delete(t);
  };
  const setStatus = (status, extra = {}) => {
    stats.status = status;
    onStatus({ status, ...extra });
  };
  const fail = (message) => {
    if (failed || disposed) return;
    failed = true;
    console.warn('[orbits]', message);
    dispose();
    onFail(message);
  };

  // Pinned both ways: posts go to `origin` only, and only that window at
  // that origin is heard (portal-netgl 0.4.0).
  const transport = iframeTransport(iframe, { origin, onReject: () => (stats.rejected += 1) });

  // The clock: UTC now, rounded to the tick, so an unchanged camera between
  // ticks sends no new view and deck goes quiet until the next one.
  const clock = () => Math.floor(now() / tickMs) * tickMs;

  // Anchors: the DSN for hover, plus the Starlink satellites joined to a
  // node (setLinkTarget).
  let linkTarget = null; // { ecef, count }
  let linkIds = [];
  let linkPickAt = 0;
  let picking = false;
  let pickTries = 0;
  // The adapter keeps the subscription and re-sends it on each hello. Not
  // before the guest is up: until the frame has navigated, a post to its
  // origin is refused (and logged) by the browser.
  let up = false;
  const subscribe = () => up && layer.subscribeAnchors([...BASE_SUBSCRIPTION, ...(picking ? ['norad:*'] : linkIds)]);

  // The guest said hello (the adapter acks it) or netgl:ready: it's up, so
  // its data is loading now.
  const connected = () => {
    if (!up) {
      up = true;
      subscribe();
      if (!active || document.hidden) visibility();
    }
    cancel(helloTimer);
    if (!readyTimer && stats.status !== 'ready') readyTimer = later(T.ready, () => fail(`celestiary still loading after ${T.ready / 1000} s`));
    if (stats.status === 'connecting') setStatus('loading');
  };

  const onControl = (msg) => {
    if (msg?.type === 'layer:status') {
      if (msg.status === 'error') fail(`celestiary: ${msg.message || 'error'}`);
      else if (msg.status === 'ready') {
        cancel(readyTimer);
        stats.readyAt = performance.now();
        setStatus('ready', { partial: msg.partial || null });
      } else if (msg.status === 'loading') setStatus('loading');
    }
  };
  const anchorsArrived = (msg) => {
    stats.frames += 1;
    if (!stats.firstFrameAt) stats.firstFrameAt = performance.now();
    // RFC 0001 §8.1 names the position `p`; #296 published `ecef`.
    const anchors = (Array.isArray(msg.anchors) ? msg.anchors : []).map((a) => (a.p && !a.ecef ? { ...a, ecef: a.p } : a)).filter((a) => Array.isArray(a.ecef));
    const starlink = picking && linkTarget ? anchors.filter((a) => a.kind === 'starlink') : [];
    // A frame drawn before the guest saw the subscription has none: wait a
    // few frames for one that does.
    if (picking && linkTarget && (starlink.length || ++pickTries > 8)) {
      picking = false;
      pickTries = 0;
      linkIds = nearest(starlink, linkTarget.ecef, linkTarget.count).map((a) => a.id);
      linkPickAt = performance.now();
      subscribe();
      stats.anchors = anchors.filter((a) => !a.id.startsWith('norad:') || linkIds.includes(a.id));
    } else if (picking) {
      stats.anchors = anchors.filter((a) => !a.id.startsWith('norad:'));
    } else {
      stats.anchors = anchors;
      if (linkTarget && performance.now() - linkPickAt > LINK_REPICK_MS) {
        picking = true;
        subscribe();
      }
    }
    stats.anchorsAt = msg.timeMs;
    onAnchors();
  };

  let readyTimer = null;
  const T = { load: Math.max(LOAD_TIMEOUT_MS, timeoutMs), hello: Math.max(HELLO_TIMEOUT_MS, timeoutMs), ready: Math.max(READY_TIMEOUT_MS, timeoutMs) };
  let helloTimer = later(T.load, () => fail(`${url.host} didn't load in ${T.load / 1000} s`));
  // The first load: the page's scripts have run, so its hello is due. Any
  // later one is the frame navigating, and whatever is there now isn't the
  // guest we shook hands with (RFC 0001 §10.7, "crashed").
  let loads = 0;
  iframe.addEventListener('load', () => {
    loads += 1;
    if (loads === 1) stats.loadedAt = performance.now();
    if (loads > 1) return fail('the guest frame navigated away');
    if (layer.receiver?.ready || layer.hello) return;
    cancel(helloTimer);
    helloTimer = later(T.hello, () => fail(`no answer from ${origin} ${T.hello / 1000} s after it loaded`));
  });
  const layer = attachNetGLDeckLayer(deck, {
    device,
    transport,
    time: clock,
    onReady: (msg) => {
      stats.ready = msg;
      connected();
    },
    onHello: (msg) => {
      stats.hello = msg;
      connected();
    },
    onAnchors: anchorsArrived,
    onControl,
    onError: (err) => {
      stats.replayErrors += 1;
      console.warn('[orbits] replay error', err);
    },
  });

  // Tick while on and visible. The adapter redraws deck when a guest frame
  // arrives; this redraws once a tick so the time moves.
  let ticker = null;
  const tick = () => requestAnimationFrame(() => !disposed && active && deck.redraw('orbits clock'));
  const run = () => {
    const want = live && active && !disposed && !document.hidden;
    if (want && !ticker) ticker = setInterval(tick, tickMs);
    else if (!want && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  const visibility = () => {
    if (disposed) return;
    if (up) layer.postToGuest({ type: 'layer:visibility', state: document.hidden || !active ? 'hidden' : 'visible' });
    run();
  };
  document.addEventListener('visibilitychange', visibility);
  run();

  function dispose() {
    if (disposed) return;
    try {
      if (up) layer.postToGuest({ type: 'layer:dispose' });
    } catch {
      /* the frame may be gone */
    }
    disposed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (ticker) clearInterval(ticker);
    document.removeEventListener('visibilitychange', visibility);
    layer.detach();
    iframe.remove();
    deck.redraw('orbits off');
  }

  return {
    layer,
    iframe,
    stats,
    /** Pause (the 2D map) or resume (the globe) without reloading the guest. */
    setActive(on) {
      if (disposed || on === active) return;
      active = on;
      layer.enabled = on;
      visibility();
    },
    /** Join this many Starlink satellites, the nearest, to a point (ECEF m), or null. */
    setLinkTarget(target) {
      const had = !!linkTarget;
      linkTarget = target;
      if (!target) {
        linkIds = [];
        picking = false;
        if (had) subscribe();
      } else if (!had) {
        picking = true;
        subscribe();
      }
    },
    /** The linked Starlink anchors, in the last frame. */
    links() {
      return linkIds.length ? stats.anchors.filter((a) => linkIds.includes(a.id)) : [];
    },
    /** The globe's sphere radius, m (deck's, from the last view). */
    earthRadius() {
      return layer.lastView?.earth?.radius ?? 6370972;
    },
    /**
     * The anchor under a point on the canvas (CSS pixels), if one is within
     * `radius` and on the near side of the globe.
     */
    anchorAt(x, y, radius = 8) {
      const view = layer.lastView;
      if (!view || !stats.anchors.length) return null;
      const pr = view.pixelRatio;
      const [, vy, , vh] = view.viewport;
      const bufH = vy + vh;
      const cam = mat4InvertRigid(view.viewMatrix).slice(12, 15);
      const R = view.earth?.radius ?? 6370972;
      let best = null;
      let bestD = radius * pr;
      for (const a of stats.anchors) {
        if (!a.ecef || occluded(cam, a.ecef, R)) continue;
        const [px, py, z] = projectToPixels(view, a.ecef);
        if (!(z > -1 && z < 1)) continue;
        const d = Math.hypot(px - x * pr, py - (bufH - y * pr));
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      return best;
    },
    dispose,
    get disposed() {
      return disposed;
    },
  };
}

/** The `count` anchors nearest `p` (ECEF m). */
function nearest(anchors, p, count) {
  const d = (a) => Math.hypot(a.ecef[0] - p[0], a.ecef[1] - p[1], a.ecef[2] - p[2]);
  return anchors
    .map((a) => [d(a), a])
    .sort((u, v) => u[0] - v[0])
    .slice(0, count)
    .map(([, a]) => a);
}

/**
 * Whether the globe (a sphere of radius R, a little shrunk so points on the
 * surface count as visible) is between the camera and `p`.
 */
function occluded(cam, p, R) {
  const r = R * 0.995;
  const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const b = 2 * (cam[0] * d[0] + cam[1] * d[1] + cam[2] * d[2]);
  const c = cam[0] * cam[0] + cam[1] * cam[1] + cam[2] * cam[2] - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 && t < 1;
}
