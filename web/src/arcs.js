// Great-circle arcs for the globe's links (main.js), as PathLayer binary data:
// interpolation between the two ends' altitudes plus a gentle sin-shaped lift.
// (deck's ArcLayer in GlobeView lofts arcs thousands of km up, so from above
// they read as radial dashes.) Pure, so the arcs worker (arcsWorker.js) runs
// the same code as the main thread.

export const D2R = Math.PI / 180;

// Degrees of arc per segment, and the most segments a link gets. Short links
// get 1-2 segments, long ones up to `max`.
export const FINE = { step: 4, max: 16 };
// Links that aren't backbone show only with backbone only off: hundreds of
// thousands of faint lines, where a 12° chord (35 km off the circle at most)
// doesn't read. It takes the full set from 4.8M vertices to 2.9M.
export const COARSE = { step: 12, max: 12 };

export function arcSegments(ang, { step, max }) {
  return Math.max(1, Math.min(max, Math.ceil(ang / (step * D2R))));
}

// The angle between two [lon, lat] ends in degrees, by haversine.
function endsAngle(lon0, lat0, lon1, lat1) {
  const dLat = (lat1 - lat0) * D2R;
  const dLon = (lon1 - lon0) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat0 * D2R) * Math.cos(lat1 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Segments per link, for links [from, to) of `ends` (6 per link: lon, lat and
// altitude of each end). `coarse[k]` set takes COARSE for link k.
export function arcSegmentCounts(ends, from, to, coarse) {
  const segs = new Uint8Array(to - from);
  for (let k = from; k < to; k++) {
    const o = 6 * k;
    segs[k - from] = arcSegments(endsAngle(ends[o], ends[o + 1], ends[o + 3], ends[o + 4]), coarse && coarse[k] ? COARSE : FINE);
  }
  return segs;
}

// The arcs of links [from, to) of `ends`: { length, startIndices,
// attributes.getPath }, a path of segs + 1 vertices per link.
export function buildArcs(ends, liftK, { from = 0, to = ends.length / 6, coarse = null, segs = null } = {}) {
  const count = to - from;
  if (!segs) segs = arcSegmentCounts(ends, from, to, coarse);
  let total = 0;
  for (let j = 0; j < count; j++) total += segs[j] + 1;
  const path = new Float32Array(total * 3);
  const startIndices = new Uint32Array(count);
  let v = 0;
  for (let j = 0; j < count; j++) {
    const o = 6 * (from + j);
    const lon0d = ends[o], lat0d = ends[o + 1], alt0 = ends[o + 2];
    const lon1d = ends[o + 3], lat1d = ends[o + 4], alt1 = ends[o + 5];
    startIndices[j] = v;
    const n = segs[j];
    const la0 = lat0d * D2R, lo0 = lon0d * D2R, la1 = lat1d * D2R, lo1 = lon1d * D2R;
    const x0 = Math.cos(la0) * Math.cos(lo0), y0 = Math.cos(la0) * Math.sin(lo0), z0 = Math.sin(la0);
    const x1 = Math.cos(la1) * Math.cos(lo1), y1 = Math.cos(la1) * Math.sin(lo1), z1 = Math.sin(la1);
    const ang = Math.acos(Math.max(-1, Math.min(1, x0 * x1 + y0 * y1 + z0 * z1)));
    const lift = Math.min(ang * 6.371e6 * liftK, 250e3);
    const so = Math.sin(ang);
    let prevLon = lon0d;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      let x, y, z;
      if (so < 1e-6) {
        x = x0 + (x1 - x0) * t; y = y0 + (y1 - y0) * t; z = z0 + (z1 - z0) * t;
      } else {
        const w0 = Math.sin((1 - t) * ang) / so;
        const w1 = Math.sin(t * ang) / so;
        x = w0 * x0 + w1 * x1; y = w0 * y0 + w1 * y1; z = w0 * z0 + w1 * z1;
      }
      let lon = Math.atan2(y, x) / D2R;
      // Keep longitudes continuous across the antimeridian.
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
      prevLon = lon;
      path[3 * v] = lon;
      path[3 * v + 1] = Math.atan2(z, Math.hypot(x, y)) / D2R;
      path[3 * v + 2] = alt0 + (alt1 - alt0) * t + lift * Math.sin(Math.PI * t);
      v++;
    }
  }
  return { length: count, startIndices, attributes: { getPath: { value: path, size: 3 } } };
}

// Cuts links [0, count) into runs of about `budget` path vertices each, so each
// run is one layer whose upload fits in a frame: [from, to) pairs.
export function chunkRanges(segs, budget) {
  const out = [];
  let from = 0;
  let verts = 0;
  for (let k = 0; k < segs.length; k++) {
    verts += segs[k] + 1;
    if (verts >= budget) {
      out.push([from, k + 1]);
      from = k + 1;
      verts = 0;
    }
  }
  if (from < segs.length) out.push([from, segs.length]);
  return out;
}

// Builds all the links of `ends` in chunks of about `budget` vertices, and
// hands each to `emit` as it's done: { from, to, total, startIndices, path }.
export function arcChunks(ends, liftK, { coarse = null, budget }, emit) {
  const count = ends.length / 6;
  const segs = arcSegmentCounts(ends, 0, count, coarse);
  const ranges = chunkRanges(segs, budget);
  for (const [from, to] of ranges) {
    const arcs = buildArcs(ends, liftK, { from, to, segs: segs.subarray(from, to) });
    emit({ from, to, total: ranges.length, startIndices: arcs.startIndices, path: arcs.attributes.getPath.value });
  }
}

// Repeats each path's `size` values (`values`, a path after another) over its
// vertices: the layout of PathLayer's instance attributes, one per vertex, so
// a chunk's colours can be handed to deck as they are instead of through its
// accessors. `verts` is the chunk's vertex count; the result is of `values`'s
// type.
export function perVertex(startIndices, verts, values, size) {
  const out = new values.constructor(verts * size);
  const n = startIndices.length;
  const end = (j) => (j + 1 < n ? startIndices[j + 1] : verts);
  if (size * values.BYTES_PER_ELEMENT === 4) {
    // a 32-bit word a vertex (RGBA bytes, one float): a native fill a path
    const o = new Uint32Array(out.buffer);
    const w = new Uint32Array(values.buffer, values.byteOffset, n);
    for (let j = 0; j < n; j++) o.fill(w[j], startIndices[j], end(j));
    return out;
  }
  for (let j = 0; j < n; j++) {
    for (let v = startIndices[j], e = end(j); v < e; v++) for (let c = 0; c < size; c++) out[v * size + c] = values[j * size + c];
  }
  return out;
}
