// The ATC app's panel: an incident on the FAA's telecom network, stepped
// through its timeline, with its sites and the en route centers on the map.
// Uses only ctx (apps/README.md).
//
// Permalink: atc.step=<n> (the timeline step, when not the default),
// atc.site=<id> (the site open), atc.about=0 (the explainer closed).

import { esc } from '../util.js';
import { CONUS_BBOX, INCIDENTS, nearestCenter, parseStep, stepParam } from './data.js';
import { COLOURS, createMapLayers } from './mapLayers.js';

let ctx = null;
let root = null;
let st = null;

const fresh = () => ({ incident: INCIDENTS[0], step: INCIDENTS[0].defaultStep, site: null, about: true, geo: null });

const map = createMapLayers({
  incident: () => st?.incident ?? null,
  step: () => st?.step ?? 0,
  pickSite: (id) => selectSite(id, { fly: false, from: 'map' }),
});

// --- state ---

function setStep(k, from = 'list') {
  const n = parseStep(st.incident, k);
  if (n === st.step) return;
  st.step = n;
  ctx.hash.set('step', stepParam(st.incident, n));
  ctx.track('atc_step', { incident: st.incident.id, step: st.incident.steps[n].id, from });
  const focus = st.incident.steps[n].state.focus;
  if (focus) selectSite(focus, { fly: true, from: 'step', quiet: true });
  render();
  ctx.layers.redraw();
}

function selectSite(id, { fly = true, from = 'list', quiet = false } = {}) {
  const site = st.incident.sites.find((s) => s.id === id) ?? null;
  st.site = site?.id ?? null;
  ctx.hash.set('site', st.site);
  if (site) {
    if (!quiet) ctx.track('atc_site', { site: site.id, from });
    if (fly) {
      const home = nearestCenter(site);
      const pad = 1.5;
      ctx.flyTo({ bbox: [Math.min(site.lon, home.lon) - pad, Math.min(site.lat, home.lat) - pad, Math.max(site.lon, home.lon) + pad, Math.max(site.lat, home.lat) + pad] });
    }
  }
  if (!quiet) render();
}

// --- the panel ---

const swatch = (c, line = false) => `<span class="atc-swatch${line ? ' line' : ''}" style="background:rgb(${c.join(',')})"></span>`;

function render() {
  if (!root || !st) return;
  const inc = st.incident;
  const k = st.step;
  const step = inc.steps[k];
  const site = inc.sites.find((s) => s.id === st.site) ?? null;
  root.innerHTML = `
    <h2>${esc(inc.title)}</h2>
    ${st.geo === false ? `<p class="app-warn">The centers and sites are at their real places, which only line up with the network in the geo layout. <button type="button" class="btn" data-geo>Switch to geo</button></p>` : ''}
    <p>${esc(inc.summary)}</p>
    <div class="app-actions">
      <button type="button" class="btn primary" data-fly>Fly to the US</button>
    </div>

    <h3>Timeline <span class="muted">(ET)</span></h3>
    <div class="atc-stepper">
      <button type="button" class="btn" data-prev ${k === 0 ? 'disabled' : ''} aria-label="Previous step">‹</button>
      <input type="range" min="0" max="${inc.steps.length - 1}" value="${k}" step="1" data-range aria-label="Timeline step">
      <button type="button" class="btn" data-next ${k === inc.steps.length - 1 ? 'disabled' : ''} aria-label="Next step">›</button>
    </div>
    <ol class="atc-steps">
      ${inc.steps
        .map(
          (s, i) => `<li class="${i === k ? 'on' : ''}"><button type="button" class="app-link" data-step="${i}" aria-current="${i === k}">
            <span class="atc-time">${esc(s.time)}</span> ${esc(s.title)}</button>${i === k ? `<p>${esc(s.text)}</p>` : ''}</li>`,
        )
        .join('')}
    </ol>

    <h3>The two sites</h3>
    <ul class="app-nbrs atc-sites">
      ${inc.sites
        .map((s) => {
          const home = nearestCenter(s);
          return `<li><button type="button" class="app-link${s.id === st.site ? ' atc-hit' : ''}" data-site="${s.id}" title="Fly to ${esc(s.name)}">
            ${swatch(step.state.blocked ? COLOURS.blocked : COLOURS.site)}<b>${esc(s.name)}</b> <span class="muted">· ${esc(s.kind)}</span><br><span class="muted atc-sub">home center ${home.id}, ${esc(home.city)} (modelled: the nearest)</span></button></li>`;
        })
        .join('')}
    </ul>
    ${site ? `<div class="atc-detail"><p>${esc(site.what)}</p><p class="muted">Placed at the ${esc(site.precision)}: the exact site isn't published. Router: ${esc(site.router)}.</p></div>` : ''}

    <h3>Numbers</h3>
    <dl>${inc.numbers.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>

    <h3>On the map</h3>
    <ul class="atc-legend">
      <li>${swatch(COLOURS.center)}En route center (ARTCC), 22 in all</li>
      <li>${swatch(COLOURS.flood)}Centers while the flood spreads: ${inc.affected.centers} of ${inc.affected.of} were hit, but the FAA hasn't said which, so all are marked</li>
      <li>${swatch(COLOURS.site)}A site whose router flooded the network; ${swatch(COLOURS.blocked)}once blocked</li>
      <li>${swatch(COLOURS.home)}Its home center, and the line to it <i>(modelled: the nearest center)</i></li>
      <li>${swatch(COLOURS.flood, true)}The flood's reach from there <i>(modelled: FTI's backbone isn't public, so these show reach, not paths)</i></li>
    </ul>

    <details class="app-about"${st.about ? ' open' : ''}>
      <summary>How ATC's network is built</summary>
      <p><b>Leased lines, private network.</b> The FAA buys its wide-area network from a contractor, L3Harris under the FTI contract,
        moving to Verizon under FENS. Its circuits are leased from the big carriers, so they share their conduits, central offices
        and rights-of-way, but they are dedicated circuits, not the public internet. Many are still copper; L3Harris says over 70%
        have moved to fiber.</p>
      <p><b>Remote sites.</b> Radars and the radio sites controllers talk to pilots through sit away from the centers, each
        backhauled to its facility. That's why a cut line, or one bad router, can take out radar and voice together.</p>
      <p><b>What's public.</b> The facilities' places, and what the FAA and the press reported. Which circuit joins which site to which
        center, over which carrier, isn't, so those lines are modelled here.</p>
    </details>

    <h3>Sources</h3>
    <ul class="atc-sources">${inc.sources.map(([t, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join('')}</ul>`;
  wire();
}

function wire() {
  const $ = (sel) => root.querySelector(sel);
  $('[data-fly]')?.addEventListener('click', () => ctx.flyTo({ bbox: CONUS_BBOX }));
  $('[data-geo]')?.addEventListener('click', () => ctx.view.set({ mode: 'geo' }));
  $('[data-prev]')?.addEventListener('click', () => setStep(st.step - 1, 'prev'));
  $('[data-next]')?.addEventListener('click', () => setStep(st.step + 1, 'next'));
  $('[data-range]')?.addEventListener('input', (e) => setStep(Number(e.target.value), 'range'));
  for (const b of root.querySelectorAll('[data-step]')) b.addEventListener('click', () => setStep(Number(b.dataset.step)));
  for (const b of root.querySelectorAll('[data-site]')) b.addEventListener('click', () => selectSite(st.site === b.dataset.site ? null : b.dataset.site, { fly: st.site !== b.dataset.site }));
  const d = root.querySelector('.app-about');
  d?.addEventListener('toggle', () => {
    if (d.open === st.about) return;
    st.about = d.open;
    ctx.hash.set('about', st.about ? null : '0');
  });
}

// --- lifecycle ---

export function mount(el, c) {
  import('./atc.css').catch(() => {}); // on mount, so node's tests can load the app's code
  ctx = c;
  root = el;
  st = fresh();
  st.step = parseStep(st.incident, ctx.hash.get('step'));
  st.site = st.incident.sites.some((s) => s.id === ctx.hash.get('site')) ? ctx.hash.get('site') : null;
  st.about = ctx.hash.get('about') !== '0';
  for (const [group, fn] of Object.entries(map.groups)) ctx.layers.set(group, fn, { tooltip: map.tooltips[group] });
  ctx.on('view', () => {
    const geo = ctx.view.get()?.geographic;
    if (geo !== st?.geo) (st.geo = geo), render();
  });
  st.geo = ctx.view.get()?.geographic ?? null;
  render();
}

export function unmount() {
  if (root) root.innerHTML = '';
  ctx = root = st = null;
}

export function onHash(params) {
  if (!st) return;
  const step = parseStep(st.incident, params.step);
  const site = st.incident.sites.some((s) => s.id === params.site) ? params.site : null;
  const about = params.about !== '0';
  if (step === st.step && site === st.site && about === st.about) return;
  Object.assign(st, { step, site, about });
  render();
  ctx.layers.redraw();
}
