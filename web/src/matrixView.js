// A host's camera as deck's: matrix views in ECEF (portal RFC 0001 §6), for
// a host that draws NetMap in place, under its own scene, with its own
// camera (exo.cafe's chip, at 0° N 0° E, with the map over its horizon).
//
// The host sends a view matrix from ECEF metres to its eye (metres, rigid)
// and its projection. deck draws a globe in a "common" space where the
// Earth is a sphere of 256 units, in float32 and with no offset trick, so
// a camera nearer the ground than a metre or so can't be placed there. Its
// own GlobeView switches to a flat Web Mercator viewport above zoom 12
// (below some 30 km), which does have the float64 offset mode, and so does
// this: the same switch, at the same zoom, with the host's camera exactly.
//
//   zoom ≤ 12   GlobeViewport,      common = K·(Y, −X, Z), K = 256 / R
//   zoom > 12   WebMercatorViewport, common − center = ENU metres · unitsPerMeter,
//               centred under the camera
//
// Both keep deck's own eye units (the camera 1.5 viewport heights from the
// ground, scale = 2^zoom as deck's), so its pixel sizes, zoom-dependent
// looks and culling all work as for its own views.
import { _GlobeViewport as GlobeViewport, WebMercatorViewport, View } from '@deck.gl/core';
import { DECK_EARTH_RADIUS as R } from './mapView.js';

const D2R = Math.PI / 180;
const K = 256 / R; // globe common units per metre
/** deck's GlobeView becomes a Web Mercator one above this zoom (globe-view.js). */
export const GLOBE_MAX_ZOOM = 12;
const zoomAdjust = (lat) => Math.log2(Math.PI * Math.cos(Math.max(-85.05, Math.min(85.05, lat)) * D2R));

// 4×4 matrices, column-major arrays, in float64.
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
const scale = (x, y = x, z = x) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
const translate = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** The inverse of a rigid (rotation + translation) matrix. */
export function invertRigid(m) {
  const t = [m[12], m[13], m[14]];
  const o = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  o[12] = -(o[0] * t[0] + o[4] * t[1] + o[8] * t[2]);
  o[13] = -(o[1] * t[0] + o[5] * t[1] + o[9] * t[2]);
  o[14] = -(o[2] * t[0] + o[6] * t[1] + o[10] * t[2]);
  return o;
}

/** Globe common space → ECEF metres: ECEF = (−y, x, z) / K. */
const COMMON_TO_ECEF = [0, 1 / K, 0, 0, -1 / K, 0, 0, 0, 0, 0, 1 / K, 0, 0, 0, 0, 1];

/** East-north-up at (lon, lat) on deck's sphere → ECEF metres. */
function enuToEcef(lon, lat) {
  const l = lon * D2R, p = lat * D2R;
  const [sl, cl, sp, cp] = [Math.sin(l), Math.cos(l), Math.sin(p), Math.cos(p)];
  return [-sl, cl, 0, 0, -sp * cl, -sp * sl, cp, 0, cp * cl, cp * sl, sp, 0, R * cp * cl, R * cp * sl, R * sp, 1];
}

/** A perspective with the host's field (its x and y scales) and deck's own near and far, in its eye units. */
function perspective(fx, fy, near, far) {
  return [fx, 0, 0, 0, 0, fy, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}

/**
 * Where the camera is: its ECEF position, height over deck's sphere, the
 * point under it, and the zoom deck would call that height in a frame
 * `height` pixels high (its camera stands 1.5 heights from the ground).
 */
export function cameraPlace(viewMatrix, height) {
  const c = invertRigid(viewMatrix);
  const p = [c[12], c[13], c[14]];
  const r = Math.hypot(p[0], p[1], p[2]);
  const h = Math.max(r - R, 1e-6);
  const lon = Math.atan2(p[1], p[0]) / D2R;
  const lat = Math.asin(p[2] / r) / D2R;
  const globeScale = (1.5 * height) / (h * K);
  return { position: p, h, lon, lat, globeZoom: Math.log2(globeScale) + zoomAdjust(lat) };
}

// The host's matrices go in where deck's own would be made (_initMatrices
// runs in the constructor, once the centre is known: deck freezes a
// viewport after).
class HostGlobeViewport extends GlobeViewport {
  _initMatrices(opts) {
    if (!opts.hostView) return super._initMatrices(opts);
    this.cameraPlace = opts.hostView.place;
    const { s, viewMatrix, fx, fy } = opts.hostView;
    // eye units are metres · K·s/height: the camera 1.5 from the ground.
    const view = mul(mul(mul(scale((K * s) / this.height), viewMatrix), COMMON_TO_ECEF), translate(this.center));
    return super._initMatrices({ ...opts, viewMatrix: view, projectionMatrix: perspective(fx, fy, 0.5, 1.5 + (20 * 256 * s) / this.height) });
  }
}

class HostMercatorViewport extends WebMercatorViewport {
  _initMatrices(opts) {
    if (!opts.hostView) return super._initMatrices(opts);
    this.cameraPlace = opts.hostView.place;
    const { s, viewMatrix, fx, fy, lon, lat } = opts.hostView;
    const [ux, uy, uz] = this.distanceScales.unitsPerMeter;
    // (common − center) → ENU metres → ECEF → the host's eye → deck's eye units.
    const view = mul(mul(mul(scale((uz * s) / this.height), viewMatrix), enuToEcef(lon, lat)), scale(1 / ux, 1 / uy, 1 / uz));
    // A flat map to its far edge: 10⁹ camera heights, 10,000 km from 1 cm up.
    return super._initMatrices({ ...opts, viewMatrix: view, projectionMatrix: perspective(fx, fy, 0.5, 1.5e9) });
  }
}

/**
 * deck's viewport for a host's matrix view: { viewMatrix (ECEF → eye,
 * column-major), projectionMatrix, width, height }. A globe at zoom 12 or
 * under, a Web Mercator one centred under the camera above.
 */
export function matrixViewport({ viewMatrix, projectionMatrix, width, height, resolution = 5 }) {
  const place = cameraPlace(viewMatrix, height);
  const { h, lon, lat } = place;
  const [fx, fy] = [projectionMatrix[0], projectionMatrix[5]];
  const fovy = (2 * Math.atan(1 / fy)) / D2R;
  if (place.globeZoom <= GLOBE_MAX_ZOOM) {
    const s = (1.5 * height) / (h * K);
    return new HostGlobeViewport({ width, height, longitude: lon, latitude: lat, zoom: place.globeZoom, fovy, resolution,
      hostView: { place, s, viewMatrix, fx, fy } });
  }
  const probe = new WebMercatorViewport({ width, height, longitude: lon, latitude: lat, zoom: 0 });
  const s = (1.5 * height) / (h * probe.distanceScales.unitsPerMeter[2]);
  return new HostMercatorViewport({ width, height, longitude: lon, latitude: lat, zoom: Math.log2(s), fovy,
    hostView: { place, s, viewMatrix, fx, fy, lon, lat } });
}

/**
 * The graticule's lines near a camera low over the map, densified: within
 * `reach` metres of the point under it, each 10° line of longitude and
 * latitude as a path whose points space out geometrically from the camera's
 * nearest point on it (a few camera heights apart near, kilometres far).
 * deck can't draw the graticule's own 2°-long segments from a few metres up
 * (they run far behind the camera), and these are what show from the chip:
 * the equator and the prime meridian running off to the horizon.
 * @returns {Array<{path: Array<[number, number]>, major: boolean}>}
 */
export function nearGraticule(lon, lat, h, reach = Math.min(2e6, h * 1e5)) {
  const mPerDeg = (R * Math.PI) / 180;
  const reachLat = reach / mPerDeg;
  const reachLon = reach / (mPerDeg * Math.max(Math.cos(lat * D2R), 0.05));
  // Offsets from the nearest point, in metres: 0, then ×1.25 from h/4 to the reach.
  const steps = [0];
  for (let d = Math.max(h / 4, 0.001); d < reach; d *= 1.25) steps.push(d);
  steps.push(reach);
  const along = [...steps.slice(1).reverse().map((d) => -d), ...steps];
  const lines = [];
  for (let k = Math.ceil((lon - reachLon) / 10); k * 10 <= lon + reachLon; k++) {
    const l = k * 10;
    if (l < -180 || l > 180) continue;
    lines.push({ path: along.map((d) => [l, Math.max(-85, Math.min(85, lat + d / mPerDeg))]), major: l % 30 === 0 });
  }
  for (let k = Math.ceil((lat - reachLat) / 10); k * 10 <= lat + reachLat; k++) {
    const p = k * 10;
    if (p < -80 || p > 80) continue;
    const perDeg = mPerDeg * Math.max(Math.cos(p * D2R), 0.05);
    lines.push({ path: along.map((d) => [lon + d / perDeg, p]), major: p % 30 === 0 });
  }
  return lines;
}

/**
 * How far the sphere falls away below the tangent plane at (lon0, lat0), at
 * (lon, lat): R (1 − cos θ). On deck's flat viewport, low over the map,
 * what's lifted off the ground (the network's links, at up to 700 km) is
 * lowered by it, so it stands where it would over the sphere and sinks
 * below the flat ground beyond the horizon, as on the Earth.
 */
export function curvatureDrop(lon0, lat0, lon, lat) {
  const p0 = lat0 * D2R, p1 = lat * D2R, dl = (lon - lon0) * D2R;
  const c = Math.sin(p0) * Math.sin(p1) + Math.cos(p0) * Math.cos(p1) * Math.cos(dl);
  return R * (1 - Math.max(-1, Math.min(1, c)));
}

/** A deck View that makes its viewport from the view state's matrices (matrixViewport). */
export class MatrixView extends View {
  constructor(props = {}) {
    // As GlobeView's: the globe's far side culled.
    super({ ...props, parameters: { cullMode: 'back', ...props.parameters } });
  }

  makeViewport({ width, height, viewState }) {
    if (!width || !height || !viewState?.viewMatrix) return null;
    return matrixViewport({ ...viewState, width, height, resolution: this.props.resolution });
  }
}
MatrixView.displayName = 'MatrixView';
