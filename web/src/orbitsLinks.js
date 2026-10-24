// The Orbits layer's cross-engine links: AS14593's node (SpaceX's Starlink)
// joined to the Starlink satellites nearest it, from the guest's anchors.
// Apart from src/orbits.js so tests can import it without portal-netgl.

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

/** The `count` anchors nearest `p` (ECEF m). */
export function nearest(anchors, p, count) {
  const d = (a) => Math.hypot(a.ecef[0] - p[0], a.ecef[1] - p[1], a.ecef[2] - p[2]);
  return anchors
    .map((a) => [d(a), a])
    .sort((u, v) => u[0] - v[0])
    .slice(0, count)
    .map(([, a]) => a);
}

/**
 * Whether the guest answers "the n anchors nearest a point" subscriptions,
 * `{near: {p: [x, y, z], n}, pattern}` (celestiary#304; proposed for RFC
 * 0001 Q15), as its `layer:hello` says under `ext['portal.anchors/1']`:
 * `near: true` (or a most-n number), or `queries: ['near', …]`. Without it,
 * netmap pulls every `norad:*` anchor once a minute and picks them itself.
 */
export function supportsNearAnchors(hello) {
  const ext = hello?.ext?.['portal.anchors/1'];
  if (!ext || typeof ext !== 'object') return false;
  return ext.near === true || (typeof ext.near === 'number' && ext.near > 0) || (Array.isArray(ext.queries) && ext.queries.includes('near'));
}

/** The subscription pattern for the `n` Starlink satellites nearest `p` (ECEF m). */
export function nearPattern(p, n) {
  return { near: { p: [p[0], p[1], p[2]], n }, pattern: 'norad:*' };
}
