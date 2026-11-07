// Small rate tools for the live feed: a ring buffer (the feed keeps the
// newest N), a throttle (how often an update may flash on the map) and a
// sliding per-minute counter. DOM-free; time is passed in, so tests don't wait.

/** The newest `cap` items: push(x), items() newest first, size, clear(). */
export function createRing(cap) {
  if (!(cap > 0)) throw new RangeError('ring capacity must be > 0');
  const buf = new Array(cap);
  let head = 0; // the next slot to write
  let size = 0;
  return {
    push(x) {
      buf[head] = x;
      head = (head + 1) % cap;
      size = Math.min(size + 1, cap);
    },
    /** Up to `n` items, newest first. */
    items(n = size) {
      const out = [];
      for (let i = 1; i <= Math.min(n, size); i++) out.push(buf[(head - i + cap) % cap]);
      return out;
    },
    get size() {
      return size;
    },
    cap,
    clear() {
      buf.fill(undefined);
      head = size = 0;
    },
  };
}

/** allow(now): true at most once per `ms` (the first call is allowed). */
export function createThrottle(ms) {
  let last = -Infinity;
  return {
    allow(now) {
      if (now - last < ms) return false;
      last = now;
      return true;
    },
    reset() {
      last = -Infinity;
    },
  };
}

/**
 * Counts over the last `windowMs` (default a minute) in `bucketMs` buckets:
 * add(now, n = 1), total(now) the sum over the window, perMinute(now) that
 * scaled to a minute (over the time counted so far, while under a window).
 */
export function createRate({ windowMs = 60_000, bucketMs = 1000 } = {}) {
  const nb = Math.ceil(windowMs / bucketMs);
  const counts = new Float64Array(nb);
  let bucket = null; // the absolute bucket number of the newest
  let since = null; // when counting started
  const advance = (now) => {
    const b = Math.floor(now / bucketMs);
    if (bucket === null) bucket = b;
    if (b - bucket >= nb) counts.fill(0);
    else for (let k = bucket + 1; k <= b; k++) counts[k % nb] = 0;
    if (b > bucket) bucket = b;
  };
  return {
    add(now, n = 1) {
      if (since === null) since = now;
      advance(now);
      counts[Math.floor(now / bucketMs) % nb] += n;
    },
    total(now) {
      if (bucket === null) return 0;
      advance(now);
      let s = 0;
      for (const c of counts) s += c;
      return s;
    },
    /** How long it has counted, up to the window (ms). */
    span(now) {
      return since === null ? 0 : Math.min(windowMs, Math.max(now - since, 0));
    },
    perMinute(now) {
      if (since === null) return 0;
      const span = Math.min(windowMs, Math.max(now - since, bucketMs));
      return (this.total(now) * 60_000) / span;
    },
    reset() {
      counts.fill(0);
      bucket = since = null;
    },
  };
}
