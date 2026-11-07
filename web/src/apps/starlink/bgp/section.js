// The Starlink app's BGP section (#32): a looking glass on AS14593 from RIPE
// RIS, all measured. RIPEstat's numbers (announced prefixes by PoP, the
// neighbours either side, RIS visibility, a year of prefix counts), and RIS
// Live's UPDATEs as they happen: a rolling feed, each update's AS path
// flashed on the map. Uses only ctx (apps README) and browser APIs.
//
// The live feed is off until asked for (a button, or starlink.live=1 in the
// permalink): it's a websocket of ~1,300 updates a minute (~0.7 MB/min
// before compression), too much to open for everyone who opens the app for
// its other sections, or on a phone's data plan. It closes on unmount and
// while the tab is hidden, and reopens when the tab is back.

import { LineLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { buildArcs } from '../../../arcs.js';
import { esc, fmt } from '../../util.js';
import { coverPrefixes, createPrefixTable } from './prefixes.js';
import { createRate, createRing, createThrottle } from './ring.js';
import {
  createStatCache,
  fetchRipestat,
  ripestatPage,
  shapeAnnounced,
  shapeNeighbours,
  shapePrefixCount,
  shapeRoutingStatus,
  shapeVisibility,
  sparkPath,
} from './ripestat.js';
import { createRisLive, parseRisMessage, pathAsns, risSubscriptions, STARLINK_ASN } from './rislive.js';

const ASN = STARLINK_ASN;
const RESOURCE = { resource: `AS${ASN}` };
const RING = 200; // updates kept
const ROWS = 60; // of those, rows drawn
const RENDER_MS = 500; // the feed redraws at most this often
// Map flashes: at most one a second, fading in steps over 2 s. Each step
// redraws the whole map (deck has no partial redraw), so the fade runs at
// 5 steps a second rather than every frame: ~5 redraws/s while live,
// instead of 60.
const FLASH_EVERY = 1000;
const FLASH_MS = 2000;
const FRAME_MS = 200;
const TIMEOUT = 150_000; // RIPEstat's routing-status takes ~100 s uncached
const NBR_LIST = 12;
const RETRY_MS = 20_000;

// RIPEstat calls: what each is for, and its shaping. One cache for the page
// session (and sessionStorage), so reopening the app doesn't call again.
const CALLS = {
  announced: { call: 'announced-prefixes', params: RESOURCE, shape: (d, t) => shapeAnnounced(d, t), needsTable: true },
  neighbours: { call: 'asn-neighbours', params: RESOURCE, shape: shapeNeighbours },
  status: { call: 'routing-status', params: RESOURCE, shape: shapeRoutingStatus },
  // per collector; slow (35 s or more, sometimes a 502), so only on request
  visibility: { call: 'visibility', params: RESOURCE, shape: shapeVisibility, lazy: true },
  count: { call: 'prefix-count', params: () => ({ ...RESOURCE, starttime: new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10) }), shape: shapePrefixCount },
};
let cache = null;
const statCache = () =>
  (cache ??= createStatCache({
    storage: (() => {
      try {
        return globalThis.sessionStorage ?? null;
      } catch {
        return null;
      }
    })(),
  }));
const tablePromises = new Map(); // dataBase -> Promise<table | null>, once a page

// The section's contract (app.js, SECTIONS): mount(el, ctx), unmount(), onHash(params).

let S = null; // the mounted section's state

export function mount(el, ctx) {
  import('./bgp.css'); // the section's styles, with its chunk (dynamic, so node's tests can import this module)
  S = {
    ctx,
    el,
    table: null,
    tableState: 'loading',
    stat: Object.fromEntries(Object.keys(CALLS).map((k) => [k, { loading: !CALLS[k].lazy, value: null, at: null, error: null }])),
    want: ctx.hash.get('live') === '1', // the feed asked for (the hash)
    hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    client: null,
    conn: { status: 'off' },
    subscribed: new Set(), // cover blocks subscribed to
    ring: createRing(RING),
    seq: 0,
    idSet: new Set(), // recent message ids: the two subscriptions can both match one
    announcedSet: new Set(),
    seenOrigin: new Set(),
    rates: { frames: createRate(), updates: createRate(), ann: createRate(), wd: createRate() },
    throttle: createThrottle(FLASH_EVERY),
    flashes: [],
    flashSeq: 0,
    frameTimer: null,
    renderTimer: null,
    lastRender: 0,
    tick: null,
  };
  el.innerHTML = `
    <h3 class="slbgp-h">BGP <span class="slbgp-tag" title="Measured by RIPE RIS route collectors">measured</span></h3>
    <p class="slbgp-src muted">From RIPE RIS's route collectors, through <a href="${ripestatPage(ASN)}" target="_blank" rel="noopener">RIPEstat (AS${ASN})</a> and RIS Live.</p>
    <div class="slbgp-stat" aria-live="polite"></div>
    <h3 class="slbgp-h">Live updates <span class="slbgp-tag">RIS Live</span></h3>
    <div class="slbgp-live"></div>`;
  el.classList.add('slbgp');
  S.statEl = el.querySelector('.slbgp-stat');
  S.liveEl = el.querySelector('.slbgp-live');
  S.liveEl.innerHTML = `
    <div class="app-actions slbgp-controls">
      <button type="button" class="btn" data-live aria-pressed="false"></button>
      <span class="slbgp-conn" role="status"></span>
    </div>
    <p class="slbgp-rates muted"></p>
    <ol class="slbgp-feed" aria-label="BGP updates for AS${ASN}, newest first"></ol>`;
  S.connEl = S.liveEl.querySelector('.slbgp-conn');
  S.ratesEl = S.liveEl.querySelector('.slbgp-rates');
  S.feedEl = S.liveEl.querySelector('.slbgp-feed');
  el.addEventListener('click', onClick);
  // The feed holds still under the pointer, while focused, and for a few
  // seconds after a touch, so its buttons can be hit.
  const hold = (on, ms = 0) => {
    if (!S) return;
    clearTimeout(S.holdTimer);
    S.held = on;
    if (on && ms) S.holdTimer = setTimeout(() => hold(false), ms);
    if (!on) renderFeed(true);
    else renderRates();
  };
  S.feedEl.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && hold(true));
  S.feedEl.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && !S.feedEl.contains(document.activeElement) && hold(false));
  S.feedEl.addEventListener('touchstart', () => hold(true, 4000), { passive: true });
  S.feedEl.addEventListener('focusin', () => hold(true));
  S.feedEl.addEventListener('focusout', (e) => !S.feedEl.contains(e.relatedTarget) && hold(false));
  S.onVisibility = () => {
    S.hidden = document.visibilityState === 'hidden';
    syncLive();
  };
  document.addEventListener('visibilitychange', S.onVisibility);
  ctx.on('dataset', () => {
    renderStat();
    renderFeed(true);
  });
  ctx.layers.set('flash', flashLayers);
  S.tick = setInterval(() => (S.client ? (renderConn(), renderRates()) : null), 1000);

  const s = S;
  loadTable(ctx)
    .then((t) => {
      if (S !== s) return;
      s.table = t;
      s.tableState = t ? 'ok' : 'missing';
      updateCover();
      fetchAll(false);
    });
  for (const k of Object.keys(CALLS)) if (!CALLS[k].needsTable && !CALLS[k].lazy) fetchOne(k, false);
  if (statCache().get(`${CALLS.visibility.call}.${ASN}`)) fetchOne('visibility', false); // asked for earlier this session
  renderStat();
  renderControls();
  renderFeed(true);
  syncLive();
}

export function unmount() {
  const s = S;
  S = null;
  if (!s) return;
  s.client?.stop();
  clearInterval(s.tick);
  clearTimeout(s.renderTimer);
  clearTimeout(s.frameTimer);
  clearTimeout(s.holdTimer);
  document.removeEventListener('visibilitychange', s.onVisibility);
  s.el.removeEventListener('click', onClick);
  s.el.innerHTML = '';
  s.el.classList.remove('slbgp');
}

export function onHash(params) {
  if (!S) return;
  const want = params.live === '1';
  if (want === S.want) return;
  S.want = want;
  syncLive();
}

// --- the geofeed table (prefix -> PoP) ------------------------------------

function loadTable(ctx) {
  const base = ctx.dataBase;
  if (!tablePromises.has(base)) {
    tablePromises.set(
      base,
      fetch(`${base}/starlink/prefixes.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j?.prefix ? createPrefixTable(j) : null))
        .catch(() => null)
        .then((t) => {
          if (!t) tablePromises.delete(base); // try again next mount
          return t;
        }),
    );
  }
  return tablePromises.get(base);
}

const isOurs = (p) => S.announcedSet.has(p) || S.seenOrigin.has(p) || !!S.table?.lookup(p);

/** The withdrawal subscription's blocks: the geofeed's prefixes and those RIPEstat says are announced. */
function updateCover() {
  if (!S) return;
  const prefixes = [...(S.table?.prefixes() ?? []), ...S.announcedSet];
  if (!prefixes.length) return;
  const fresh = coverPrefixes(prefixes).filter((p) => !S.subscribed.has(p));
  if (!fresh.length) return;
  for (const p of fresh) S.subscribed.add(p);
  S.client?.subscribe({ type: 'UPDATE', require: 'withdrawals', prefix: fresh });
}

// --- RIPEstat ----------------------------------------------------------------

function fetchAll(force) {
  for (const [k, c] of Object.entries(CALLS)) if (force ? !c.lazy || S.stat[k].value || S.stat[k].error : c.needsTable) fetchOne(k, force);
}

async function fetchOne(key, force, attempt = 0) {
  const s = S;
  const spec = CALLS[key];
  const cacheKey = `${spec.call}.${ASN}`;
  const st = s.stat[key];
  const hit = !force && statCache().get(cacheKey);
  if (hit) {
    // the announced shape depends on the table: reshape it from the raw prefix list
    s.stat[key] = { loading: false, value: key === 'announced' ? reshapeAnnounced(hit.value, s.table) : hit.value, at: hit.at, error: null };
    if (key === 'announced') noteAnnounced(s.stat[key].value);
    return renderStat();
  }
  if (force) statCache().delete(cacheKey);
  s.stat[key] = { ...st, loading: true, error: null };
  renderStat();
  const signal = AbortSignal.any && AbortSignal.timeout ? AbortSignal.any([s.ctx.signal, AbortSignal.timeout(TIMEOUT)]) : s.ctx.signal;
  try {
    const params = typeof spec.params === 'function' ? spec.params() : spec.params;
    const { data } = await fetchRipestat(spec.call, params, { signal });
    if (S !== s) return;
    const value = spec.shape(data, s.table);
    // cache the announced list compactly (the full response is 400 KB)
    const e = statCache().set(cacheKey, key === 'announced' ? compactAnnounced(value) : value);
    s.stat[key] = { loading: false, value, at: e.at, error: null };
    if (key === 'announced') noteAnnounced(value);
  } catch (err) {
    if (S !== s || s.ctx.signal.aborted) return;
    // A network failure (no response: often a slow uncached call cut off on
    // the way) is retried once, after RIPEstat has had time to cache it.
    if (err?.name === 'TypeError' && attempt === 0) {
      setTimeout(() => S === s && fetchOne(key, true, 1), RETRY_MS);
      return;
    }
    const why = err?.message || String(err);
    const msg = err?.name === 'TimeoutError' ? `${spec.call}: no answer in ${TIMEOUT / 1000} s` : why.startsWith('RIPEstat') ? why.slice(9) : `${spec.call}: ${why}`;
    s.stat[key] = { ...s.stat[key], loading: false, error: msg };
  }
  renderStat();
}

const compactAnnounced = (v) => ({ prefixes: v.prefixes, windowCount: v.windowCount, time: v.time, window: v.window });
function reshapeAnnounced(c, table) {
  // the same shape as shapeAnnounced, from the cached prefix list
  const timeIso = c.time ? new Date(c.time).toISOString().slice(0, 19) : null;
  const v = shapeAnnounced({ prefixes: c.prefixes.map((prefix) => ({ prefix, timelines: [{ endtime: timeIso ?? '' }] })), latest_time: timeIso }, table);
  return { ...v, windowCount: c.windowCount, window: c.window };
}
function noteAnnounced(v) {
  for (const p of v.prefixes) S.announcedSet.add(p);
  updateCover();
}

// --- RIS Live ------------------------------------------------------------------

/** Open or close the socket: open while wanted, mounted and the tab is visible. */
function syncLive() {
  if (!S) return;
  const run = S.want && !S.hidden;
  if (run && !S.client) {
    for (const r of Object.values(S.rates)) r.reset(); // rates since this connect
    S.client = createRisLive({
      subscriptions: risSubscriptions(ASN, [...S.subscribed]),
      onMessage,
      onState: (st) => {
        if (!S) return;
        S.conn = st;
        renderConn();
      },
    });
    S.client.start();
  } else if (!run && S.client) {
    S.client.stop();
    S.client = null;
    S.conn = { status: 'off' };
  }
  renderControls();
  renderConn();
}

function onMessage(text) {
  if (!S) return;
  const now = Date.now();
  S.rates.frames.add(now);
  const u = parseRisMessage(text, { asn: ASN, isOurs });
  if (!u) return;
  if (u.type === 'error') {
    S.conn = { ...S.conn, error: u.message };
    return renderConn();
  }
  if (u.type !== 'update') return;
  if (u.id) {
    if (S.idSet.has(u.id)) return;
    if (S.idSet.size >= 4096) S.idSet.clear(); // duplicates arrive within a second of each other
    S.idSet.add(u.id);
  }
  if (u.origin === ASN) for (const p of u.announce) S.seenOrigin.add(p);
  S.rates.updates.add(now);
  if (u.announce.length) S.rates.ann.add(now, u.announce.length);
  if (u.withdraw.length) S.rates.wd.add(now, u.withdraw.length);
  u.seq = ++S.seq;
  u.received = now;
  S.ring.push(u);
  if (S.throttle.allow(now)) flash(u);
  renderFeed(false);
}

// --- the map: each update's path, briefly --------------------------------------

const ANN = [110, 231, 255];
const WD = [255, 122, 92];

function flash(u) {
  const ctx = S.ctx;
  // an announcement's path, peer first; a withdrawal has none: AS14593 alone
  const asns = u.announce.length ? pathAsns(u.path) : [ASN];
  const pts = [];
  for (const a of asns) {
    const p = ctx.position(a);
    if (p) pts.push({ asn: a, p });
  }
  if (!pts.length) return;
  const f = { id: ++S.flashSeq, born: performance.now(), color: u.announce.length ? ANN : WD, pts, segs: [], arcs: null };
  for (let i = 1; i < pts.length; i++) f.segs.push([pts[i - 1].p, pts[i].p]);
  S.flashes.push(f);
  S.flashed = (S.flashed ?? 0) + 1;
  animate();
}

function animate() {
  if (!S || S.frameTimer) return;
  S.frameTimer = setTimeout(() => {
    if (!S) return;
    S.frameTimer = null;
    const now = performance.now();
    S.flashes = S.flashes.filter((f) => now - f.born < FLASH_MS);
    S.ctx.layers.redraw();
    if (S.flashes.length) animate();
  }, FRAME_MS);
}

function arcsOf(f) {
  if (f.arcs) return f.arcs;
  const ends = new Float64Array(6 * f.segs.length);
  f.segs.forEach(([a, b], k) => ends.set([a[0], a[1], a[2] ?? 0, b[0], b[1], b[2] ?? 0], 6 * k));
  return (f.arcs = buildArcs(ends, 0.05));
}

function flashLayers(env) {
  if (!S?.flashes.length) return [];
  const now = performance.now();
  const globe = !!env.globe;
  const params = globe ? { depthCompare: 'less-equal', depthWriteEnabled: false } : { depthCompare: 'always' };
  const out = [];
  for (const f of S.flashes) {
    const age = (now - f.born) / FLASH_MS;
    if (age >= 1) continue;
    const opacity = Math.max(0, 1 - age) ** 1.5;
    if (f.segs.length) {
      out.push(
        globe
          ? new PathLayer({ id: `p${f.id}`, data: arcsOf(f), _pathType: 'open', getColor: f.color, getWidth: 2.5, widthUnits: 'pixels', billboard: true, opacity, parameters: params })
          : new LineLayer({ id: `l${f.id}`, data: f.segs, getSourcePosition: (d) => [d[0][0], d[0][1]], getTargetPosition: (d) => [d[1][0], d[1][1]], getColor: f.color, getWidth: 2.5, widthUnits: 'pixels', opacity, parameters: params }),
      );
    }
    out.push(
      new ScatterplotLayer({
        id: `d${f.id}`,
        data: f.pts,
        getPosition: (d) => (globe ? d.p : [d.p[0], d.p[1]]),
        getFillColor: f.color,
        getRadius: (d) => (d.asn === ASN ? 7 : 4) * (1 + 0.6 * age),
        radiusUnits: 'pixels',
        billboard: true,
        stroked: false,
        opacity,
        parameters: params,
      }),
    );
  }
  return out;
}

// --- clicks ------------------------------------------------------------------

function onClick(e) {
  if (!S) return;
  const t = e.target.closest('button');
  if (!t || !S.el.contains(t)) return;
  if (t.dataset.asn) {
    S.ctx.select(Number(t.dataset.asn));
  } else if (t.dataset.route) {
    const u = S.ring.items().find((x) => x.seq === Number(t.dataset.route));
    if (u) S.ctx.route(pathAsns(u.path));
  } else if (t.hasAttribute('data-live')) {
    S.want = !S.want;
    S.ctx.hash.set('live', S.want ? '1' : null);
    S.ctx.track('starlink_bgp_live', { on: S.want });
    syncLive();
  } else if (t.hasAttribute('data-vis')) {
    fetchOne('visibility', true);
  } else if (t.hasAttribute('data-refresh')) {
    fetchAll(true);
  } else if (t.hasAttribute('data-retry')) {
    for (const k of Object.keys(CALLS)) if (S.stat[k].error) fetchOne(k, true);
  } else if (t.hasAttribute('data-reconnect')) {
    S.client?.reconnect();
  }
}

// --- drawing ---------------------------------------------------------------------

const utc = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : '—');
const utcDay = (t) => (Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');

/** An ASN as a button when it's on the map (select it), else plain. */
function asnHTML(asn, n = 1) {
  const node = S.ctx.node(asn);
  const pre = n > 1 ? `<span class="slbgp-pre" title="prepended ${n}×">×${n}</span>` : '';
  if (!node) return `<span class="slbgp-as" title="AS${asn}: not on this map">${asn}${pre}</span>`;
  return `<button type="button" class="slbgp-as on" data-asn="${asn}" title="AS${asn} ${esc(node.name)}: select it">${asn}${pre}</button>`;
}

function renderStat() {
  if (!S) return;
  const { announced: a, neighbours: nb, status: rs, visibility: vis, count } = S.stat;
  const wait = (x) => (x.loading ? '<span class="muted">…</span>' : x.error ? '<span class="muted">unavailable</span>' : null);
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;

  const spark = count.value && count.value.v4.length > 1 ? sparkHTML(count.value) : '';
  const ann = a.value ? `${fmt(a.value.v4)} IPv4 · ${fmt(a.value.v6)} IPv6 prefixes` : rs.value?.announced.v4 != null ? `${fmt(rs.value.announced.v4)} IPv4 · ${fmt(rs.value.announced.v6)} IPv6 prefixes` : wait(a);
  const seen = rs.value
    ? ['v4', 'v6'].map((v) => (rs.value.visibility[v] ? `${fmt(rs.value.visibility[v].seeing)} / ${fmt(rs.value.visibility[v].total)} (${v === 'v4' ? 'IPv4' : 'IPv6'})` : '')).filter(Boolean).join(' · ') + ' RIS peers'
    : wait(rs);
  let feedRow = '';
  if (a.value && S.tableState === 'ok') {
    const pops = a.value.byPop.length;
    feedRow = row('PoPs', `${fmt(a.value.inFeed)} in the geofeed at ${fmt(pops)} PoPs${a.value.noPop ? `, ${fmt(a.value.noPop)} with none` : ''} · <span title="Announced, but not in Starlink's geofeed (infrastructure, or not yet listed)">${fmt(a.value.notInFeed)} not in it</span>`);
  } else if (S.tableState === 'missing') feedRow = row('PoPs', '<span class="muted">no Starlink data here (<code>python -m netmap starlink</code>)</span>');
  const visRow = vis.value
    ? vis.value.missing.v4 + vis.value.missing.v6
      ? `${fmt(vis.value.missing.v4 + vis.value.missing.v6)} full-table peers miss some (${vis.value.worst.map((w) => esc(w.name)).join(', ')})`
      : `every full-table peer at ${fmt(vis.value.collectors)} collectors sees it all`
    : vis.loading
      ? '<span class="muted">asking RIPEstat… (slow: up to a minute)</span>'
      : `<button type="button" class="btn slbgp-small" data-vis title="RIPEstat visibility: which full-table RIS peers miss a prefix (takes up to a minute)">${vis.error ? 'Try again' : 'Check each collector'}</button>`;
  const nbs = nb.value ? `<span title="towards the RIS peers: its upstreams and peers">${fmt(nb.value.counts.left)} left</span> · <span title="routes it carries: customers">${fmt(nb.value.counts.right)} right</span> · ${fmt(nb.value.counts.uncertain)} uncertain` : wait(nb);

  const errors = Object.entries(S.stat).filter(([, x]) => x.error);
  const at = Object.values(S.stat).map((x) => x.at).filter(Number.isFinite);
  const risTime = a.value?.time ?? rs.value?.time ?? nb.value?.time ?? null;

  S.statEl.innerHTML = `
    <dl>
      ${row('Announced', `${ann}${spark}`)}
      ${feedRow}
      ${row('Seen by', seen)}
      ${row('Collectors', visRow)}
      ${row('Neighbours', nbs)}
    </dl>
    ${a.value?.byPop.length ? popsHTML(a.value) : ''}
    ${nb.value ? nbrsHTML(nb.value) : ''}
    ${errors.length ? `<p class="app-warn">RIPEstat didn't answer: ${errors.map(([, x]) => esc(x.error)).join('; ')}. <button type="button" class="btn slbgp-small" data-retry>Retry</button></p>` : ''}
    <p class="slbgp-when muted">Measured: RIS data as of ${utcDay(risTime)}${at.length ? ` · fetched ${utc(Math.min(...at))} UTC` : ''}
      <button type="button" class="btn slbgp-small" data-refresh title="Ask RIPEstat again">Refresh</button></p>`;
}

function sparkHTML(c) {
  const W = 96, H = 20;
  const v4 = c.v4.map((p) => p.n), v6 = c.v6.map((p) => p.n);
  const first = c.v4[0], last = c.v4[c.v4.length - 1];
  const title = `Prefixes announced (RIPEstat prefix-count, every ${c.resolution ?? '?'}): IPv4 ${fmt(first.n)} → ${fmt(last.n)}, IPv6 ${fmt(v6[0])} → ${fmt(v6[v6.length - 1])}, ${new Date(first.t).toISOString().slice(0, 10)} to ${new Date(last.t).toISOString().slice(0, 10)}`;
  return ` <svg class="slbgp-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>
    <path d="${sparkPath(v6, W, H)}" class="v6"/><path d="${sparkPath(v4, W, H)}" class="v4"/></svg>`;
}

function popsHTML(a) {
  const top = a.byPop.slice(0, 16);
  const max = top[0].v4 + top[0].v6;
  return `<details class="slbgp-pops"><summary>Announced prefixes by PoP (${fmt(a.byPop.length)})</summary>
    <ul>${top
      .map((p) => `<li><code>${esc(p.code)}</code><span class="bar" style="--w:${(((p.v4 + p.v6) / max) * 100).toFixed(0)}%"></span><span class="n">${fmt(p.v4)} · ${fmt(p.v6)}</span></li>`)
      .join('')}</ul>
    <p class="muted">IPv4 · IPv6, attributed by Starlink's geofeed (pops.csv); an announced aggregate counts for the PoP of most of its feed prefixes.${a.byPop.length > top.length ? ` ${fmt(a.byPop.length - top.length)} more PoPs.` : ''}</p></details>`;
}

function nbrsHTML(nb) {
  const list = (items) =>
    items.length
      ? `<ul class="app-nbrs">${items
          .slice(0, NBR_LIST)
          .map((n) => {
            const node = S.ctx.node(n.asn);
            const label = `<span class="asn">AS${n.asn}</span> ${node ? esc(node.name) : ''} <span class="muted">· power ${fmt(n.power)}</span>`;
            return node
              ? `<li><button type="button" class="app-link" data-asn="${n.asn}" title="Select AS${n.asn} and fly to it (seen by ${fmt(n.v4)} IPv4, ${fmt(n.v6)} IPv6 RIS peers)">${label}</button></li>`
              : `<li class="slbgp-off" title="Not on this map">${label}</li>`;
          })
          .join('')}</ul>${items.length > NBR_LIST ? `<p class="muted">and ${fmt(items.length - NBR_LIST)} more</p>` : ''}`
      : '<p class="muted">none</p>';
  return `<details class="slbgp-nbrs"><summary>Neighbours by power (RIPEstat)</summary>
    <p class="muted">Power: how many RIS peers saw the adjacency.</p>
    <h4>Left: towards the RIS peers (${fmt(nb.counts.left)})</h4>${list(nb.left)}
    <h4>Right: routes it carries (${fmt(nb.counts.right)})</h4>${list(nb.right)}</details>`;
}

function renderControls() {
  if (!S) return;
  const b = S.liveEl.querySelector('[data-live]');
  b.textContent = S.want ? 'Pause live feed' : S.ring.size ? 'Resume live feed' : 'Start live feed';
  b.classList.toggle('primary', !S.want);
  b.setAttribute('aria-pressed', String(S.want));
}

function renderConn() {
  if (!S) return;
  const c = S.conn;
  let cls = 'off', text = S.ring.size ? 'paused' : 'off', extra = '';
  if (S.want && S.hidden) (cls = 'paused'), (text = 'paused while the tab is hidden');
  else if (c.status === 'connecting') (cls = 'wait'), (text = 'connecting…');
  else if (c.status === 'open') (cls = 'live'), (text = 'live');
  else if (c.status === 'waiting') {
    cls = 'wait';
    text = `reconnecting in ${Math.max(0, Math.ceil((c.retryAt - Date.now()) / 1000))} s${c.error ? ` (${esc(c.error)})` : ''}`;
    extra = ' <button type="button" class="btn slbgp-small" data-reconnect>Now</button>';
  }
  S.connEl.className = `slbgp-conn ${cls}`;
  S.connEl.innerHTML = `<i aria-hidden="true"></i>${text}${extra}`;
}

function renderRates() {
  if (!S) return;
  const now = Date.now();
  const r = S.rates;
  if (!S.client && !S.ring.size) {
    S.ratesEl.textContent = 'Each update for AS14593 seen by RIS: the collector and its peer, announce (A) or withdraw (W), the prefix → its PoP and its customers\' city in Starlink\'s geofeed, and the AS path. Each one flashes its path on the map (at most one a second).';
    return;
  }
  // per minute once a minute is counted; before that, the count so far (a
  // connect starts with a burst, which would scale up to a silly rate)
  const span = r.frames.span(now);
  const full = span >= 60_000;
  const n = (x) => fmt(Math.round(full ? x.perMinute(now) : x.total(now)));
  const per = full ? '/min' : ` in ${Math.max(1, Math.round(span / 1000))} s`;
  S.ratesEl.innerHTML = `${n(r.updates)} updates${per} <span title="RIS Live frames received, before filtering">(${n(r.frames)} frames)</span> · ${n(r.ann)} prefixes announced, ${n(r.wd)} withdrawn · ${S.held ? 'held while you point at it' : `showing the newest ${fmt(Math.min(ROWS, S.ring.size))} of ${fmt(S.seq)}`}`;
}

function renderFeed(now) {
  if (!S) return;
  if (!now) {
    if (S.renderTimer) return;
    const wait = Math.max(0, RENDER_MS - (Date.now() - S.lastRender));
    S.renderTimer = setTimeout(() => {
      if (!S) return;
      S.renderTimer = null;
      renderFeed(true);
    }, wait);
    return;
  }
  S.lastRender = Date.now();
  renderRates();
  renderControls();
  if (S.held) return;
  const items = S.ring.items(ROWS);
  S.feedEl.innerHTML = items.map(rowHTML).join('');
}

function prefixHTML(list, kind) {
  const p = list[0];
  const hit = S.table?.lookup(p) ?? null;
  const place = hit?.place ? [hit.place[2], hit.place[0]].filter(Boolean).join(', ') : '';
  const pop = hit?.pop
    ? `<span class="slbgp-pop" title="PoP ${esc(hit.pop)}${hit.pops.length > 1 ? ` (and ${hit.pops.slice(1).map((x) => esc(x.code)).join(', ')})` : ''}${place ? `; customers in ${esc(place)}` : ''} (Starlink's geofeed)">→ ${esc(hit.pop)}${hit.pops.length > 1 ? ` +${hit.pops.length - 1}` : ''}${place ? ` · ${esc(hit.place[2] || hit.place[0])}` : ''}</span>`
    : hit
      ? `<span class="slbgp-pop muted" title="In the geofeed, without a PoP">→ no PoP${place ? ` · ${esc(hit.place[2] || hit.place[0])}` : ''}</span>`
      : '';
  const more = list.length > 1 ? ` <span class="muted" title="${esc(list.slice(1, 40).join(' '))}${list.length > 41 ? ' …' : ''}">+${list.length - 1}</span>` : '';
  return `<span class="slbgp-kind ${kind}" title="${kind === 'a' ? 'announced' : 'withdrawn'}">${kind === 'a' ? 'A' : 'W'}</span><code class="slbgp-pfx">${esc(p)}</code>${more} ${pop}`;
}

function rowHTML(u) {
  const head = `<time datetime="${u.time ? new Date(u.time).toISOString() : ''}" title="${utcDay(u.time)}">${utc(u.time)}</time> <span class="slbgp-peer" title="collector ${esc(u.host)}, peer ${esc(u.peer ?? '')} (AS${u.peerAsn ?? '?'})">${esc(u.host)} · AS${u.peerAsn ?? '?'}</span>`;
  const lines = [];
  if (u.announce.length) lines.push(`<div class="slbgp-l1">${prefixHTML(u.announce, 'a')}</div>`);
  if (u.withdraw.length) lines.push(`<div class="slbgp-l1">${prefixHTML(u.withdraw, 'w')}</div>`);
  const path = u.path.length
    ? `<div class="slbgp-path">${u.path.map((h) => (Array.isArray(h.asn) ? `<span class="slbgp-as" title="AS_SET">{${h.asn.join(',')}}</span>` : asnHTML(h.asn, h.n))).join('<span class="slbgp-sep" aria-hidden="true">›</span>')}${
        pathAsns(u.path).some((a) => S.ctx.node(a)) ? ` <button type="button" class="slbgp-route" data-route="${u.seq}" title="Draw this AS path as a route on the map">route</button>` : ''
      }${u.transit ? ' <span class="slbgp-tag" title="AS14593 carries this route for a customer">transit</span>' : ''}</div>`
    : '';
  return `<li class="slbgp-row">${`<div class="slbgp-head">${head}</div>`}${lines.join('')}${path}</li>`;
}
