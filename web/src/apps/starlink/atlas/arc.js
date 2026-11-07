// Great-circle paths for lines on the globe (deck's straight lines cut
// through the Earth there). DOM-free, so node's tests import it.

const D2R = Math.PI / 180;
const R_M = 6_371_000;

/**
 * Points [lon, lat, alt] along the great circle from a to b ([lon, lat,
 * alt?]), one every `stepDeg` or so, with the altitude going from a's to b's
 * plus a lift of `lift` times the arc's length at the middle (sin-shaped).
 */
export function greatCircle(a, b, { stepDeg = 2, lift = 0 } = {}) {
  const [lon0, lat0, alt0 = 0] = a;
  const [lon1, lat1, alt1 = 0] = b;
  const v = (lon, lat) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)];
  const p = v(lon0, lat0);
  const q = v(lon1, lat1);
  const dot = Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  const ang = Math.acos(dot);
  if (ang < 1e-9) return [[lon0, lat0, alt0], [lon1, lat1, alt1]];
  const n = Math.max(1, Math.ceil(ang / (stepDeg * D2R)));
  const s = Math.sin(ang);
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const wa = Math.sin((1 - t) * ang) / s;
    const wb = Math.sin(t * ang) / s;
    const x = wa * p[0] + wb * q[0];
    const y = wa * p[1] + wb * q[1];
    const z = wa * p[2] + wb * q[2];
    const lat = Math.atan2(z, Math.hypot(x, y)) / D2R;
    const lon = Math.atan2(y, x) / D2R;
    out.push([lon, lat, alt0 + (alt1 - alt0) * t + Math.sin(Math.PI * t) * lift * ang * R_M]);
  }
  out[0] = [lon0, lat0, alt0];
  out[n] = [lon1, lat1, alt1];
  return out;
}
