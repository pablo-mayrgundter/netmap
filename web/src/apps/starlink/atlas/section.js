// The Starlink app's RIPE Atlas section (#33): the connected Atlas probes on
// AS14593, each tied to its PoP, their latest RTTs by PoP and by region,
// and a selected probe's RTT over the last hour and its latest traceroute,
// drawn on the map. All of it measured (RIPE Atlas), with the measurement
// ids and times linked. Uses only ctx (../../README.md).
//
// A section: { id, mount(el, ctx), unmount(), onHash(params) }, listed in
// ../sections.js. Its permalink param is starlink.probe=<id>.

import { esc, fmt } from '../../util.js';
import { ATLAS, BUILTIN, PING_INTERVAL_S, atlasClient, measurementUrl, probeUrl } from './api.js';
import { prefixTable } from './ip.js';
import { latencyBy, parsePing, reconfigBoundaries, regionKey, resolutionS, resolvesReconfig, rttSeries, stats } from './latency.js';
import { probeGroup, ROLE_COLOURS, traceGroup } from './mapLayers.js';
import { STARLINK_ASN, matchProbe, normalizeProbe, popColours } from './probes.js';
import { parseTraceroute, pathRoles, pathStops, popRtt } from './traceroute.js';

// One client for the page: its cache outlives the app's mounts (per session).
const client = atlasClient();
const files = new Map(); // the pipeline's Starlink files, by URL

const PROBES_GROUP = 'atlas-probes';
const TRACE_GROUP = 'atlas-trace';
const GREY = [150, 150, 160];
const ROLE_LABEL = { lan: 'home / dish', pop: 'PoP gateway', starlink: 'Starlink', internet: 'internet', dest: 'target' };
// A probe's latest ping older than this isn't its latency now (a probe can be
// connected and still not have run the built-ins lately).
const STALE_S = 6 * 3600;
const TRACE_KINDS = { root: { key: 'traceroute', label: 'k-root' }, topology: { key: 'topology', label: 'topology' } };

let S = null; // this mount's state

const toId = (v) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : null);
const ms = (x) => (Number.isFinite(x) ? `${x < 10 ? x.toFixed(1) : Math.round(x)} ms` : '—');
const when = (ts) => (ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const ago = (ts) => {
  if (!ts) return '';
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const msmLink = (id, text = id) => `<a href="${measurementUrl(id)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const aborted = (s) => S !== s || s.ctx.signal.aborted;

async function file(url, signal) {
  if (!files.has(url)) {
    const p = fetch(url, { signal }).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    });
    files.set(url, p);
    p.catch(() => files.get(url) === p && files.delete(url));
  }
  return files.get(url);
}

export function mount(el, ctx) {
  S = {
    ctx,
    el,
    data: null, // { pops, popByCode, table, regions, regionName }
    dataError: null,
    probes: null,
    error: null,
    match: new Map(), // id -> matchProbe
    ping: new Map(), // id -> parsePing
    colours: new Map(),
    groupBy: ctx.hash.get('latby') === 'region' ? 'region' : 'pop',
    traceKind: ctx.hash.get('trace') === 'topology' ? 'topology' : 'root',
    selected: toId(ctx.hash.get('probe')),
    trace: null, // { id, msm, tr, hops, loading, error }
    series: null, // { id, msm, data, loading, error, start, stop }
    asn: new Map(), // ip -> asn | null
    listOpen: false,
    stops: null, // memo for the trace layer: { key, stops }
  };
  el.classList.add('atlas');
  el.addEventListener('click', onClick);
  el.addEventListener('toggle', onToggle, true);
  ctx.on('view', () => render());
  ctx.on('dataset', () => {
    if (!S) return;
    S.stops = null;
    ctx.layers.redraw();
  });
  render();
  load(S);
}

export function unmount() {
  if (!S) return;
  S.el.removeEventListener('click', onClick);
  S.el.removeEventListener('toggle', onToggle, true);
  S.el.innerHTML = '';
  S = null;
}

export function onHash(params) {
  if (!S) return;
  const g = params.latby === 'region' ? 'region' : 'pop';
  const t = params.trace === 'topology' ? 'topology' : 'root';
  let again = false;
  if (g !== S.groupBy) (S.groupBy = g), (again = true);
  if (t !== S.traceKind) {
    S.traceKind = t;
    if (S.selected) loadTrace(S, S.selected);
    again = true;
  }
  const id = toId(params.probe);
  if (id !== S.selected) select(id, { fromHash: true });
  else if (again) render();
}

// --- loading ---------------------------------------------------------------

async function load(s) {
  const { ctx } = s;
  const signal = ctx.signal;
  const base = `${ctx.dataBase}/starlink`;
  try {
    const [pops, prefixes, regions] = await Promise.all(['pops', 'prefixes', 'regions'].map((f) => file(`${base}/${f}.json`, signal)));
    if (aborted(s)) return;
    s.data = {
      pops,
      popByCode: new Map(pops.map((p) => [p.code, p])),
      table: prefixTable(prefixes),
      regions,
      regionName: new Map(regions.map((r) => [r.region || r.country, r.region ? `${r.region_name || r.region}, ${r.country}` : r.country_name || r.country])),
    };
  } catch (err) {
    if (aborted(s)) return;
    s.dataError = err.message;
  }
  render();
  let raw;
  try {
    raw = await client.probes(signal, STARLINK_ASN);
  } catch (err) {
    if (aborted(s)) return;
    s.error = `RIPE Atlas didn't answer (${err.message}).`;
    ctx.notice('RIPE Atlas is unreachable: no Starlink probes for now.');
    return render();
  }
  if (aborted(s)) return;
  s.probes = raw.map(normalizeProbe);
  render();
  // Latest pings: IPv4 to k-root (1001) for probes on Starlink by IPv4, IPv6 (2001) for the IPv6-only ones.
  const v4 = s.probes.filter((p) => p.asnV4 === STARLINK_ASN).map((p) => p.id);
  const v6 = s.probes.filter((p) => p.asnV4 !== STARLINK_ASN).map((p) => p.id);
  try {
    const [r4, r6] = await Promise.all([client.latest(BUILTIN.ping[4].id, v4, signal), v6.length ? client.latest(BUILTIN.ping[6].id, v6, signal) : []]);
    if (aborted(s)) return;
    for (const r of [...r4, ...r6]) {
      const p = parsePing(r);
      if (p) s.ping.set(p.probe, p);
    }
  } catch (err) {
    if (aborted(s)) return;
    s.pingError = err.message;
  }
  matchAll(s);
  render();
  setProbeLayers(s);
  if (s.selected) loadProbe(s, s.selected);
}

function matchAll(s) {
  if (!s.data) return;
  for (const p of s.probes) {
    const from = s.ping.get(p.id)?.from;
    // the ping's source address is only Starlink's on the family the probe is on Starlink by
    s.match.set(p.id, matchProbe(p, s.data.table, { regions: s.data.regions, from: p.asnV4 === STARLINK_ASN || from?.includes(':') ? from : null }));
  }
  s.colours = popColours(new Set([...s.match.values()].map((m) => m.pop).filter(Boolean)));
}

function loadProbe(s, id) {
  loadTrace(s, id);
  loadSeries(s, id);
}

const afOf = (p) => (p?.asnV4 === STARLINK_ASN ? 4 : 6);

async function loadTrace(s, id) {
  const p = s.probes?.find((x) => x.id === id);
  if (!p) return;
  const msm = BUILTIN[TRACE_KINDS[s.traceKind].key][afOf(p)].id;
  s.trace = { id, msm, loading: true };
  s.stops = null;
  render();
  setTraceLayer(s);
  const signal = s.ctx.signal;
  try {
    const [raw] = await client.latest(msm, [id], signal);
    if (aborted(s) || s.trace?.id !== id || s.trace.msm !== msm) return;
    const tr = parseTraceroute(raw);
    if (!tr) throw new Error('no recent result');
    // origin ASes of the public hops (RIPEstat network-info), cached
    const ips = [...new Set(tr.hops.filter((h) => h.kind === 'public').map((h) => h.ip))].filter((ip) => !s.asn.has(ip));
    s.trace = { id, msm, tr, hops: roles(s, tr), loading: true, resolving: ips.length };
    render();
    await Promise.all(
      ips.map((ip) =>
        client
          .networkInfo(ip, signal)
          .then((d) => s.asn.set(ip, d.asns[0] ?? null))
          .catch(() => {}),
      ),
    );
    if (aborted(s) || s.trace?.id !== id || s.trace.msm !== msm) return;
    s.trace = { id, msm, tr, hops: roles(s, tr), loading: false, unresolved: ips.filter((ip) => !s.asn.has(ip)).length };
  } catch (err) {
    if (aborted(s) || s.trace?.id !== id) return;
    s.trace = { id, msm, loading: false, error: err.message };
  }
  s.stops = null;
  render();
  setTraceLayer(s);
}

const roles = (s, tr) => pathRoles(tr, { asnOf: (ip) => s.asn.get(ip) ?? null, table: s.data?.table });

async function loadSeries(s, id) {
  const p = s.probes?.find((x) => x.id === id);
  if (!p) return;
  const msm = BUILTIN.ping[afOf(p)].id;
  const stop = Math.floor(Date.now() / 60_000) * 60; // to the minute, so the cache holds for a minute
  const start = stop - 3600;
  s.series = { id, msm, start, stop, loading: true };
  render();
  try {
    const res = await client.results(msm, id, { start, stop }, s.ctx.signal);
    if (aborted(s) || s.series?.id !== id) return;
    s.series = { id, msm, start, stop, data: rttSeries(res), loading: false };
  } catch (err) {
    if (aborted(s) || s.series?.id !== id) return;
    s.series = { id, msm, start, stop, loading: false, error: err.message };
  }
  render();
}

// --- selection ---------------------------------------------------------------

function select(id, { fromHash = false, fly = false } = {}) {
  const s = S;
  if (!s) return;
  s.selected = id;
  if (!fromHash) s.ctx.hash.set('probe', id ?? null);
  s.trace = s.series = null;
  s.stops = null;
  if (id !== null) {
    s.ctx.track('starlink_probe_select', { probe_id: id, pop: s.match.get(id)?.pop ?? null });
    const p = s.probes?.find((x) => x.id === id);
    if (fly && p && Number.isFinite(p.lon)) s.ctx.flyTo({ lon: p.lon, lat: p.lat, zoom: 4 });
    if (p) loadProbe(s, id);
  }
  setProbeLayers(s);
  setTraceLayer(s);
  render();
}

// --- the map -----------------------------------------------------------------

function popPos(s, code) {
  const p = code && s.data?.popByCode.get(code);
  return p && Number.isFinite(p.lon) ? p : null;
}

function setProbeLayers(s) {
  if (!s.probes) return;
  const probes = s.probes.map((p) => {
    const m = s.match.get(p.id);
    const pop = popPos(s, m?.pop);
    return { ...p, colour: s.colours.get(m?.pop) ?? GREY, pop: pop && { code: pop.code, lon: pop.lon, lat: pop.lat, city: pop.city } };
  });
  s.ctx.layers.set(PROBES_GROUP, probeGroup({ probes, selected: s.selected, onPick: (id) => select(id === s.selected ? null : id) }), {
    tooltip: (info) => {
      const o = info.object;
      if (!o) return null;
      if (o.code) return `PoP ${o.code}${o.city ? ` (${o.city})` : ''} · from Starlink's pops.csv`;
      return probeTip(s, o.id);
    },
  });
}

function probeTip(s, id) {
  const p = s.probes.find((x) => x.id === id);
  const m = s.match.get(id);
  const r = s.ping.get(id);
  const pop = m?.pop ? `PoP ${m.pop}${m.via === 'geometry' ? ' (by location)' : ''}` : 'PoP unknown';
  const rtt = r?.rtt !== null && r ? `${ms(r.rtt)} to k-root (ping ${r.msm}, ${ago(r.ts)})` : 'no recent ping';
  return `RIPE Atlas probe ${id} · ${p?.country ?? ''} · ${pop} · ${rtt} · location set by its host, fuzzed`;
}

function setTraceLayer(s) {
  const t = s.trace;
  if (!t?.hops || t.id !== s.selected) return s.ctx.layers.remove(TRACE_GROUP);
  s.ctx.layers.set(TRACE_GROUP, traceGroup((env) => traceStops(s, env)), {
    tooltip: (info) => {
      const o = info.object;
      if (!o?.hops) return null;
      const hs = o.hops.map((n) => t.hops.find((h) => h.hop === n)).filter(Boolean);
      const ips = [...new Set(hs.map((h) => h.ip).filter(Boolean))];
      const rtt = hs.map((h) => h.rtt).filter(Number.isFinite).at(-1);
      return `hop ${o.hops[0]}${o.hops.length > 1 ? `–${o.hops.at(-1)}` : ''} · ${ROLE_LABEL[o.role]}${o.asn ? ` · AS${o.asn}` : ''} · ${ips.slice(0, 2).join(', ')}${ips.length > 2 ? ', …' : ''} · ${ms(rtt)}`;
    },
  });
}

// The traceroute's stops, at places: the dish at the probe, the PoP's gateway
// and Starlink's routers at the PoP (or the PoP a hop's prefix belongs to),
// other hops at their AS's node on this map. Cached per layout.
function traceStops(s, env) {
  const key = `${env.globe}|${env.mode}|${s.ctx.dataset()?.id}|${s.trace?.msm}|${s.trace?.id}`;
  if (s.stops?.key === key) return s.stops.stops;
  const t = s.trace;
  const p = s.probes?.find((x) => x.id === t?.id);
  let stops = [];
  if (p && t?.hops && Number.isFinite(p.lon)) {
    const home = popPos(s, s.match.get(p.id)?.pop);
    const at = (x) => x && [x.lon, x.lat];
    const place = (h) => {
      if (h.role === 'lan') return [p.lon, p.lat];
      if (h.role === 'pop' || h.role === 'starlink' || h.asn === STARLINK_ASN) {
        const other = h.ip && h.kind === 'public' ? popPos(s, s.data?.table.lookup(h.ip)?.pop) : null;
        return at(other) ?? at(home);
      }
      if (!h.asn) return null;
      const q = s.ctx.position(h.asn);
      return q ? [q[0], q[1], env.globe ? q[2] : 0] : null;
    };
    stops = pathStops(t.hops, place);
  }
  s.stops = { key, stops };
  return stops;
}

// --- the panel ---------------------------------------------------------------

function onClick(e) {
  const s = S;
  if (!s) return;
  const b = e.target.closest('button');
  if (!b || !s.el.contains(b)) return;
  if (b.dataset.probe) select(Number(b.dataset.probe), { fly: true });
  else if (b.dataset.clear !== undefined) select(null);
  else if (b.dataset.group) {
    s.groupBy = b.dataset.group;
    s.ctx.hash.set('latby', s.groupBy === 'pop' ? null : s.groupBy);
    render();
  } else if (b.dataset.trace) {
    s.traceKind = b.dataset.trace;
    s.ctx.hash.set('trace', s.traceKind === 'root' ? null : s.traceKind);
    if (s.selected) loadTrace(s, s.selected);
  } else if (b.dataset.pop) {
    const p = popPos(s, b.dataset.pop);
    if (p) s.ctx.flyTo({ lon: p.lon, lat: p.lat, zoom: 4 });
  } else if (b.dataset.geo !== undefined) s.ctx.view.set({ mode: 'geo' });
}

function onToggle(e) {
  if (S && e.target.classList?.contains('atlas-all')) S.listOpen = e.target.open;
}

function render() {
  const s = S;
  if (!s) return;
  const scroll = s.el.querySelector('.atlas-hops')?.scrollTop;
  s.el.innerHTML = `${STYLE}${html(s)}`;
  if (scroll) s.el.querySelector('.atlas-hops') && (s.el.querySelector('.atlas-hops').scrollTop = scroll);
}

function html(s) {
  const head = `<h3 class="atlas-h">RIPE Atlas probes <span class="atlas-badge" title="Measured by RIPE Atlas probes on Starlink dishes">measured</span></h3>`;
  if (s.error) return `${head}<p class="app-warn">${esc(s.error)} Probes and latency come from atlas.ripe.net, live; the rest of the app works without them.</p>`;
  if (!s.probes) return `${head}<p class="muted">Asking RIPE Atlas for the probes on AS${STARLINK_ASN}…</p>`;
  const located = s.probes.filter((p) => s.match.get(p.id)?.pop);
  const pops = new Set(located.map((p) => s.match.get(p.id).pop));
  const byAddr = located.filter((p) => s.match.get(p.id).via !== 'geometry').length;
  const geo = s.ctx.view.get()?.geographic;
  return `${head}
    <p class="muted">${fmt(s.probes.length)} connected <a href="${ATLAS}/probes/?search=&status=1&asn=${STARLINK_ASN}" target="_blank" rel="noopener">probes on AS${STARLINK_ASN}</a>${
      s.data ? ` · ${fmt(located.length)} tied to ${fmt(pops.size)} PoPs (${fmt(byAddr)} by address, ${fmt(located.length - byAddr)} by location)` : ''
    }</p>
    ${s.dataError ? `<p class="app-warn">No Starlink PoP data (${esc(s.dataError)}): build it with <code>python -m netmap starlink</code>. Probes aren't tied to PoPs.</p>` : ''}
    ${geo ? '' : `<p class="app-warn">Probes are places: they show in the geo layout. <button type="button" class="btn" data-geo>Show places</button></p>`}
    <p class="muted atlas-note">Each probe's dot is where its host says it is, fuzzed by Atlas for privacy: approximate. Its PoP is from its public address and Starlink's pops.csv; the line goes to that PoP.</p>
    ${latencyHTML(s)}
    ${s.selected ? probeHTML(s) : '<p class="muted">Pick a probe on the map or below for its traceroute and its last hour.</p>'}
    ${listHTML(s)}`;
}

function latencyHTML(s) {
  if (!s.ping.size) return s.pingError ? `<p class="app-warn">No pings from Atlas (${esc(s.pingError)}).</p>` : '<p class="muted">Fetching the latest pings…</p>';
  const fresh = (p) => p && Date.now() / 1000 - p.ts <= STALE_S;
  const rtt = (id) => (fresh(s.ping.get(id)) ? s.ping.get(id).rtt : null);
  const stale = [...s.ping.values()].filter((p) => !fresh(p)).length;
  const all = stats(s.probes.map((p) => rtt(p.id)));
  const rows =
    s.groupBy === 'pop'
      ? latencyBy(s.probes, (p) => s.match.get(p.id)?.pop ?? null, rtt)
      : latencyBy(s.probes, (p) => regionKey(s.match.get(p.id), p), rtt);
  const ts = [...s.ping.values()].filter(fresh).map((p) => p.ts);
  const label = (k) => {
    if (s.groupBy !== 'pop') return `<span>${esc(s.data?.regionName.get(k) ?? k)}</span>`;
    const p = s.data?.popByCode.get(k);
    return `<button type="button" class="app-link" data-pop="${esc(k)}" title="Fly to ${esc(k)}"><span class="atlas-sw" style="background:rgb(${(s.colours.get(k) ?? GREY).join(',')})"></span>${esc(k)} <span class="muted">${esc(p?.city ?? '')}</span></button>`;
  };
  const pressed = (g) => (s.groupBy === g ? ' aria-pressed="true"' : ' aria-pressed="false"');
  return `
    <div class="atlas-row"><h4>Latency to k.root-servers.net</h4>
      <div class="atlas-seg" role="group" aria-label="Group latency by"><button type="button" data-group="pop"${pressed('pop')}>by PoP</button><button type="button" data-group="region"${pressed('region')}>by region</button></div></div>
    <p class="muted">All probes: median <b>${ms(all.median)}</b>, p90 ${ms(all.p90)} (${fmt(all.n)} probes).</p>
    <div class="atlas-scroll"><table class="atlas-table">
      <thead><tr><th>${s.groupBy === 'pop' ? 'PoP' : 'Region (geofeed)'}</th><th>probes</th><th>median</th><th>p90</th></tr></thead>
      <tbody>${rows.map((g) => `<tr><td>${label(g.key)}</td><td>${fmt(g.n)}</td><td>${ms(g.median)}</td><td>${g.n > 1 ? ms(g.p90) : '—'}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="muted atlas-src">Measured: RIPE Atlas built-in pings ${msmLink(BUILTIN.ping[4].id)} (IPv4) and ${msmLink(BUILTIN.ping[6].id)} (IPv6-only probes), every ${PING_INTERVAL_S / 60} min; each probe's latest result, the median of its 3 replies, ${ts.length ? `${when(Math.min(...ts))} to ${when(Math.max(...ts))}` : ''}${stale ? ` (${fmt(stale)} older than ${STALE_S / 3600} h left out)` : ''}. k-root is anycast: this is the dish to the nearest instance, the satellite hop included.</p>`;
}

function probeHTML(s) {
  const id = s.selected;
  const p = s.probes.find((x) => x.id === id);
  if (!p) return `<div class="atlas-probe"><p class="app-warn">Probe ${id} isn't among the connected Starlink probes. <button type="button" class="btn" data-clear>Clear</button></p></div>`;
  const m = s.match.get(id);
  const r = s.ping.get(id);
  const via = { address: 'its address', result: "its latest result's source address", address_v6: 'its IPv6 address', prefix: 'its announced prefix', geometry: 'its location (no address)' }[m?.via] ?? '';
  const pop = m?.pop && s.data?.popByCode.get(m.pop);
  const geoCheck =
    m?.geo && m.via !== 'geometry'
      ? m.agrees
        ? `<span class="muted">· its location agrees</span>`
        : `<span class="muted">· the geofeed region nearest its location (${fmt(m.geo.km)} km) is mostly served by ${esc(m.geo.pop)}</span>`
      : '';
  const tags = p.tags.filter((t) => !t.startsWith('system-')).slice(0, 6);
  return `<div class="atlas-probe">
    <div class="atlas-row"><h4>Probe <a href="${probeUrl(id)}" target="_blank" rel="noopener">${id}</a>${p.anchor ? ' (anchor)' : ''}</h4>
      <button type="button" class="btn" data-clear aria-label="Clear the probe">✕</button></div>
    <dl>
      <dt>PoP</dt><dd>${m?.pop ? `<span class="atlas-sw" style="background:rgb(${(s.colours.get(m.pop) ?? GREY).join(',')})"></span><b>${esc(m.pop)}</b> ${esc(pop?.city ?? '')}${pop?.country ? `, ${esc(pop.country)}` : ''} <span class="muted">by ${via}</span> ${geoCheck}` : '<span class="muted">unknown</span>'}</dd>
      <dt>Location</dt><dd>${Number.isFinite(p.lat) ? `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}` : '—'} ${esc(p.country ?? '')} <span class="muted">(set by its host, fuzzed)</span></dd>
      <dt>RTT</dt><dd>${r ? `${ms(r.rtt)} <span class="muted">to ${esc(r.dst)}, ping ${msmLink(r.msm)}, ${when(r.ts)} (${ago(r.ts)})</span>` : '<span class="muted">no recent ping</span>'}</dd>
      ${tags.length ? `<dt>Tags</dt><dd class="muted">${tags.map(esc).join(', ')}</dd>` : ''}
    </dl>
    ${seriesHTML(s)}
    ${traceHTML(s)}
  </div>`;
}

function seriesHTML(s) {
  const t = s.series;
  if (!t) return '';
  const head = `<h4>The last hour</h4>`;
  if (t.loading) return `${head}<p class="muted">Fetching ping ${t.msm}'s results…</p>`;
  if (t.error) return `${head}<p class="app-warn">No results (${esc(t.error)}).</p>`;
  if (!t.data.length) return `${head}<p class="muted">No replies in the last hour.</p>`;
  return `${head}${chartSVG(t)}
    <p class="muted atlas-src">Measured: ping ${msmLink(t.msm)}, ${when(t.start)} to ${when(t.stop)}; dots are the median of each result's replies, bars their range. ${
      resolvesReconfig(t.data)
        ? 'Dashed lines: the 15 s satellite reconfigurations, at seconds 12, 27, 42 and 57 of each minute (from arXiv 2307.00402).'
        : `One result every ${fmt(Math.round(resolutionS(t.data) ?? PING_INTERVAL_S))} s is too sparse to show Starlink's 15 s reconfigurations (seconds 12, 27, 42 and 57 of each minute, per arXiv 2307.00402).`
    }</p>`;
}

function chartSVG(t) {
  const W = 320;
  const H = 120;
  const L = 42;
  const R = 6;
  const T = 6;
  const B = 18;
  const lo = Math.min(...t.data.map((d) => d.min));
  const hi = Math.max(...t.data.map((d) => d.max));
  const y0 = Math.max(0, Math.floor((lo - 5) / 10) * 10);
  const y1 = Math.ceil((hi + 5) / 10) * 10;
  const x = (ts) => L + ((ts - t.start) / (t.stop - t.start)) * (W - L - R);
  const y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const grid = [y0, (y0 + y1) / 2, y1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${Math.round(v)} ms</text>`).join('');
  const bounds = resolvesReconfig(t.data) ? reconfigBoundaries(t.start, t.stop).map((b) => `<line x1="${x(b)}" x2="${x(b)}" y1="${T}" y2="${H - B}" class="b"/>`).join('') : '';
  const line = t.data.map((d, k) => `${k ? 'L' : 'M'}${x(d.ts).toFixed(1)},${y(d.rtt).toFixed(1)}`).join('');
  const dots = t.data
    .map(
      (d) => `<g><title>${when(d.ts)}: ${ms(d.rtt)} (${d.rtts.map((v) => v.toFixed(1)).join(', ')} ms)</title>
        <line x1="${x(d.ts)}" x2="${x(d.ts)}" y1="${y(d.min)}" y2="${y(d.max)}" class="w"/><circle cx="${x(d.ts)}" cy="${y(d.rtt)}" r="4" class="d"/><circle cx="${x(d.ts)}" cy="${y(d.rtt)}" r="9" class="hit"/></g>`,
    )
    .join('');
  return `<svg class="atlas-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="RTT over the last hour, ${t.data.length} results">
    ${grid}${bounds}<path d="${line}" class="l"/>${dots}
    <text x="${L}" y="${H - 4}">−60 min</text><text x="${W - R}" y="${H - 4}" text-anchor="end">now</text>
  </svg>`;
}

function traceHTML(s) {
  const t = s.trace;
  const pressed = (k) => (s.traceKind === k ? ' aria-pressed="true"' : ' aria-pressed="false"');
  const head = `<div class="atlas-row"><h4>Latest traceroute</h4>
    <div class="atlas-seg" role="group" aria-label="Traceroute target">${Object.entries(TRACE_KINDS)
      .map(([k, v]) => `<button type="button" data-trace="${k}"${pressed(k)}>${v.label}</button>`)
      .join('')}</div></div>`;
  if (!t) return head;
  if (t.error) return `${head}<p class="app-warn">No traceroute from measurement ${msmLink(t.msm)} (${esc(t.error)}).</p>`;
  if (!t.hops) return `${head}<p class="muted">Fetching traceroute ${t.msm}…</p>`;
  const { tr } = t;
  const pr = popRtt(t.hops);
  const rows = t.hops
    .map((h) => {
      const c = ROLE_COLOURS[h.role] ?? [255, 255, 255];
      const asn = h.asn ? `<span class="asn">AS${h.asn}</span>` : h.kind === 'public' ? (t.loading ? '…' : '') : `<span class="muted">${h.kind === 'cgnat' ? 'CGNAT' : h.kind ?? ''}</span>`;
      return `<li title="${esc(ROLE_LABEL[h.role])}${h.ips.length > 1 ? ` · ${esc(h.ips.join(', '))}` : ''}"><span class="n">${h.hop}</span><span class="atlas-sw" style="background:rgb(${c.join(',')})" aria-label="${esc(ROLE_LABEL[h.role])}"></span><span class="ip">${h.ip ? esc(h.ip) : '<span class="muted">* * *</span>'}</span><span>${asn}</span><span class="r">${ms(h.rtt)}</span></li>`;
    })
    .join('');
  return `${head}
    <p class="muted">To ${esc(tr.dst)}${tr.dst !== tr.dstAddr ? ` (${esc(tr.dstAddr)})` : ''}, ${esc(tr.proto ?? '')} IPv${tr.af}, ${tr.reached ? 'reached' : 'not reached'}${pr !== null ? `; ${ms(pr)} to the PoP` : ''}.</p>
    <ol class="atlas-hops">${rows}</ol>
    <p class="atlas-legend">${Object.entries(ROLE_LABEL)
      .map(([k, v]) => `<span><span class="atlas-sw" style="background:rgb(${ROLE_COLOURS[k].join(',')})"></span>${v}</span>`)
      .join('')}</p>
    <p class="muted atlas-src">Measured: RIPE Atlas built-in traceroute ${msmLink(tr.msm)}, ${when(tr.ts)} (${ago(tr.ts)}). Hops' ASes from RIPEstat network-info${t.loading ? ' (resolving…)' : ''}; on the map the dish is at the probe, the PoP gateway and Starlink's routers at its PoP, and the rest at their AS's node on this map, not the routers' own places.</p>`;
}

function listHTML(s) {
  const rows = [...s.probes]
    .sort((a, b) => (s.match.get(a.id)?.pop ?? '~').localeCompare(s.match.get(b.id)?.pop ?? '~') || a.id - b.id)
    .map((p) => {
      const m = s.match.get(p.id);
      return `<li><button type="button" class="app-link${p.id === s.selected ? ' on' : ''}" data-probe="${p.id}"><span class="atlas-sw" style="background:rgb(${(s.colours.get(m?.pop) ?? GREY).join(',')})"></span>${p.id} <span class="muted">${esc(m?.pop ?? '?')} · ${esc(p.country ?? '')} · ${ms(s.ping.get(p.id)?.rtt)}</span></button></li>`;
    })
    .join('');
  return `<details class="atlas-all"${s.listOpen ? ' open' : ''}><summary>All ${fmt(s.probes.length)} probes</summary><ul class="app-nbrs">${rows}</ul></details>`;
}

const STYLE = `<style>
.atlas .atlas-h { display: flex; align-items: center; gap: 8px; }
.atlas .atlas-badge { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #8fe3a6; border: 1px solid rgba(120,230,140,.45); border-radius: 4px; padding: 0 4px; }
.atlas h4 { margin: 12px 0 4px; font-size: 13px; }
.atlas .atlas-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.atlas .atlas-row h4 { margin-bottom: 4px; }
.atlas .atlas-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; flex: none; }
.atlas .atlas-seg button { background: none; border: 0; color: var(--muted); font: inherit; font-size: 12px; padding: 2px 8px; cursor: pointer; }
.atlas .atlas-seg button[aria-pressed="true"] { background: var(--hover); color: var(--fg); }
.atlas .atlas-note, .atlas .atlas-src { font-size: 11px; line-height: 1.4; }
.atlas .atlas-src a, .atlas dd a, .atlas h4 a, .atlas p a { color: var(--accent); }
.atlas .atlas-scroll { max-height: 240px; overflow: auto; }
.atlas .atlas-table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.atlas .atlas-table th { text-align: left; font-weight: 500; color: var(--muted); position: sticky; top: 0; background: var(--panel); }
.atlas .atlas-table th, .atlas .atlas-table td { padding: 2px 4px; border-bottom: 1px solid var(--line); }
.atlas .atlas-table td:nth-child(n+2), .atlas .atlas-table th:nth-child(n+2) { text-align: right; white-space: nowrap; }
.atlas .atlas-table .app-link { padding: 0; }
.atlas .atlas-sw { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: 1px; }
.atlas .atlas-probe { border-top: 1px solid var(--line); margin-top: 10px; }
.atlas .atlas-probe dl { font-size: 12px; }
.atlas .atlas-chart { width: 100%; height: auto; display: block; }
.atlas .atlas-chart text { fill: var(--muted); font-size: 9px; }
.atlas .atlas-chart .g { stroke: var(--line); }
.atlas .atlas-chart .b { stroke: rgba(255,210,80,.35); stroke-dasharray: 2 2; }
.atlas .atlas-chart .l { fill: none; stroke: var(--accent); stroke-width: 2; opacity: .6; }
.atlas .atlas-chart .w { stroke: var(--accent); stroke-width: 1; opacity: .5; }
.atlas .atlas-chart .d { fill: var(--accent); stroke: var(--panel); stroke-width: 2; }
.atlas .atlas-chart .hit { fill: transparent; }
.atlas .atlas-hops { list-style: none; margin: 0; padding: 0; font-size: 11px; font-variant-numeric: tabular-nums; max-height: 260px; overflow: auto; }
.atlas .atlas-hops li { display: grid; grid-template-columns: 18px 10px minmax(0, 1fr) auto 48px; align-items: center; gap: 4px; padding: 1px 0; border-bottom: 1px solid var(--line); }
.atlas .atlas-hops .atlas-sw { margin: 0; }
.atlas .atlas-hops .ip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; }
.atlas .atlas-hops .n, .atlas .atlas-hops .r { text-align: right; color: var(--muted); }
.atlas .atlas-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--muted); margin: 4px 0; }
.atlas .atlas-all ul { max-height: 260px; overflow: auto; }
.atlas .app-link.on { color: var(--accent); }
</style>`;

export default { id: 'atlas', mount, unmount, onHash };
