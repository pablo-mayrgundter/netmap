// The guest side of map.html's protocol, without the DOM: who may embed it,
// what it says in its hello, and how a host's view becomes deck's camera.
// Pure (no DOM, no import.meta), so `npm test` checks it in node.
//
// map.html is NetMap as a NetGL guest (portal RFC 0004 §5): a host page
// embeds it in a hidden cross-origin iframe, and its deck.gl drawing is
// recorded and replayed into the host's own WebGL2 context. This first step
// draws a whole frame for a camera the host asks for, not geometry in the
// host's 3D space:
//
//   host                                        map.html (guest)
//   netgl:ready-ack                        ◄──  netgl:ready
//   layer:hello-ack {accepted}             ◄──  layer:hello (MAP_HELLO)
//   layer:view {view: {kind: 'globe-camera',
//     lon, lat, zoom | fit, bearing, pitch,
//     width, height, timeMs, marks}}       ──►  deck draws that camera, full frame
//   replay the frame                       ◄──  netgl:batch … frame-end {viewId}
//   (sends the view again)                 ◄──  layer:invalidate (the map's data came)

import { isLocalOrigin } from './orbitsConfig.js';

/** Origins that may embed map.html in any build: exo.cafe and pablo-mayrgundter.github.io (exo's other home). */
export const MAP_HOST_ORIGINS = ['https://exo.cafe', 'https://pablo-mayrgundter.github.io'];

/** deck's globe is a sphere of this radius, metres (not WGS84). */
export const DECK_EARTH_RADIUS = 6370972;

/** What map.html says, repeated until the host acks it. */
export const MAP_HELLO = Object.freeze({
  type: 'layer:hello',
  version: 1,
  adapter: 'netmap',
  capabilities: {
    kinds: ['map'],
    frames: ['ecef'],
    // The views it honours: a globe camera, drawn full frame. RFC 0001's
    // matrix views in ECEF (3D compositing) are a later step.
    views: ['globe-camera'],
    time: true,
    anchors: false,
    marks: true,
  },
  // RFC 0004 §1: NetMap's numbers are ECEF metres, on deck's sphere.
  units: { meters: 1 },
  earth: { model: 'sphere', radius: DECK_EARTH_RADIUS },
});

/**
 * The host this page may talk to: the embedding page's origin, from
 * `location.ancestorOrigins` or else the referrer, or the `?host=` the host
 * passed, in that order of trust. It must be a built-in host, or loopback
 * while this page is itself on loopback (or a dev server). null otherwise.
 */
export function pickHostOrigin({ ancestor = null, referrer = null, hostParam = null, pageOrigin, dev = false }) {
  let origin = null;
  for (const c of [ancestor, referrer, hostParam]) {
    if (!c) continue;
    try {
      origin = new URL(c).origin;
      break;
    } catch {
      /* the next */
    }
  }
  if (!origin || origin === 'null') return null;
  if (MAP_HOST_ORIGINS.includes(origin)) return origin;
  return (dev || isLocalOrigin(pageOrigin)) && isLocalOrigin(origin) ? origin : null;
}

const num = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null);

/** The most frame a host may ask for, pixels a side. */
export const MAX_SIDE = 4096;
/** The most marks drawn. */
export const MAX_MARKS = 16;

// deck's GlobeViewport: the camera stands 1.5 viewport heights above the
// point it looks at, with a vertical field of 2·atan(1/3), and the globe's
// radius is 256 · 2^(zoom − log2(π cos lat)) / height of them.
const CAMERA_ALTITUDE = 1.5;
const zoomAdjust = (lat) => Math.log2(Math.PI * Math.cos((lat * Math.PI) / 180));

/**
 * The zoom at which deck's globe, looked at straight down from above `lat`,
 * spans `fit` of a frame `height` pixels high (1: its disc touches the top
 * and bottom).
 */
export function fitZoom(fit, height, lat = 0) {
  const t = fit / 3; // tan of the disc's half-angle; the frame's half-height is tan 1/3
  const s = t / Math.sqrt(1 + t * t);
  const r = (CAMERA_ALTITUDE * s) / (1 - s); // the globe's radius, viewport heights
  return Math.log2((r * height) / 256) + zoomAdjust(lat);
}

/**
 * A host's `layer:view` as deck's camera: { viewState, width, height,
 * timeMs, marks }, clamped to what deck's globe can draw; null if it isn't
 * a globe camera this page can honour.
 */
export function cameraOf(view) {
  if (!view || typeof view !== 'object' || view.kind !== 'globe-camera') return null;
  const width = num(view.width, 1, MAX_SIDE);
  const height = num(view.height, 1, MAX_SIDE);
  const lon = num(view.lon, -1e6, 1e6);
  const lat = num(view.lat, -89, 89);
  if (width === null || height === null || lon === null || lat === null) return null;
  const fit = num(view.fit, 0.05, 4);
  const zoom = num(view.zoom, -4, 20) ?? (fit !== null ? fitZoom(fit, Math.round(height), lat) : null);
  if (zoom === null) return null;
  const marks = [];
  for (const m of Array.isArray(view.marks) ? view.marks.slice(0, MAX_MARKS) : []) {
    const mLon = num(m?.lon, -180, 180);
    const mLat = num(m?.lat, -90, 90);
    if (mLon === null || mLat === null) continue;
    const rgb = Array.isArray(m.rgb) && m.rgb.length === 3 && m.rgb.every((c) => num(c, 0, 255) !== null) ? m.rgb.map(Math.round) : [255, 213, 74];
    marks.push({ lon: mLon, lat: mLat, rgb });
  }
  return {
    viewState: {
      longitude: ((((lon + 180) % 360) + 360) % 360) - 180,
      latitude: lat,
      zoom,
      bearing: num(view.bearing, -1e6, 1e6) ?? 0,
      pitch: num(view.pitch, 0, 60) ?? 0,
    },
    width: Math.round(width),
    height: Math.round(height),
    timeMs: num(view.timeMs, -8.64e15, 8.64e15) ?? Date.now(),
    marks,
  };
}

/** The dataset map.html draws: `?data=`'s if listed, else the first AS-level one, else the first. */
export function pickDataset(sets, wanted = null) {
  if (!Array.isArray(sets) || !sets.length) return null;
  if (wanted && sets.some((s) => s.id === wanted)) return wanted;
  return (sets.find((s) => s.kind !== 'routers') ?? sets[0]).id;
}
