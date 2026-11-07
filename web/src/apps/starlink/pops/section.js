// The Starlink app's PoPs section (#31): Starlink's PoPs and customer regions
// on the map, the farthest region -> PoP assignments, the backbone's status,
// and its IXes and facilities from PeeringDB. Uses only ctx (apps/README.md).
//
// Permalink: starlink.pop=<code> (the PoP open), starlink.layer=<list> (the
// map layers on, when not all of them: pops, regions, peering, backbone;
// 'none' for none).

import { esc, fmt } from '../../util.js';
import { STARLINK_ASN } from '../summary.js';
import { boundsAround, farthest, km, LAYERS, layersParam, parseLayers, popDetail, POPS_LAYERS, regionLabel, servedBy, shapeStarlink } from './data.js';
import { fetchPeering, PDB_WEB, placeAtPops, portsLabel, speedLabel } from './peeringdb.js';
import { loadBackboneFile, normaliseBackbone, onBackbone, publishedBackbone } from './backbone.js';
import { createMapLayers } from './mapLayers.js';

const LAYER_NAMES = { pops: 'PoPs', regions: 'Customer regions', peering: 'IXes & facilities', backbone: 'Backbone' };
const FAR_N = 10;

let ctx = null;
let root = null;
let st = null; // the section's state while mounted

const fresh = () => ({
  status: 'loading', // 'loading' | 'ok' | 'missing' | 'error'
  error: null,
  shaped: null,
  meta: null,
  selected: null, // a PoP
  served: new Set(),
  layers: new Set(LAYERS),
  peering: { status: 'idle', data: null, error: null },
  backbone: null, // normalised, or null
  backboneRaw: { file: null, published: null },
  open: { all: false, ixes: false, facs: false },
  ix: null, // the IX last clicked on the map
  geo: null, // the layout is geographic
});

const view = {
  shaped: () => st?.shaped ?? null,
  selected: () => st?.selected ?? null,
  served: () => st?.served ?? new Set(),
  layers: () => st?.layers ?? new Set(),
  peering: () => peeringData(),
  backbone: () => st?.backbone ?? null,
  pickPop: (code) => selectPop(code, { fly: false, from: 'map' }),
  pickRegion: (r) => {
    const pop = st?.shaped?.pops[r.pop];
    if (pop) selectPop(pop.code, { fly: false, from: 'region' });
  },
  pickIx: (ix) => {
    if (!st) return;
    ctx.track('starlink_ix_select', { ix_id: ix.id });
    st.open.ixes = true;
    st.ix = ix.id;
    render();
    root?.querySelector(`[data-ix="${ix.id}"]`)?.scrollIntoView({ block: 'nearest' });
  },
};
const map = createMapLayers(view);

// --- data ---

async function getJSON(url) {
  const res = await fetch(url, { signal: ctx.signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/json/.test(type)) return null; // a dev server's index.html for a missing file
  return res.json();
}

async function load() {
  const base = `${ctx.dataBase}/starlink`;
  try {
    const [pops, regions, meta] = await Promise.all([getJSON(`${base}/pops.json`), getJSON(`${base}/regions.json`), getJSON(`${base}/meta.json`).catch(() => null)]);
    if (!st) return;
    if (!pops || !regions) {
      st.status = 'missing';
      return render();
    }
    st.shaped = shapeStarlink(pops, regions);
    st.meta = meta;
    st.status = 'ok';
    const code = ctx.hash.get('pop');
    if (code) setSelected(code);
    refreshBackbone();
    render();
    ctx.layers.redraw();
    if (st.selected) requestAnimationFrame(revealDetail); // a permalink to a PoP
  } catch (err) {
    if (err?.name === 'AbortError' || !st) return;
    st.status = 'error';
    st.error = err.message;
    render();
  }
}

async function loadPeering() {
  st.peering.status = 'loading';
  try {
    let storage = null;
    try {
      storage = globalThis.sessionStorage ?? null;
    } catch {
      /* blocked */
    }
    const data = await fetchPeering({ asn: STARLINK_ASN, signal: ctx.signal, storage });
    if (!st) return;
    st.peering = { status: 'ok', data, error: null, placed: false };
    ctx.track('starlink_peeringdb', { status: data.cached ? 'cached' : 'live' });
  } catch (err) {
    if (err?.name === 'AbortError' || !st) return;
    st.peering = { status: 'offline', data: null, error: err.message };
    ctx.track('starlink_peeringdb', { status: 'offline' });
  }
  render();
  ctx.layers.redraw();
}

async function loadBackbone() {
  try {
    const raw = await loadBackboneFile({ base: ctx.dataBase, signal: ctx.signal });
    if (!st) return;
    st.backboneRaw.file = raw;
    refreshBackbone();
    render();
    ctx.layers.redraw();
  } catch {
    /* aborted */
  }
}

function refreshBackbone() {
  if (!st?.shaped) return;
  // A runtime source (#33's traceroutes) wins over the baked file.
  st.backbone = normaliseBackbone(st.backboneRaw.published, st.shaped.byCode) ?? normaliseBackbone(st.backboneRaw.file, st.shaped.byCode);
}

// PeeringDB's record, with the IXes it can't place put at a PoP in their
// city once the PoPs are in.
function peeringData() {
  const pe = st?.peering;
  if (pe?.status !== 'ok') return null;
  if (st.shaped && !pe.placed) (pe.data = placeAtPops(pe.data, st.shaped.pops)), (pe.placed = true);
  return pe.data;
}

// --- selection, layers, hash ---

function setSelected(code) {
  const pop = code ? st.shaped?.byCode.get(code) ?? null : null;
  st.selected = pop;
  st.served = servedBy(pop);
  return pop;
}

function flyToPop(pop, extra = []) {
  const box = boundsAround(pop, [...pop.regions.map((r) => st.shaped.regions[r.id]), ...extra]);
  if (box) ctx.flyTo({ bbox: box });
  else if (pop.placed) ctx.flyTo({ lon: pop.lon, lat: pop.lat, zoom: 3 });
}

// Bring the PoP's detail into view in the panel (the summary's lists are above it).
function revealDetail() {
  const el = root?.querySelector('.sl-detail');
  let box = el?.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (!el || !box) return;
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8;
  box.scrollTo({ top, behavior: 'smooth' });
}

function selectPop(code, { fly = true, from = 'list', also = [] } = {}) {
  if (!st?.shaped) return;
  const prev = st.selected?.code ?? null;
  const pop = setSelected(code);
  ctx.hash.set('pop', pop ? pop.code : null);
  if (pop && pop.code !== prev) ctx.track('starlink_pop_select', { pop: pop.code, from });
  if (pop && fly) flyToPop(pop, also);
  render();
  ctx.layers.redraw();
  if (pop && from !== 'list' && from !== 'far') revealDetail();
}

function toggleLayer(name, on) {
  st.layers = parseLayers(ctx.hash.get('layer')); // other sections' layers share the param
  if (on) st.layers.add(name);
  else st.layers.delete(name);
  ctx.hash.set('layer', layersParam(st.layers));
  ctx.track('starlink_layer_toggle', { layer: name, on: !!on });
  ctx.layers.redraw();
}

// --- the panel ---

const swatch = (c) => `<span class="sl-swatch" style="background:rgb(${c.join(',')})"></span>`;
const pct = (x) => `${x >= 0.995 ? 100 : x < 0.01 ? '<1' : Math.round(x * 100)}%`;
const day = (iso) => (iso ? esc(String(iso).slice(0, 10)) : '—');
const popButton = (p, extra = '') =>
  `<button type="button" class="app-link" data-pop="${esc(p.code)}" title="Show PoP ${esc(p.code)} and the regions it serves">${swatch(p.colour)}${esc(p.city || p.name)} <code>${esc(p.code)}</code>${extra}</button>`;

function render() {
  if (!root || !st) return;
  root.innerHTML = `<section class="sl-pops">${body()}</section>`;
  wire();
}

function body() {
  if (st.status === 'loading') return '<h3>PoPs</h3><p class="muted">Loading Starlink\'s PoPs…</p>';
  if (st.status === 'missing')
    return `<h3>PoPs</h3><p class="app-warn">No Starlink data in this build. Make it with <code>python -m netmap starlink</code> (README, "Starlink data").</p>`;
  if (st.status === 'error') return `<h3>PoPs</h3><p class="app-warn">Couldn't load Starlink's PoPs: ${esc(st.error)}</p>`;
  const s = st.shaped;
  const c = st.meta?.counts;
  const geo = ctx.view.get()?.geographic;
  return `
    <h3>PoPs (${fmt(s.pops.length)})</h3>
    <p class="muted">From Starlink's own geofeed and PoP list${st.meta ? `, fetched ${day(st.meta.fetched_at)}` : ''}${c ? `: ${fmt(c.prefixes)} prefixes in ${fmt(c.regions)} regions` : ''}. Markers are sized by IPv4 addresses and placed at their IATA airport.</p>
    ${geo === false ? `<p class="app-warn">The network's nodes are only at their places in the geo layout; PoPs and regions are always at theirs. <button type="button" class="btn" data-geo>Geo layout</button></p>` : ''}
    <div class="sl-layers" role="group" aria-label="Starlink map layers">
      ${POPS_LAYERS.map((l) => {
        const none = l === 'backbone' && !st.backbone;
        return `<label${none ? ' class="muted" title="Not yet published"' : ''}><input type="checkbox" data-layer="${l}"${st.layers.has(l) ? ' checked' : ''}${none ? ' disabled' : ''}> ${LAYER_NAMES[l]}</label>`;
      }).join('')}
    </div>
    ${st.selected ? detailHTML() : '<p class="muted">Click a PoP (or a region) on the map, or pick one below.</p>'}
    <details class="sl-all" data-open="all"${st.open.all ? ' open' : ''}>
      <summary>All PoPs, by IPv4 addresses</summary>
      <ul class="app-nbrs">${[...s.pops]
        .sort((a, b) => b.v4_addresses - a.v4_addresses || a.code.localeCompare(b.code))
        .map((p) => `<li>${popButton(p, ` <span class="muted">· ${fmt(p.v4_addresses)} addrs${p.placed ? '' : ' · not placed'}</span>`)}</li>`)
        .join('')}</ul>
    </details>
    ${farHTML()}
    ${backboneHTML()}
    ${peeringHTML()}
    ${st.meta?.caveats?.length ? `<p class="muted sl-small">${esc(st.meta.caveats[0])}</p>` : ''}`;
}

function detailHTML() {
  const d = popDetail(st.shaped, st.selected.code);
  const p = d.pop;
  const far = d.regions.reduce((m, r) => (r.km !== null && r.km > (m?.km ?? -1) ? r : m), null);
  return `
    <div class="sl-detail" style="--pop:rgb(${p.colour.join(',')})">
      <div class="sl-detail-head"><h2>${swatch(p.colour)}${esc(p.city || p.name)} <code>${esc(p.code)}</code></h2>
        <button type="button" class="btn" data-clear title="Close this PoP">✕</button></div>
      <dl>
        <dt>IATA</dt><dd>${esc((p.iata || '').toUpperCase())}${p.located === 'metro' ? ' <span class="muted">(metro area)</span>' : ''}</dd>
        <dt>Airport</dt><dd>${p.placed ? `${esc(p.airport)} · ${esc(p.name)}, ${esc(p.country)}` : '<span class="muted">unknown code, not placed</span>'}</dd>
        <dt>Prefixes</dt><dd>${fmt(p.v4_prefixes)} IPv4 · ${fmt(p.v6_prefixes)} IPv6</dd>
        <dt>Addresses</dt><dd>${fmt(p.v4_addresses)} IPv4</dd>
        <dt>Serves</dt><dd>${fmt(p.regions.length)} regions in ${fmt(d.countries)} ${d.countries === 1 ? 'country' : 'countries'}${far ? `, up to ${km(far.km)} away` : ''}</dd>
      </dl>
      <h3>Top customer regions</h3>
      <ol class="sl-regions">${d.regions
        .map((r) => `<li><span class="sl-bar" style="--w:${Math.max(2, Math.round(r.share * 100))}%"></span><span class="sl-rname">${esc(r.region ? regionLabel(r.region) : '?')}</span><span class="sl-num">${pct(r.share)}</span><span class="sl-num muted">${km(r.km)}</span></li>`)
        .join('')}</ol>
      ${d.more ? `<p class="muted">and ${fmt(d.more)} more</p>` : ''}
      <p class="muted sl-small">Share: of the PoP's prefixes. Regions are the feed's markets; distances are to its airport.</p>
      <div class="app-actions"><button type="button" class="btn" data-flypop>Fly to it</button></div>
    </div>`;
}

function farHTML() {
  const list = farthest(st.shaped, { n: FAR_N });
  if (!list.length) return '';
  return `
    <h3>Far from their PoP</h3>
    <p class="muted sl-small">Customer regions and the farthest PoPs their prefixes are assigned to (great-circle distance, prefixes). A region can have several PoPs.</p>
    <ol class="sl-far">${list
      .map((a) => {
        const r = a.regionRec, p = a.popRec;
        const approx = r.precision && r.precision !== 'city' ? ` <span class="muted" title="Placed at its ${esc(r.precision)}'s centre">(${esc(r.precision)})</span>` : '';
        return `<li><button type="button" class="app-link" data-pop="${esc(p.code)}" data-region="${r.id}" title="Show PoP ${esc(p.code)} and this region">${esc(regionLabel(r))}${approx} → ${swatch(p.colour)}${esc(p.city)} <code>${esc(p.code)}</code> <span class="sl-num">${km(a.km)} · ${fmt(a.prefixes)} pfx</span></button></li>`;
      })
      .join('')}</ol>`;
}

function backboneHTML() {
  const b = st.backbone;
  if (!b)
    return `
    <h3>Backbone</h3>
    <p class="muted">Backbone: not yet published. Starlink's PoP-to-PoP links aren't public. arXiv 2412.18243 maps 33 PoPs and 70 links, but its dataset couldn't be reached to check its licence, so netmap doesn't draw it. Links measured by traceroutes between Starlink's RIPE Atlas probes will show here.</p>`;
  return `
    <h3>Backbone (${b.kind})</h3>
    <p class="${b.kind === 'modelled' ? 'app-warn' : 'muted'}">${fmt(b.links.length)} PoP-to-PoP links, ${b.kind}: ${b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.source)}</a>` : esc(b.source)}${b.measured_at ? `, ${day(b.measured_at)}` : ''}.</p>`;
}

function peeringHTML() {
  const pe = st.peering;
  const head = '<h3>Peering</h3><p class="muted sl-small">Upstreams and peers from the map are in the summary above. IXes and facilities from PeeringDB:</p>';
  if (pe.status === 'idle' || pe.status === 'loading') return `${head}<p class="muted">Asking PeeringDB…</p>`;
  if (pe.status === 'offline')
    return `${head}<p class="app-warn">PeeringDB is unreachable (${esc(pe.error)}), so no IXes or facilities. <button type="button" class="btn" data-retry>Retry</button></p>`;
  const d = peeringData();
  const ixRow = (x) =>
    `<li data-ix="${x.id}"${x.id === st.ix ? ' class="sl-hit"' : ''}><span class="sl-rname">${esc(x.name)} <span class="muted">${esc(x.city)}${x.country ? `, ${esc(x.country)}` : ''}</span></span><span class="sl-num">${esc(portsLabel(x.speeds))}</span>${x.lon === null ? '<span class="muted" title="No facility coordinates">·</span>' : ''}</li>`;
  return `
    ${head}
    <dl>
      <dt>IXes</dt><dd>${fmt(d.totals.ixes)} · ${fmt(d.totals.ports)} ports · ${esc(speedLabel(d.totals.speed))} in all</dd>
      <dt>Facilities</dt><dd>${fmt(d.totals.facilities)}</dd>
    </dl>
    <p class="muted sl-small">Live from <a href="${PDB_WEB}/asn/${STARLINK_ASN}" target="_blank" rel="noopener">PeeringDB</a>, ${d.cached ? 'kept from earlier this session' : 'fetched'} ${esc(String(d.fetched_at).slice(0, 16).replace('T', ' '))} UTC. IXes are rings sized by port speed, at their facilities in their city (Starlink's first, else at its PoP there).</p>
    <details data-open="ixes"${st.open.ixes ? ' open' : ''}><summary>IXes, fastest first</summary>
      <ol class="sl-ixes">${d.ixes.map(ixRow).join('')}</ol></details>
    <details data-open="facs"${st.open.facs ? ' open' : ''}><summary>Facilities (${fmt(d.facilities.length)})</summary>
      <ul class="sl-facs">${d.facilities.map((f) => `<li>${esc(f.name)} <span class="muted">· ${esc(f.city)}, ${esc(f.country)}${f.ixes.length ? ` · ${f.ixes.length} IX${f.ixes.length > 1 ? 'es' : ''}` : ''}</span></li>`).join('')}</ul></details>`;
}

function wire() {
  for (const b of root.querySelectorAll('[data-pop]'))
    b.addEventListener('click', () => {
      const region = b.dataset.region !== undefined ? st.shaped.regions[Number(b.dataset.region)] : null;
      selectPop(b.dataset.pop, { from: region ? 'far' : 'list', also: region ? [region] : [] });
    });
  for (const c of root.querySelectorAll('[data-layer]')) c.addEventListener('change', () => toggleLayer(c.dataset.layer, c.checked));
  root.querySelector('[data-clear]')?.addEventListener('click', () => selectPop(null));
  root.querySelector('[data-flypop]')?.addEventListener('click', () => st.selected && flyToPop(st.selected));
  root.querySelector('[data-geo]')?.addEventListener('click', () => ctx.view.set({ mode: 'geo' }));
  root.querySelector('[data-retry]')?.addEventListener('click', () => (loadPeering(), render()));
  for (const d of root.querySelectorAll('details[data-open]'))
    d.addEventListener('toggle', () => {
      if (st.open[d.dataset.open] === d.open) return;
      st.open[d.dataset.open] = d.open;
    });
}

// --- the section's lifecycle (app.js calls these) ---

export function mount(el, c) {
  import('./pops.css').catch(() => {}); // on mount, so node's tests can load the app's code
  ctx = c;
  root = el;
  st = fresh();
  st.layers = parseLayers(ctx.hash.get('layer'));
  const opts = (group) => ({ tooltip: map.tooltips[group] });
  for (const [group, fn] of Object.entries(map.groups)) ctx.layers.set(group, fn, opts(group));
  st.backboneRaw.published = publishedBackbone();
  const off = onBackbone((raw) => {
    if (!st) return;
    st.backboneRaw.published = raw;
    refreshBackbone();
    render();
    ctx.layers.redraw();
  });
  ctx.signal.addEventListener('abort', off, { once: true });
  // The summary above fills in when the map loads: keep an open PoP in view.
  ctx.on('dataset', () => st?.selected && requestAnimationFrame(revealDetail));
  ctx.on('view', () => {
    const geo = ctx.view.get()?.geographic;
    if (geo !== st?.geo) (st.geo = geo), render();
  });
  st.geo = ctx.view.get()?.geographic;
  render();
  load();
  loadPeering();
  loadBackbone();
}

export function unmount() {
  if (root) root.innerHTML = '';
  ctx = root = st = null;
}

export function onHash(params) {
  if (!st) return;
  const layers = parseLayers(params.layer ?? null);
  const code = params.pop ?? null;
  const changed = layersParam(layers) !== layersParam(st.layers) || code !== (st.selected?.code ?? null);
  if (!changed) return;
  st.layers = layers;
  if (st.shaped) setSelected(code);
  render();
  ctx.layers.redraw();
}
