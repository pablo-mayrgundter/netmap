// RIS Live (https://ris-live.ripe.net/manual/): RIPE RIS's realtime BGP
// UPDATE stream, as a websocket. This module parses its messages into the
// feed's updates, and keeps one socket up: subscriptions resent on every
// connect, a ping a minute, reconnects with exponential backoff and jitter,
// and a watchdog for a socket that's open but silent. DOM-free: the
// WebSocket and the timers are passed in, so node's tests drive it.

export const RIS_LIVE_URL = 'wss://ris-live.ripe.net/v1/ws/?client=netmap';
export const STARLINK_ASN = 14593;

/**
 * What the looking glass subscribes to: every UPDATE with `asn` in its AS
 * path (Starlink originating, or carrying a customer's route), and the
 * UPDATEs withdrawing anything under `cover` (withdrawals carry no path, so
 * the path filter misses them; coverPrefixes() in prefixes.js makes the list).
 */
export function risSubscriptions(asn = STARLINK_ASN, cover = []) {
  const subs = [{ type: 'UPDATE', path: asn }];
  if (cover.length) subs.push({ type: 'UPDATE', require: 'withdrawals', prefix: cover });
  return subs;
}

/** An AS path with prepends folded: [{ asn, n }], asn a number or (an AS_SET) an array. */
export function foldPath(path) {
  const out = [];
  for (const hop of Array.isArray(path) ? path : []) {
    const asn = Array.isArray(hop) ? hop.map(Number) : Number(hop);
    const prev = out[out.length - 1];
    if (prev && !Array.isArray(asn) && prev.asn === asn) prev.n++;
    else out.push({ asn, n: 1 });
  }
  return out;
}

/** The ASNs of a folded path, in order, without AS_SETs: what can be drawn. */
export const pathAsns = (hops) => hops.filter((h) => !Array.isArray(h.asn)).map((h) => h.asn);

/**
 * One RIS Live message (a string or parsed) -> what the feed shows, or null:
 *   { type: 'update', id, time (Unix ms), host ('rrc12'), peer, peerAsn,
 *     path: foldPath(), origin, via (asn is in the path), transit (asn is in
 *     it but doesn't originate), announce: [prefix], withdraw: [prefix] }
 *   { type: 'error', message } (ris_error), { type: 'ok' }, { type: 'pong' }.
 * Announcements are kept when `asn` is in the path or isOurs(prefix);
 * withdrawals when isOurs(prefix). An update with neither is null.
 */
export function parseRisMessage(raw, { asn = STARLINK_ASN, isOurs = () => false } = {}) {
  let msg = raw;
  if (typeof raw === 'string') {
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'ris_error') return { type: 'error', message: String(msg.data?.message ?? msg.data ?? 'error') };
  if (msg.type === 'ris_subscribe_ok') return { type: 'ok' };
  if (msg.type === 'pong') return { type: 'pong' };
  const d = msg.data;
  if (msg.type !== 'ris_message' || !d || d.type !== 'UPDATE') return null;
  const path = foldPath(d.path);
  const via = path.some((h) => h.asn === asn || (Array.isArray(h.asn) && h.asn.includes(asn)));
  const last = path[path.length - 1];
  const origin = last && !Array.isArray(last.asn) ? last.asn : null;
  const announce = [];
  for (const a of Array.isArray(d.announcements) ? d.announcements : []) {
    for (const p of Array.isArray(a?.prefixes) ? a.prefixes : []) if (typeof p === 'string' && (via || isOurs(p))) announce.push(p);
  }
  const withdraw = (Array.isArray(d.withdrawals) ? d.withdrawals : []).filter((p) => typeof p === 'string' && isOurs(p));
  if (!announce.length && !withdraw.length) return null;
  const time = Number.isFinite(d.timestamp) ? Math.round(d.timestamp * 1000) : null;
  return {
    type: 'update',
    id: typeof d.id === 'string' ? d.id : null,
    time,
    host: String(d.host ?? '').replace(/\.ripe\.net$/, ''),
    peer: d.peer ?? null,
    peerAsn: d.peer_asn !== undefined ? Number(d.peer_asn) : null,
    path,
    origin,
    via,
    transit: via && origin !== asn,
    announce,
    withdraw,
  };
}

/** The wait before reconnect attempt `attempt` (0 first): base·2^attempt, at most max, ±25 % jitter. */
export function backoffDelay(attempt, { base = 1000, max = 60_000 } = {}, random = Math.random) {
  return Math.round(Math.min(max, base * 2 ** attempt) * (0.75 + 0.5 * random()));
}

/**
 * A RIS Live socket. onMessage(data) gets each frame's text; onState(state)
 * each change of { status: 'off' | 'connecting' | 'open' | 'waiting',
 * attempt, retryAt (Unix ms, while waiting), error }.
 * start() connects (and keeps reconnecting until stop()); subscribe(data)
 * adds a subscription (sent now if open, and on every reconnect).
 */
export function createRisLive({
  url = RIS_LIVE_URL,
  WebSocket: WS = globalThis.WebSocket,
  subscriptions = [],
  onMessage = () => {},
  onState = () => {},
  backoff = {},
  pingMs = 60_000,
  stallMs = 120_000,
  timers = globalThis,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  const subs = [...subscriptions];
  let ws = null;
  let running = false;
  let state = { status: 'off', attempt: 0, retryAt: null, error: null };
  let retryTimer = null;
  let pingTimer = null;
  let lastFrame = 0;

  const set = (patch) => {
    state = { ...state, ...patch };
    onState(state);
  };
  const send = (obj) => {
    try {
      ws?.send(JSON.stringify(obj));
    } catch {
      /* closing: the reconnect resends */
    }
  };
  const clearTimers = () => {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    if (pingTimer !== null) timers.clearInterval(pingTimer);
    retryTimer = pingTimer = null;
  };
  const drop = () => {
    const s = ws;
    ws = null;
    if (!s) return;
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
    try {
      s.close();
    } catch {
      /* already closed */
    }
  };

  function connect() {
    clearTimers();
    drop();
    set({ status: 'connecting', retryAt: null });
    let sock;
    try {
      sock = new WS(url);
    } catch (err) {
      return retry(err?.message ?? 'could not connect');
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      lastFrame = now();
      set({ status: 'open', error: null });
      for (const s of subs) send({ type: 'ris_subscribe', data: s });
      pingTimer = timers.setInterval(() => {
        if (now() - lastFrame > stallMs) return retry('no data for a while');
        send({ type: 'ping', data: null });
      }, Math.min(pingMs, stallMs));
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      lastFrame = now();
      if (state.attempt) set({ attempt: 0 }); // it works: the next drop starts over
      onMessage(e.data);
    };
    sock.onerror = () => {
      if (ws === sock) state = { ...state, error: 'connection error' };
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      retry(e?.reason || state.error || `closed (${e?.code ?? '?'})`);
    };
  }

  function retry(error) {
    clearTimers();
    drop();
    if (!running) return;
    const wait = backoffDelay(state.attempt, backoff, random);
    set({ status: 'waiting', attempt: state.attempt + 1, retryAt: now() + wait, error });
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (running) connect();
    }, wait);
  }

  return {
    start() {
      if (running) return;
      running = true;
      state = { ...state, attempt: 0, error: null };
      connect();
    },
    stop() {
      running = false;
      clearTimers();
      drop();
      set({ status: 'off', retryAt: null });
    },
    /** Reconnect now (a retry button), keeping the subscriptions. */
    reconnect() {
      if (running) connect();
    },
    subscribe(data) {
      subs.push(data);
      if (state.status === 'open') send({ type: 'ris_subscribe', data });
    },
    get state() {
      return state;
    },
    get running() {
      return running;
    },
  };
}
