// The Starlink app's links section (#34, #35): Starlink's gateways, and the
// modelled links for a dish placed on the map: the satellites in view, the
// serving satellite, the gateways it sees (or the laser path to one that
// does), and the gateway's PoP, with each leg's slant range and light time,
// compared with fibre. Also the modelled laser mesh (+Grid) and an estimate
// of where the traffic goes. Satellite positions are propagated with SGP4
// from CelesTrak's elements in a Web Worker (engine.js), once a second on
// netmap's clock. Uses only ctx (apps/README.md).
//
// Permalink: starlink.at=<lat>,<lon> (the dish), starlink.sat=<norad> (a
// satellite selected; it serves the dish while it's in view),
// starlink.mask=<°> (the dish's elevation mask, if not 25),
// starlink.dest=<PoP code> (a destination to compare with fibre), and the
// gateways, links, mesh and traffic entries of starlink.layer.

import { esc, fmt } from '../../util.js';
import { layersParam, parseLayers } from '../pops/data.js';
import { createEngine } from './engine.js';
import { loadElements } from './elements.js';
import { createLinkLayers } from './mapLayers.js';
import { GRID } from './grid.js';
import { atParam, fmtAge, fmtDeg, fmtKm, fmtLatLon, fmtMs, parseAt } from './format.js';
import { RAMP_CSS } from './mapLayers.js';
import { coverageAngle, EARTH_MEAN_KM, gcKm } from './geometry.js';
import { MODEL } from './model.js';
import { LASER_CUTOFF } from './orbit.js';

const MY_LAYERS = ['gateways', 'links', 'mesh', 'traffic'];
const LAYER_NAMES = { gateways: 'Gateways', links: 'Links', mesh: 'Laser mesh', traffic: 'Traffic (estimate)' };
const TICK_MS = 1000;
const MASKS = [25, 40];
export const PRESETS = [
  { id: 'kansas', label: 'Kansas', lat: 38.5, lon: -98.5 },
  { id: 'pacific', label: 'Mid-Pacific', lat: 10, lon: -150 },
  { id: 'atlantic', label: 'North Atlantic', lat: 45, lon: -35 },
  { id: 'svalbard', label: 'Svalbard', lat: 78.2, lon: 15.6 },
];
const RULES = {
  'bent-pipe': 'the highest satellite in view that also sees a gateway (a "bent pipe")',
  laser: 'the satellite in view with the shortest path over lasers to a gateway',
  'no-gateway': 'the highest satellite in view: none of them sees a gateway or has a laser path to one',
  pinned: 'the satellite you selected',
};

// The element sets, fetched once per page (they're about 1 MB).
let elementsOnce = null;

let ctx = null;
let root = null;
let st = null;

const fresh = () => ({
  status: 'loading', // 'loading' | 'ok' | 'error'
  error: null,
  gateways: null, // gateways.json
  gwRows: [], // its rows, with index and nearest PoP
  pops: [],
  regions: [],
  elements: null, // { source, fetched, epochs, tried }
  ready: false,
  summary: null,
  timings: null,
  result: null, // the last tick
  at: null, // { lat, lon }
  sat: null, // a NORAD id
  mask: MODEL.userMask,
  layers: new Set(MY_LAYERS),
  picking: false,
  timer: 0,
  engine: null,
  open: { how: false, gws: false },
  lastTickT: null,
  dest: null, // a PoP code
});

const view = {
  dish: () => (st?.layers.has('links') ? st.result?.dish ?? null : null),
  sat: () => (st?.layers.has('links') ? st.result?.sat ?? null : null),
  mesh: () => st?.result?.mesh ?? null,
  traffic: () => st?.result?.traffic ?? null,
  gateways: () => st?.gwRows ?? [],
  layers: () => st?.layers ?? new Set(),
  picking: () => !!st?.picking,
  placeAt: (lon, lat) => place({ lat, lon }, 'click'),
  pickSat: (norad) => selectSat(norad, 'map'),
};
const map = createLinkLayers(view);

// --- data ---

async function getJSON(url) {
  const res = await fetch(url, { signal: ctx.signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!/json/.test(res.headers.get('content-type') ?? '')) return null;
  return res.json();
}

async function load() {
  const base = `${ctx.dataBase}/starlink`;
  try {
    const [gateways, pops, regions] = await Promise.all([getJSON(`${base}/gateways.json`), getJSON(`${base}/pops.json`), getJSON(`${base}/regions.json`)]);
    if (!st) return;
    st.gateways = gateways;
    st.gwLoaded = true;
    st.pops = pops ?? [];
    st.regions = regions ?? [];
    st.gwRows = (gateways?.gateways ?? []).map((g, index) => {
      let best = null, km = Infinity;
      for (const p of st.pops) {
        if (!Number.isFinite(p.lat)) continue;
        const d = gcKm(g.lon, g.lat, p.lon, p.lat);
        if (d < km) (km = d), (best = p);
      }
      return { ...g, index, pop: best?.code ?? null, popKm: best ? km : null };
    });
    render();
    ctx.layers.redraw();
    elementsOnce ??= loadElements({ dataBase: ctx.dataBase }).catch((err) => {
      elementsOnce = null;
      throw err;
    });
    const el = await elementsOnce;
    if (!st) return;
    st.elements = el;
    st.engine = createEngine({ onTick, onError });
    const t0 = performance.now();
    await st.engine.init({ omm: el.omm, gateways: st.gwRows, pops: st.pops, regions: st.regions });
    if (!st) return;
    st.timings = { init: performance.now() - t0 };
    st.ready = true;
    st.status = 'ok';
    tick();
    st.timer = setInterval(() => ctx?.clock.live && !document.hidden && tick(), TICK_MS);
  } catch (err) {
    if (err?.name === 'AbortError' || !st) return;
    st.status = 'error';
    st.error = err.message;
    render();
  }
}

function onTick(r) {
  if (!st) return;
  st.result = r;
  if (r.summary) st.summary = r.summary;
  st.timings = { ...st.timings, ...r.timings };
  if (r.missingSat && st.sat !== null) st.missingSat = st.sat;
  renderLive();
  ctx.layers.redraw();
}

function onError(err) {
  if (!st) return;
  st.status = 'error';
  st.error = err.message;
  render();
}

// The part of the mesh to draw: on the globe, links within a radius of the
// camera (the far side is hidden anyway); on the 2D map, all of them.
function meshView() {
  const v = ctx.view.get();
  if (!v || v.view !== 'globe') return { flat: true, radius: 180 };
  const c = v.camera;
  return { lon: c.lon, lat: c.lat, radius: Math.max(32, Math.min(100, 130 / 2 ** Math.max(0, c.zoom - 1.2))) };
}

// One tick: the model at netmap's clock, for the dish, the selected
// satellite, and the mesh and traffic if they're on.
function tick() {
  if (!st?.ready) return;
  const links = st.layers.has('links'), mesh = st.layers.has('mesh'), traffic = st.layers.has('traffic');
  if (!links && !mesh && !traffic && st.result) return; // nothing drawn needs it
  const t = ctx.clock.now();
  st.lastTickT = t;
  const dest = st.dest ? st.pops.findIndex((p) => p.code === st.dest) : -1;
  st.engine.tick({
    t,
    dish: links && st.at ? { lon: st.at.lon, lat: st.at.lat } : null,
    sat: links ? st.sat : null,
    opts: { userMask: st.mask, gwMask: MODEL.gwMask, dest: dest >= 0 ? dest : null },
    mesh,
    traffic,
    view: mesh ? meshView() : null,
    check: orbitsCheck(),
  });
}

// celestiary's Orbits layer, when it's on: the Starlink satellites it links
// to AS14593, to check the model's positions against.
function orbitsCheck() {
  if (!ctx.orbits.active()) return null;
  const anchors = ctx.orbits.starlinkLinks().map((a) => ({ id: a.id, lon: a.lon, lat: a.lat }));
  const t = ctx.orbits.time();
  return anchors.length && t ? { t, anchors } : null;
}

// --- the dish, the satellite, the layers ---

function place(p, how) {
  if (!st || !p) return;
  st.at = { lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3) };
  st.picking = false;
  ctx.hash.set('at', atParam(st.at));
  ctx.track('starlink_link_model', { action: 'place', how });
  if (!st.layers.has('links')) toggleLayer('links', true, false);
  render();
  ctx.layers.redraw();
  tick();
}

function selectSat(norad, how) {
  if (!st) return;
  st.sat = norad === st.sat ? null : norad;
  ctx.hash.set('sat', st.sat === null ? null : String(st.sat));
  ctx.track('starlink_link_model', { action: st.sat === null ? 'sat_clear' : 'sat_select', how });
  tick();
  render();
}

function toggleLayer(name, on, track = true) {
  const all = parseLayers(ctx.hash.get('layer')); // other sections' layers share the param
  if (on) all.add(name);
  else all.delete(name);
  ctx.hash.set('layer', layersParam(all));
  st.layers = new Set(MY_LAYERS.filter((l) => all.has(l)));
  if (track) ctx.track('starlink_link_model', { action: 'layer', layer: name, on: !!on });
  ctx.layers.redraw();
  tick();
}

function useMyLocation() {
  if (!navigator.geolocation) return ctx.notice('This browser has no location service.');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // Rounded to 0.1° (about 10 km) before it goes into the permalink.
      const p = { lat: Math.round(pos.coords.latitude * 10) / 10, lon: Math.round(pos.coords.longitude * 10) / 10 };
      place(p, 'location');
      ctx.flyTo({ lon: p.lon, lat: p.lat, zoom: 4 });
    },
    () => ctx?.notice('Location unavailable (not allowed, or no fix).'),
    { maximumAge: 600000, timeout: 15000 },
  );
}

// --- the panel ---

const badge = '<span class="sl-badge" title="Computed from a model, not measured">modelled</span>';

function render() {
  if (!root || !st) return;
  root.innerHTML = `<section class="sl-links">${body()}</section>`;
  wire();
  renderLive();
}

function body() {
  const head = `<h3>Gateways and links ${badge}</h3>`;
  if (st.status === 'error' && !st.gateways) return `${head}<p class="app-warn">The link model couldn't load: ${esc(st.error)}</p>`;
  const g = st.gateways;
  const c = g?.counts;
  return `
    ${head}
    <p class="muted">${
      !st.gwLoaded
        ? 'Loading gateway sites…'
        : g
        ? `${fmt(c.gateways)} gateway sites: ${fmt(c.filing)} from FCC earth-station licences (solid), ${fmt(c.reported)} reported elsewhere (rings, placed at their town). Starlink runs more than are public, above all outside the US.`
        : 'No gateway data in this build: make it with <code>python -m netmap starlink-gateways</code> (README, "Starlink data").'
    }</p>
    <div class="sl-layers" role="group" aria-label="Link model layers">
      ${MY_LAYERS.map((l) => `<label><input type="checkbox" data-layer="${l}"${st.layers.has(l) ? ' checked' : ''}> ${LAYER_NAMES[l]}</label>`).join('')}
    </div>
    <div class="app-actions sl-place">
      <button type="button" class="btn${st.picking ? ' primary' : ''}" data-pick aria-pressed="${st.picking}">${st.picking ? 'Click the map…' : st.at ? 'Move the dish' : 'Place a dish'}</button>
      <button type="button" class="btn" data-geo title="Your browser's location, rounded to 0.1°">My location</button>
      <select data-preset aria-label="Place the dish at an example place"><option value="">Examples…</option>${PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select>
    </div>
    ${st.picking ? '<p class="muted sl-small">Click anywhere on the map or the globe to put the dish there.</p>' : ''}
    <div class="sl-live"></div>
    ${destHTML()}
    <label class="sl-mask">Dish elevation mask <select data-mask>${MASKS.map((m) => `<option value="${m}"${m === st.mask ? ' selected' : ''}>${m}°</option>`).join('')}</select>
      <span class="muted">gateways ${MODEL.gwMask}°</span></label>
    ${gatewaysHTML()}
    ${howHTML()}
    <p class="muted sl-small sl-elements">${elementsHTML()}</p>`;
}

function liveHTML() {
  if (st.status === 'loading' || !st.ready) return `<p class="muted">${st.elements ? 'Building the model…' : 'Loading the constellation\'s elements…'}</p>`;
  if (st.status === 'error') return `<p class="app-warn">The link model failed: ${esc(st.error)}</p>`;
  const r = st.result;
  if (!r) return '<p class="muted">Propagating…</p>';
  const extra = `${meshHTML()}${trafficHTML()}`;
  if (!st.layers.has('links')) return `<p class="muted">Turn on <i>Links</i> to model a dish's links.</p>${extra}`;
  const when = `<p class="muted sl-small sl-when">At ${esc(new Date(r.t).toISOString().slice(11, 19))} UTC${ctx.clock.live ? '' : ' (clock stopped)'} · scheduling slot ${slotLabel(r.t)}</p>`;
  const sel = r.sat && (!r.dish?.serving || r.dish.serving.norad !== r.sat.norad) ? satHTML(r.sat, 'Selected satellite') : '';
  const miss = st.missingSat === st.sat && st.sat !== null && !r.sat ? `<p class="app-warn">NORAD ${esc(st.sat)} isn't in these elements.</p>` : '';
  if (!r.dish) return `${when}<p class="muted">Place a dish to model its links: the satellites it sees, the one serving it, the gateways that one sees (or the laser path to one), and the PoP behind the gateway.</p>${sel}${miss}${extra}`;
  return `${when}${dishHTML(r.dish)}${sel}${miss}${extra}`;
}

function slotLabel(t) {
  const s = Math.floor(((t - MODEL.slotOffsetMs) % 60000 + 60000) % 60000 / MODEL.slotMs);
  const a = (MODEL.slotOffsetMs / 1000 + 15 * s) % 60;
  return `:${String(a).padStart(2, '0')}–:${String((a + 15) % 60).padStart(2, '0')}`;
}

function dishHTML(d) {
  const s = d.serving;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const where = `${fmtLatLon(d.user.lat, d.user.lon)} · ${fmt(d.nVisible)} satellites above ${d.mask}°, ${fmt(d.nTerminal)} of them see a gateway`;
  if (!s) return `<dl>${row('Dish', where)}</dl><p class="app-warn">No satellite in service is above ${d.mask}° here now.</p>`;
  const gw = d.exit;
  const gwRow = gw ? gwLink(gw) : null;
  return `
    <dl class="sl-dl">
      ${row('Dish', where)}
      ${row('Serving', `${satButton(s)} <span class="muted">· ${esc(s.shell ?? '')} · ${fmtDeg(s.el)} up, azimuth ${fmtDeg(s.az)} · lasers: ${s.laser ? 'yes' : 'no'}</span><br><span class="muted sl-small">Picked as ${RULES[s.rule]}${s.held ? ', held for its 15 s slot' : ''}.</span>`)}
      ${d.route ? row('Lasers', `${fmt(d.route.hops)} hop${d.route.hops > 1 ? 's' : ''}, ${fmtKm(d.route.km)} <span class="muted">· none of the gateways is in the serving satellite's view (its footprint at ${d.gwMask}°: ${fmtKm(EARTH_MEAN_KM * (s.footprint * Math.PI / 180))} radius), so the traffic crosses to ${satButton(d.exit.sat)}, which sees one</span>`) : ''}
      ${row('Gateway', gw ? `${gwRow}${d.route ? '' : ` <span class="muted">· ${fmt(d.gateways.length)} in this satellite's view</span>`}` : `<span class="app-warn-inline">none in this satellite's view (its footprint at ${d.gwMask}°: ${fmtKm(EARTH_MEAN_KM * (s.footprint * Math.PI / 180))} radius), and no laser path to one</span>`)}
      ${gw ? row('PoP', `<code>${esc(gw.popCode)}</code> ${esc(gw.popCity ?? '')} <span class="muted">· the gateway's nearest, ${fmtKm(gw.backhaulKm)} of fibre</span>`) : ''}
    </dl>
    ${gw ? budgetHTML(d) : ''}
    ${d.gateways.length > 1 ? `<details class="sl-gws-inview"><summary>Gateways this satellite sees (${d.gateways.length})</summary><ol>${d.gateways.map((g) => `<li>${esc(g.name)} <span class="muted">· ${fmtKm(g.range)} · PoP ${esc(g.popCode ?? '—')} ${fmtKm(g.backhaulKm)}</span></li>`).join('')}</ol></details>` : ''}`;
}

function budgetHTML(d) {
  const L = d.latency;
  const leg = (name, km, ms, cls = '') => `<tr class="${cls}"><th scope="row">${name}</th><td>${fmtKm(km)}</td><td>${fmtMs(ms)}</td></tr>`;
  const e = d.exit;
  return `
    <table class="sl-budget">
      <thead><tr><th scope="col">Leg ${badge}</th><th scope="col">distance</th><th scope="col">one way</th></tr></thead>
      <tbody>
        ${leg('<span class="sl-key up"></span>Uplink, radio', d.serving.range, L.up)}
        ${d.route ? leg(`<span class="sl-key laser"></span>Lasers, ${d.route.hops} hop${d.route.hops > 1 ? 's' : ''}`, d.route.km, L.isl) : ''}
        ${leg('<span class="sl-key down"></span>Downlink, radio', e.range, L.down)}
        ${leg('<span class="sl-key fibre"></span>Backhaul, fibre', e.backhaulKm, L.backhaul)}
        ${leg('Total', d.serving.range + (d.route?.km ?? 0) + e.range + e.backhaulKm, L.total, 'sl-total')}
      </tbody>
    </table>
    <p class="muted sl-small">${fmtMs(2 * L.total)} round trip, light time only: radio and lasers at c, fibre at c/1.47 along the great circle. Measured round trips are longer: the scheduler's frames, queueing, processing and the fibre's detours aren't modelled.</p>
    ${fibreHTML(d)}`;
}

// The space path against fibre along the great circle (a lower bound for fibre: real cables detour).
function fibreHTML(d) {
  const f = d.fibre;
  if (!f) return '';
  const vs = (a, b) => (a < b ? `<b>${fmtMs(b - a)} faster</b>` : `${fmtMs(a - b)} slower`);
  return `
    <p class="sl-small sl-fibre">Versus fibre: to the PoP along the great circle, ${fmtKm(f.pop.km)}, is ${fmtMs(f.pop.ms)}; through space, ${fmtMs(d.latency.total)}, ${vs(d.latency.total, f.pop.ms)}.${f.dest ? ` To ${esc(f.dest.city || f.dest.code)} (<code>${esc(f.dest.code)}</code>): through space then fibre on from the PoP (${fmtKm(f.dest.onwardKm)}), ${fmtMs(f.dest.viaMs)}; fibre all the way, ${fmtKm(f.dest.directKm)}, ${fmtMs(f.dest.directMs)}: space is ${vs(f.dest.viaMs, f.dest.directMs)}.` : ''}</p>`;
}

// The destination to compare with fibre (outside the live block, so a tick doesn't close it).
function destHTML() {
  if (!st.at || !st.layers.has('links') || !st.pops.length) return '';
  const placed = st.pops.filter((p) => Number.isFinite(p.lat)).sort((a, b) => (a.city || a.code).localeCompare(b.city || b.code));
  return `<label class="sl-mask">Compare with fibre to <select data-dest><option value="">a destination PoP…</option>${placed.map((p) => `<option value="${esc(p.code)}"${p.code === st.dest ? ' selected' : ''}>${esc(p.city || p.code)} (${esc(p.code)})</option>`).join('')}</select></label>`;
}

function meshHTML() {
  const s = st.summary;
  if (!st.layers.has('mesh') || !s) return '';
  const m = st.result?.mesh;
  return `
    <div class="sl-block">
      <h4>Laser mesh ${badge}</h4>
      <p class="sl-small">${fmt(s.links)} links in a +Grid among ${fmt(s.laser)} satellites with lasers in ${s.shells.filter((x) => x.inService).length} shells: each to the satellites before and after it in its plane, and to the nearest in each neighbouring plane. ${fmt(s.linksUp)} up now (within ${fmtKm(GRID.maxRangeKm)}, clear of the Earth by ${GRID.grazeKm} km)${m && m.n < s.linksUp ? `, ${fmt(m.n)} drawn (the side of the globe in view)` : ''}. Rebuilt every 15 s.</p>
      <p class="sl-legend">${s.shells.filter((x) => x.inService).map((x) => `<span><i style="background:rgb(${shellRGB(x.incl)})"></i>${esc(x.label)}</span>`).join('')}</p>
    </div>`;
}

const shellRGB = (incl) => (incl < 48 ? '111,224,200' : incl < 60 ? '127,184,255' : incl < 80 ? '200,160,255' : '255,168,216');

function trafficHTML() {
  if (!st.layers.has('traffic')) return '';
  const t = st.result?.traffic;
  if (!t) return '<div class="sl-block"><h4>Traffic <span class="sl-badge est">estimate</span></h4><p class="muted sl-small">Assigning the demand…</p></div>';
  const x = t.stats;
  const pct = (v) => `${(100 * v).toFixed(v < 0.1 ? 1 : 0)}%`;
  return `
    <div class="sl-block sl-traffic">
      <h4>Traffic <span class="sl-badge est">estimate</span></h4>
      <p class="app-warn sl-small">No measured traffic data is public. This spreads demand by the geofeed's IPv4 address counts over the model's paths: a picture of the model, not of Starlink's load.</p>
      <p class="sl-small">Demand: ${fmt(x.regions)} customer regions, weighted by their IPv4 addresses (${fmt(x.total)}), each on its serving satellite (re-assigned every 15 s). ${pct(x.bent)} goes straight down to a gateway, ${pct(x.laser)} over lasers first (${x.hops.toFixed(1)} hops on average)${x.unserved > 0.0005 ? `, ${pct(x.unserved)} finds no way down` : ''}.</p>
      <p class="sl-ramp"><span>light</span><i style="background:${RAMP_CSS}"></i><span>heaviest</span></p>
      <ol class="sl-gwload">${t.gateways.slice(0, 8).map((g) => `<li><span class="sl-bar" style="--w:${Math.max(2, Math.round(g.rel * 100))}%"></span><span class="sl-rname">${esc(g.name)}</span><span class="sl-num">${pct(g.share)}</span></li>`).join('')}</ol>
      <p class="muted sl-small">Share of the demand by gateway. Where this list has no gateway near a region, its demand lands on the nearest it has, so those look busier than they are (South America's on Falda del Carmen, for one).</p>
    </div>`;
}

const satButton = (s) => `<button type="button" class="app-link" data-sat="${s.norad}" title="Select this satellite (it serves the dish while it's in view)">${esc(s.name || `NORAD ${s.norad}`)}</button> <span class="muted">NORAD ${s.norad}</span>`;

function gwLink(g) {
  const row = st.gwRows[g.g];
  const src = row?.tier === 'filing' ? (row.filing_url ? ` <a href="${esc(row.filing_url)}" target="_blank" rel="noopener" title="Its FCC earth-station licence">${esc(row.filing)}</a>` : '') : ' <span class="muted">(reported; placed at its town)</span>';
  return `${esc(g.name)}${row ? `, ${esc(row.country)}` : ''}${src} <span class="muted">· ${fmtKm(g.range)}</span>`;
}

function satHTML(s, title) {
  return `
    <div class="sl-sat">
      <h4>${title}: ${satButton(s)}</h4>
      <p class="muted sl-small">${esc(s.cospar)} · ${s.shell ? esc(s.shell) : 'not in a shell in service (raising, lowering or drifting)'} · lasers: ${s.laser ? 'yes' : `no (launched before ${LASER_CUTOFF.date})`} · ${fmtLatLon(s.lat, s.lon, 1)}, ${fmtKm(s.alt / 1000)} up · sees ${fmt(s.gateways?.length ?? 0)} gateways</p>
      <div class="app-actions"><button type="button" class="btn" data-unsat>Clear</button></div>
    </div>`;
}

function gatewaysHTML() {
  const g = st.gateways;
  if (!g) return '';
  const by = new Map();
  for (const r of st.gwRows) by.set(r.country, [...(by.get(r.country) ?? []), r]);
  const reach = coverageAngle(470, MODEL.userMask) + coverageAngle(470, MODEL.gwMask);
  const reachKm = (reach * Math.PI / 180) * EARTH_MEAN_KM;
  const far = gapRegions(reachKm);
  return `
    <details class="sl-gw-list" data-open="gws"${st.open.gws ? ' open' : ''}>
      <summary>Gateway sites (${fmt(g.counts.gateways)} in ${fmt(g.counts.countries)} countries)</summary>
      <p class="muted sl-small">From <a href="https://github.com/dotchance/nodalarc" target="_blank" rel="noopener">NodalArc</a>'s catalog (Apache-2.0)${g.sources?.nodalarc?.commit ? ` at <code>${esc(g.sources.nodalarc.commit.slice(0, 7))}</code>` : ''}: sites with an FCC earth-station licence (file numbers below; public domain), and sites it reports as confirmed outside the US. ${fmt(g.counts.cross_checked)} licensed sites agree with <a href="https://github.com/tlrobinson/satsim" target="_blank" rel="noopener">satsim</a>'s list (BSD-2-Clause)${crossCheckNote()}. Left out: ${Object.entries(g.excluded ?? {}).map(([k, v]) => `${fmt(v)} ${esc(k.replace(/_/g, ' '))}`).join(', ')}.</p>
      ${far.length ? `<p class="app-warn sl-small">Gaps: ${fmt(far.length)} of Starlink's customer regions have no gateway here within ${fmtKm(reachKm)}, so no one satellite sees both (${far.slice(0, 6).map((r) => esc(r.city || r.country_name || r.country)).join(', ')}${far.length > 6 ? ', …' : ''}). They're served over lasers in the model, or by gateways this list hasn't got.</p>` : ''}
      <ul class="sl-gws">${[...by.entries()]
        .map(([cc, rows]) => `<li><b>${esc(cc)}</b> ${rows.map((r) => (r.filing_url ? `<a href="${esc(r.filing_url)}" target="_blank" rel="noopener" title="${esc(r.filing)}">${esc(r.name)}</a>` : `<span title="reported, placed at its town">${esc(r.name)}°</span>`)).join(', ')}</li>`)
        .join('')}</ul>
      <p class="muted sl-small">° reported, no filing here.</p>
    </details>`;
}

function crossCheckNote() {
  const off = st.gwRows.filter((r) => r.cross_check && r.cross_check.km > 1);
  return off.length ? ` (except ${off.map((r) => `${esc(r.name)}, ${fmtKm(r.cross_check.km)} apart`).join('; ')})` : ' to within a kilometre';
}

// Customer regions (placed) with no gateway within `km`.
function gapRegions(km) {
  if (!st.gwRows.length) return [];
  const out = [];
  for (const r of st.regions) {
    if (!Number.isFinite(r.lat)) continue;
    let best = Infinity;
    for (const g of st.gwRows) best = Math.min(best, gcKm(r.lon, r.lat, g.lon, g.lat));
    if (best > km) out.push({ ...r, gwKm: best });
  }
  return out.sort((a, b) => (b.v4_addresses ?? 0) - (a.v4_addresses ?? 0));
}

function howHTML() {
  return `
    <details class="app-about sl-how" data-open="how"${st.open.how ? ' open' : ''}>
      <summary>How this is modelled</summary>
      <p><b>Satellites.</b> CelesTrak's general perturbations elements for the Starlink group, propagated with SGP4
        (<a href="https://github.com/shashwatak/satellite-js" target="_blank" rel="noopener">satellite.js</a>) to netmap's clock once a second, in a worker.
        The elements come first from celestiary, so the satellites here are the ones its Orbits layer draws. Shells are clustered from inclination and
        mean altitude, planes from the ascending node. Satellites outside a shell in service (still raising their orbits, lowering, drifting
        between planes or deorbiting) aren't used.</p>
      <p><b>The dish</b> sees the satellites above its elevation mask: ${MODEL.userMask}° (SpaceX's 2018 filing used 40°; FCC 21-48 allowed 25° in 2021).
        <b>The serving satellite</b> is the highest one in view that also sees a gateway, if any does. It's held for the scheduler's 15 s slot
        (re-picked at :12, :27, :42 and :57 past the minute, arXiv <a href="https://arxiv.org/abs/2307.00402" target="_blank" rel="noopener">2307.00402</a>) unless it leaves the dish's view.</p>
      <p><b>Gateways</b> see a satellite above ${MODEL.gwMask}° (an assumption: the licences list antennas, not a serving rule). The traffic comes
        down at the gateway in view with the least downlink plus backhaul, and goes on by fibre to the PoP nearest that gateway
        (Starlink's PoP list says which PoP a prefix is assigned to, not where a gateway's traffic goes).</p>
      <p><b>Lasers.</b> Satellites launched from ${LASER_CUTOFF.date} (${LASER_CUTOFF.label}, the first v1.5) on carry lasers; earlier ones don't.
        Each shell's laser satellites form a +Grid (arXiv <a href="https://arxiv.org/abs/2103.00056" target="_blank" rel="noopener">2103.00056</a>; four terminals each, as in SpaceX's filings):
        the satellites before and after in the same plane, and the nearest in each neighbouring plane, matched shortest first. A link is up within
        ${fmtKm(GRID.maxRangeKm)} and while its line stays ${GRID.grazeKm} km above the surface (both assumptions). The grid is rebuilt every 15 s slot.
        Starlink's real topology, and how it routes over it, aren't public.</p>
      <p><b>Routes.</b> When no satellite in the dish's view sees a gateway, the dish is served by the one with the shortest path in light time
        (Dijkstra over the links that are up) to a satellite that does, which takes it down. A satellite with a gateway in view sends traffic down, not on.</p>
      <p><b>Traffic</b> is an estimate: each of the geofeed's customer regions, weighted by its IPv4 addresses (a proxy for subscribers), is served from
        its point by the same rules, and its weight added along its path: laser links, the feeder link down, the gateway. No population weighting.</p>
      <p><b>Latency</b> is light time: radio and lasers at c over the slant ranges, fibre at c/1.47 along the great circle. Real paths add the
        scheduler, queueing, processing and detours, so the comparison with fibre flatters both.</p>
      <p class="muted">Sources: SpaceX's FCC filings (SAT-MOD-20200417-00037, FCC 21-48; gateway licences SES-LIC-…, linked per site);
        <a href="https://celestrak.org/NORAD/elements/" target="_blank" rel="noopener">CelesTrak</a>; NodalArc's gateway catalog; arXiv 2103.00056 for the +Grid; arXiv 2307.00402 for the 15 s slots.</p>
    </details>`;
}

function elementsHTML() {
  const e = st.elements;
  if (!e) return '';
  const age = e.epochs ? st.lastTickT ?? ctx.clock.now() : null;
  const s = st.summary;
  const t = st.timings ?? {};
  const perf = Number.isFinite(t.propagate)
    ? ` · per tick${st.engine?.inWorker ? ', in a worker' : ''}: ${fmtMs(t.propagate)} to propagate, ${fmtMs(t.gateways)} for the gateways' views${Number.isFinite(t.route) ? `, ${fmtMs(t.meshRefresh)} for the mesh and ${fmtMs(t.route)} to route; every 15 s, ${fmtMs(t.meshBuild)} to rebuild the mesh${Number.isFinite(t.traffic) ? ` and ${fmtMs(t.traffic)} to assign the traffic` : ''}` : ''}`
    : '';
  const ck = st.result?.check;
  const check = ck ? ` The Orbits layer's ${fmt(ck.n)} linked Starlink satellites are within ${fmtKm(ck.maxKm)} of the model's.` : '';
  return `Elements: ${esc(e.source.label)}, fetched ${esc(String(e.fetched).slice(0, 10))}; newest epoch ${e.epochs ? fmtAge(age - e.epochs.max) : '—'} before the model's time, median ${e.epochs ? fmtAge(age - e.epochs.median) : '—'}${s ? `. ${fmt(s.sats)} satellites, ${fmt(s.operational)} in ${s.shells.filter((x) => x.inService).length} shells in service (${s.shells.filter((x) => x.inService).map((x) => esc(x.label)).join(', ')}), ${fmt(s.laser)} with lasers` : ''}${perf}.${check}`;
}

function renderLive() {
  const el = root?.querySelector('.sl-live');
  if (!el || !st) return;
  el.innerHTML = liveHTML();
  for (const b of el.querySelectorAll('[data-sat]')) b.addEventListener('click', () => selectSat(Number(b.dataset.sat), 'panel'));
  el.querySelector('[data-unsat]')?.addEventListener('click', () => selectSat(st.sat, 'panel'));

  for (const d of el.querySelectorAll('details')) {
    const k = d.className;
    if (st.open[k]) d.open = true;
    d.addEventListener('toggle', () => (st.open[k] = d.open));
  }
  const pe = root.querySelector('.sl-elements');
  if (pe) pe.innerHTML = elementsHTML();
}

function wire() {
  for (const c of root.querySelectorAll('[data-layer]')) c.addEventListener('change', () => toggleLayer(c.dataset.layer, c.checked));
  root.querySelector('[data-pick]')?.addEventListener('click', () => {
    st.picking = !st.picking;
    if (st.picking && !st.layers.has('links')) toggleLayer('links', true, false);
    render();
    ctx.layers.redraw();
  });
  root.querySelector('[data-geo]')?.addEventListener('click', useMyLocation);
  root.querySelector('[data-dest]')?.addEventListener('change', (e) => {
    st.dest = e.target.value || null;
    ctx.hash.set('dest', st.dest);
    ctx.track('starlink_link_model', { action: 'dest' });
    tick();
  });
  const pre = root.querySelector('[data-preset]');
  pre?.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === pre.value);
    if (!p) return;
    place(p, 'preset');
    ctx.flyTo({ lon: p.lon, lat: p.lat, zoom: 3.6 });
  });
  root.querySelector('[data-mask]')?.addEventListener('change', (e) => {
    st.mask = Number(e.target.value);
    ctx.hash.set('mask', st.mask === MODEL.userMask ? null : String(st.mask));
    ctx.track('starlink_link_model', { action: 'mask', mask: st.mask });
    tick();
  });
  for (const d of root.querySelectorAll('details[data-open]')) d.addEventListener('toggle', () => (st.open[d.dataset.open] = d.open));
}

function readHash(get) {
  st.at = parseAt(get('at'));
  const sat = Number(get('sat'));
  st.sat = Number.isInteger(sat) && sat > 0 ? sat : null;
  const mask = Number(get('mask'));
  st.mask = MASKS.includes(mask) ? mask : MODEL.userMask;
  const all = parseLayers(get('layer'));
  st.layers = new Set(MY_LAYERS.filter((l) => all.has(l)));
  st.dest = get('dest') || null;
}

// --- the section's lifecycle (app.js calls these) ---

function onKey(e) {
  if (e.key === 'Escape' && st?.picking) {
    st.picking = false;
    render();
    ctx.layers.redraw();
  }
}

export function mount(el, c) {
  import('./links.css').catch(() => {});
  ctx = c;
  root = el;
  st = fresh();
  readHash((k) => ctx.hash.get(k));
  // In drawing order: the mesh, the traffic over it, the gateways, the dish's links on top.
  ctx.layers.set('pick', map.groups.pick, { placement: 'below', tooltip: map.tooltips.pick });
  ctx.layers.set('mesh', map.groups.mesh);
  ctx.layers.set('traffic', map.groups.traffic, { tooltip: map.tooltips.traffic });
  ctx.layers.set('gateways', map.groups.gateways, { tooltip: map.tooltips.gateways });
  ctx.layers.set('links', map.groups.links, { tooltip: map.tooltips.links });
  // The drawn part of the mesh follows the camera, and the 2D map draws it flat.
  ctx.on('camera', () => st?.layers.has('mesh') && tick());
  ctx.on('view', () => (st?.layers.has('mesh') || st?.layers.has('traffic')) && tick());
  ctx.on('orbits', () => st?.ready && tick());
  addEventListener('keydown', onKey);
  ctx.signal.addEventListener('abort', () => removeEventListener('keydown', onKey), { once: true });
  render();
  load();
}

export function unmount() {
  if (st) {
    clearInterval(st.timer);
    st.engine?.dispose();
  }
  if (root) root.innerHTML = '';
  ctx = root = st = null;
}

export function onHash(params) {
  if (!st) return;
  const key = () => JSON.stringify([st.at, st.sat, st.mask, st.dest, [...st.layers]]);
  const before = key();
  readHash((k) => params[k] ?? null);
  if (key() === before) return;
  render();
  ctx.layers.redraw();
  tick();
}
