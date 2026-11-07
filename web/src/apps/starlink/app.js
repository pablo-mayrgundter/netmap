// The Starlink app (AS14593): its summary from the loaded graph, with fly-to,
// and what's public about Starlink's routing. A stub for now: the panels for
// its PoPs, live BGP, RIPE Atlas probes and modelled satellite links come
// next (epic #28). Uses only ctx (README in this folder).

import { esc, fmt } from '../util.js';
import { STARLINK_ASN, starlinkSummary } from './summary.js';
import { SECTIONS } from './sections.js';

let ctx = null;
let root = null;
let info = null; // AS14593's details record, once fetched
let infoFor = null; // the dataset it's for
let aboutOpen = true;
let mounted = []; // the sections mounted (sections.js), each with its element

function render() {
  if (!root) return;
  const ds = ctx.dataset();
  if (!ds) {
    root.innerHTML = `<p class="muted">Loading the map…</p>${aboutHTML()}`;
    return wireAbout();
  }
  const node = ctx.node(STARLINK_ASN);
  if (node && infoFor !== ds.id) fetchInfo(ds.id);
  const s = starlinkSummary(node, infoFor === ds.id ? info : null, node ? ctx.neighbours(STARLINK_ASN) : []);
  root.innerHTML = (s.present ? summaryHTML(s, ds) : absentHTML(ds)) + aboutHTML();
  root.querySelector('[data-fly]')?.addEventListener('click', () => {
    ctx.select(STARLINK_ASN);
    ctx.track('starlink_fly');
  });
  for (const b of root.querySelectorAll('[data-asn]')) b.addEventListener('click', () => ctx.select(Number(b.dataset.asn)));
  wireAbout();
}

async function fetchInfo(id) {
  infoFor = id;
  info = null;
  try {
    const rec = await ctx.info(STARLINK_ASN);
    if (infoFor === id && ctx) (info = rec), render();
  } catch {
    /* the summary stays without the record */
  }
}

function summaryHTML(s, ds) {
  const row = (k, v) => (v === null || v === undefined ? '' : `<dt>${k}</dt><dd>${v}</dd>`);
  const list = (items, more) =>
    items.length
      ? `<ul class="app-nbrs">${items
          .map((n) => `<li><button type="button" class="app-link" data-asn="${n.asn}" title="Select AS${n.asn} and fly to it"><span class="asn">AS${n.asn}</span> ${esc(n.name)} <span class="muted">· ${fmt(n.degree)} links</span></button></li>`)
          .join('')}</ul>${more ? `<p class="muted">and ${fmt(more)} more</p>` : ''}`
      : '<p class="muted">none on this map</p>';
  return `
    <h2><span class="asn">AS${s.asn}</span> ${esc(s.name)}</h2>
    ${ds.synthetic ? '<p class="app-warn">Synthetic topology: the names and prefixes are real, the links are generated, so these neighbours aren\'t Starlink\'s.</p>' : ''}
    <dl>
      ${row('Country', s.country && esc(s.country))}
      ${row('Cone', s.cone !== null ? `${fmt(s.cone)} ASes` : s.loading ? '…' : null)}
      ${row('k-core', s.coreness !== null ? fmt(s.coreness) : s.loading ? '…' : null)}
      ${row('Rank', s.rank ? `#${fmt(s.rank)} by customer cone` : null)}
      ${row('Level', s.level !== null ? `${s.level.toFixed(2)} <span class="muted">(0 edge … 1 core)</span>` : null)}
      ${row('Links', `${fmt(s.degree)} — ${fmt(s.providers)} upstreams, ${fmt(s.customers)} customers, ${fmt(s.peers)} peers`)}
    </dl>
    <div class="app-actions"><button type="button" class="btn primary" data-fly>Fly to Starlink</button></div>
    <h3>Upstreams (${fmt(s.providers)})</h3>${list(s.upstreams, s.more.upstreams)}
    <h3>Peers (${fmt(s.peers)})</h3>${list(s.peering, s.more.peering)}`;
}

function absentHTML(ds) {
  return `
    <h2><span class="asn">AS${STARLINK_ASN}</span> Starlink</h2>
    <p class="app-warn">AS${STARLINK_ASN} isn't in this dataset (${esc(ds.name)}). Pick another one in the controls, or build one with
      <code>python -m netmap build</code> (README).</p>`;
}

function aboutHTML() {
  return `
    <details class="app-about"${aboutOpen ? ' open' : ''}>
      <summary>What's public about Starlink routing</summary>
      <p><b>Measured.</b> Its BGP: the prefixes AS${STARLINK_ASN} announces, and its upstreams and peers
        (CAIDA's AS relationships here; RIPEstat and RIS Live for live updates). Starlink's own geofeed
        maps its prefixes to regions and PoPs. RIPE Atlas probes on Starlink dishes measure latency and
        traceroutes. Satellite positions are public (CelesTrak; turn on <i>orbits</i> on the globe).</p>
      <p><b>Modelled.</b> Routing in space is below the IP layer and isn't public: the laser links between
        satellites are modelled from SpaceX's FCC filings, and gateway sites come from FCC earth-station
        filings. Anything modelled will say so.</p>
      <p class="muted">Coming next here: Starlink's PoPs on the map, a live BGP looking glass, RIPE Atlas
        probes, and modelled satellite links.</p>
    </details>`;
}

function wireAbout() {
  const d = root.querySelector('.app-about');
  d?.addEventListener('toggle', () => {
    if (d.open === aboutOpen) return;
    aboutOpen = d.open;
    ctx.hash.set('about', aboutOpen ? null : '0'); // open is the default
  });
}

export function mount(el, c) {
  ctx = c;
  root = el.appendChild(document.createElement('div'));
  info = infoFor = null;
  aboutOpen = ctx.hash.get('about') !== '0';
  ctx.on('dataset', render);
  render();
  mounted = SECTIONS.map((s) => {
    const sel = el.appendChild(document.createElement('section'));
    sel.dataset.section = s.id;
    try {
      s.mount(sel, ctx);
    } catch (err) {
      sel.innerHTML = `<p class="app-warn">${esc(s.id)} didn't load (${esc(err.message)}).</p>`;
    }
    return { s, el: sel };
  });
}

export function unmount() {
  for (const { s, el } of mounted) {
    try {
      s.unmount();
    } catch {
      /* the next section still unmounts */
    }
    el.remove();
  }
  mounted = [];
  if (root) root.remove();
  ctx = root = info = infoFor = null;
}

export function onHash(params) {
  for (const { s } of mounted) s.onHash?.(params);
  const open = params.about !== '0';
  if (open === aboutOpen) return;
  aboutOpen = open;
  render();
}
