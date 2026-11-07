// The one way anything on the page talks to GA: core cards and plugins alike.
//
// createGA() wraps a transport (direct, server or demo) with:
//   - a response cache keyed by method and body, with in-flight sharing, so two
//     cards asking the same question cost one request;
//   - a cap on requests in flight (GA4 limits concurrent Data API requests per
//     property, and a range load fans out well past it);
//   - retry with backoff for the one 429 that clears by itself (concurrency),
//     never for the hourly or daily token quotas;
//   - the latest propertyQuota GA reported, for the footer.

import { gaRows } from "./rows.js";

export const API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const REALTIME = "runRealtimeReport";

const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));

export class GAError extends Error {
  constructor(method, status, message) {
    super(`GA4 ${method}: ${message} (HTTP ${status})`);
    this.status = status;
    this.method = method;
    this.reason = message;
  }
}

function errorMessage(text) {
  try { return JSON.parse(text)?.error?.message || text.slice(0, 200); } catch (e) { return String(text).slice(0, 200); }
}

/** A limiter: at most `max` calls of fn in flight; a freed slot goes straight to the next waiter. */
export function makeLimiter(max) {
  let inFlight = 0;
  const queue = [];
  return async fn => {
    if (inFlight >= max) await new Promise(res => queue.push(res));
    else inFlight++;
    try { return await fn(); } finally {
      const next = queue.shift();
      if (next) next(); else inFlight--;
    }
  };
}

export function createGA({ transport, mode, maxConcurrent = 5, reportTtlMs = 300e3, realtimeTtlMs = 25e3,
                           retries = 3, retryBaseMs = 1000, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const cache = new Map(), inFlight = new Map();
  const limited = makeLimiter(maxConcurrent);
  const stats = { requests: 0, cacheHits: 0, byMethod: {} };
  let quota = null;

  async function send(method, body) {
    for (let attempt = 0; ; attempt++) {
      stats.requests++;
      stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
      const r = await limited(() => transport.post(method, body));
      if (r.status === 429 && /concurrent/i.test(r.text) && attempt < retries) {
        await sleep(retryBaseMs * 2 ** attempt * (1 + Math.random()));
        continue;
      }
      if (!r.ok) throw new GAError(method, r.status, errorMessage(r.text));
      const payload = JSON.parse(r.text);
      if (payload.propertyQuota) quota = { ...payload.propertyQuota, at: Date.now() };
      return payload;
    }
  }

  function call(method, body, { ttl } = {}) {
    const ttlMs = ttl != null ? ttl * 1000 : method === REALTIME ? realtimeTtlMs : reportTtlMs;
    const key = `${method}:${stable(body)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttlMs) { stats.cacheHits++; return Promise.resolve(hit.v); }
    if (inFlight.has(key)) { stats.cacheHits++; return inFlight.get(key); }
    const p = send(method, body)
      .then(v => { if (ttlMs > 0) cache.set(key, { t: Date.now(), v }); return v; })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  const ga = {
    mode,
    stats,
    get quota() { return quota; },
    runReport: (body, opts) => call("runReport", body, opts),
    runRealtimeReport: (body, opts) => call(REALTIME, body, opts),
    /** Several reports in one call (GA allows five per batch). One failure fails the batch, as in GA. */
    async batchRunReports(requests, opts) {
      const out = [];
      for (let i = 0; i < requests.length; i += 5) {
        const p = await call("batchRunReports", { requests: requests.slice(i, i + 5) }, opts);
        out.push(...(p.reports || []));
      }
      return out;
    },
    /**
     * Each request its own failure: {key: payload} or {key: {error}}. The
     * pattern every card uses so a refused dimension costs its part, not the card.
     */
    async parts(requests, { method = "runReport", ...opts } = {}) {
      const entries = await Promise.all(Object.entries(requests).map(async ([k, body]) => {
        try { return [k, await call(method, body, opts)]; } catch (e) { return [k, { error: e.message }]; }
      }));
      return Object.fromEntries(entries);
    },
    /** runReport and read the rows in one step. */
    async rows(body, opts) {
      const p = await call("runReport", body, opts);
      return gaRows(p, (body.dimensions || []).map(d => d.name), (body.metrics || []).map(m => m.name));
    },
    clearCache() { cache.clear(); },
  };
  return ga;
}

// ---- transports -------------------------------------------------------------

/** Browser-direct: the viewer's own Google token, straight to the Data API. */
export function directTransport({ tokens, propertyId, fetchFn = (...a) => globalThis.fetch(...a), onSessionExpired = () => {} }) {
  async function once(method, body) {
    await tokens.ensureToken();
    const sent = tokens.token;
    const res = await fetchFn(`${API_BASE}/properties/${propertyId}:${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sent}`, "Content-Type": "application/json" },
      body: JSON.stringify(method === "batchRunReports" ? body : { ...body, returnPropertyQuota: true }),
    });
    const r = { status: res.status, ok: res.ok, text: await res.text() };
    // A 401 is usually a merely expired token: drop the one we sent (unless a
    // sibling already renewed it) and let ensureToken renew silently.
    if (r.status === 401) tokens.dropToken(sent);
    return r;
  }
  return {
    async post(method, body) {
      const r = await once(method, body);
      if (r.status !== 401) return r;
      const again = await once(method, body);
      // twice in a row is a refusal, not staleness: worth interrupting for
      if (again.status === 401) onSessionExpired();
      return again;
    },
  };
}

/** Behind `bizdash serve`: the server holds the credentials and a shared cache. */
export function serverTransport({ base = "api/ga/", fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
  return {
    async post(method, body) {
      const res = await fetchFn(`${base}${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: res.status, ok: res.ok, text: await res.text() };
    },
  };
}

/** Synthetic data in the page (?demo=1). */
export const demoTransport = demoApi => ({ post: (method, body) => demoApi.post(method, body) });
