// Which parts of an edited hash (applyHash in main.js) differ from the view's
// own permalink (hashParams), so only those apply: a changed slider leaves
// the camera and the route alone. Apart from main.js so tests can import it.

export const CAMERA_KEYS = ['lon', 'lat', 'z', 'pitch', 'bearing'];
export const ROUTE_KEYS = ['as', 'pop', 'at', 'open', 'sel', 'selpop'];
// Which PoP of each AS: hashParams writes these on router maps only.
const POP_KEYS = ['pop', 'selpop'];

/**
 * The camera and the route of `next` against `now` (URLSearchParams each).
 * On a map that isn't a router map `pop=` and `selpop=` mean nothing, so
 * they don't count: a link carrying them would otherwise reapply its route
 * on every edit.
 */
export function hashChanges(next, now, { routers = false } = {}) {
  const differs = (keys) => keys.some((k) => next.get(k) !== now.get(k));
  return {
    camera: differs(CAMERA_KEYS),
    route: differs(routers ? ROUTE_KEYS : ROUTE_KEYS.filter((k) => !POP_KEYS.includes(k))),
  };
}
