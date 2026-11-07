// Numbers for people, in the links section's panel and tooltips.

/** 1234.4 -> "1,234 km"; under 10 km one decimal. */
export const fmtKm = (x) => (Number.isFinite(x) ? `${x < 10 ? x.toFixed(1) : Math.round(x).toLocaleString('en-US')} km` : '—');
/** 3.456 -> "3.5 ms"; under 1 ms two decimals. */
export const fmtMs = (x) => (Number.isFinite(x) ? `${x < 1 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : Math.round(x).toLocaleString('en-US')} ms` : '—');
/** Degrees with a unit. */
export const fmtDeg = (x, d = 0) => (Number.isFinite(x) ? `${x.toFixed(d)}°` : '—');
/** lat, lon -> "38.50° N, 98.50° W". */
export function fmtLatLon(lat, lon, d = 2) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  return `${Math.abs(lat).toFixed(d)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(d)}° ${lon >= 0 ? 'E' : 'W'}`;
}
/** An age in ms -> "3 h", "9 days". */
export function fmtAge(ms) {
  if (!Number.isFinite(ms)) return '—';
  const h = ms / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

/** The `starlink.at` param "38.5,-98.5" -> { lat, lon } or null. */
export function parseAt(s) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return { lat, lon };
}
/** { lat, lon } -> "38.5,-98.5" (`d` decimals, trailing zeros dropped). */
export const atParam = (p, d = 3) => (p ? `${+p.lat.toFixed(d)},${+p.lon.toFixed(d)}` : null);
