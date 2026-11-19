// The Incidents app's panel: an incident made of events (outages that may or
// may not share a cause), each stepped through its timeline, with its places
// and the en route centers on the map. Uses only ctx (apps/README.md).
//
// Permalink: incidents.event=<id> (the event open, when not the incident's
// default), incidents.step=<n> (its timeline step, when not the event's
// default), incidents.place=<id> (the place open), incidents.about=0 (the
// explainer closed).

import { esc } from '../util.js';
import { chronological, eventById, INCIDENTS, parseStep, stepParam } from './data.js';
import { COLOURS, createMapLayers } from './mapLayers.js';

let ctx = null;
let root = null;
let st = null;

const fresh = () => {
  const incident = INCIDENTS[0];
  const event = eventById(incident, null);
  return { incident, event, step: event.defaultStep, place: null, about: true, geo: null };
};

const map = createMapLayers({
  event: () => st?.event ?? null,
  step: () => st?.step ?? 0,
  pickPoint: (id) => selectPlace(id, { fly: false, from: 'map' }),
});

// --- state ---

function setEvent(id, from = 'list') {
  const ev = eventById(st.incident, id);
  if (ev === st.event) return;
  st.event = ev;
  st.step = ev.defaultStep;
  st.place = null;
  ctx.hash.set({ event: ev.id === st.incident.defaultEvent ? null : ev.id, step: null, place: null });
  ctx.track('incidents_event', { incident: st.incident.id, event: ev.id, from });
  ctx.flyTo({ bbox: ev.bbox });
  render();
  ctx.layers.redraw();
}

function setStep(k, from = 'list') {
  const n = parseStep(st.event, k);
  if (n === st.step) return;
  st.step = n;
  ctx.hash.set('step', stepParam(st.event, n));
  ctx.track('incidents_step', { event: st.event.id, step: n, from });
  const focus = st.event.steps[n].focus;
  if (focus) selectPlace(focus, { fly: true, from: 'step', quiet: true });
  render();
  ctx.layers.redraw();
}

function selectPlace(id, { fly = true, from = 'list', quiet = false } = {}) {
  const p = st.event.points.find((x) => x.id === id) ?? null;
  st.place = p?.id ?? null;
  ctx.hash.set('place', st.place);
  if (p) {
    if (!quiet) ctx.track('incidents_place', { event: st.event.id, place: p.id, from });
    if (fly) ctx.flyTo({ lon: p.lon, lat: p.lat, zoom: 6 });
  }
  if (!quiet) render();
}

// --- the panel ---

const swatch = (c, line = false) => `<span class="inc-swatch${line ? ' line' : ''}" style="background:rgb(${c.join(',')})"></span>`;

function eventHTML(ev, k) {
  const step = ev.steps[k];
  const place = ev.points.find((p) => p.id === st.place) ?? null;
  const shown = step.status ?? {};
  return `
    <div class="inc-event">
      <h3>${esc(ev.date)} · ${esc(ev.title)}</h3>
      <p>${esc(ev.summary)}</p>
      <div class="app-actions"><button type="button" class="btn primary" data-fly>Fly to it</button></div>

      <h3>Timeline</h3>
      <div class="inc-stepper">
        <button type="button" class="btn" data-prev ${k === 0 ? 'disabled' : ''} aria-label="Previous step">‹</button>
        <input type="range" min="0" max="${ev.steps.length - 1}" value="${k}" step="1" data-range aria-label="Timeline step">
        <button type="button" class="btn" data-next ${k === ev.steps.length - 1 ? 'disabled' : ''} aria-label="Next step">›</button>
      </div>
      <ol class="inc-steps">
        ${ev.steps
          .map(
            (s, i) => `<li class="${i === k ? 'on' : ''}"><button type="button" class="app-link" data-step="${i}" aria-current="${i === k}">
              <span class="inc-time">${esc(s.time)}</span>${esc(s.title)}</button>${i === k ? `<p>${esc(s.text)}</p>` : ''}</li>`,
          )
          .join('')}
      </ol>

      ${
        ev.points.length
          ? `<h3>Places</h3>
      <ul class="app-nbrs inc-places">
        ${ev.points
          .map((p) => {
            const status = shown[p.id] ?? null;
            const c = status && status !== 'ok' ? COLOURS[status] : COLOURS[p.kind];
            return `<li><button type="button" class="app-link${p.id === st.place ? ' inc-hit' : ''}" data-place="${p.id}" title="Fly to ${esc(p.name)}">
              ${swatch(c)}<b>${esc(p.name)}</b>${status && status !== 'ok' ? ` <span class="muted">· ${esc(status === 'alert' ? 'affected' : status)}</span>` : ''}</button></li>`;
          })
          .join('')}
      </ul>
      ${place ? `<div class="inc-detail"><p>${esc(place.what ?? '')}</p>${place.precision ? `<p class="muted">Placed at the ${esc(place.precision)}: the exact site isn't published.${place.detail ? ` Router: ${esc(place.detail)}.` : ''}</p>` : ''}</div>` : ''}`
          : ''
      }

      <h3>Numbers</h3>
      <dl>${ev.numbers.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>

      <h3>Sources</h3>
      <ul class="inc-sources">${ev.sources.map(([t, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join('')}</ul>
    </div>`;
}

function render() {
  if (!root || !st) return;
  const inc = st.incident;
  root.innerHTML = `
    <h2>${esc(inc.title)}</h2>
    ${st.geo === false ? `<p class="app-warn">These places only line up with the network in the geo layout. <button type="button" class="btn" data-geo>Switch to geo</button></p>` : ''}
    <p>${esc(inc.summary)}</p>
    <p class="muted inc-linked">${esc(inc.linked)}</p>

    <h3>Events</h3>
    <ol class="inc-events">
      ${chronological(inc)
        .map(
          (e) => `<li><button type="button" class="app-link${e === st.event ? ' on' : ''}" data-event="${e.id}" aria-current="${e === st.event}">
            <span class="inc-time">${esc(e.date)}</span><b>${esc(e.title)}</b> <span class="muted">· ${esc(e.short)}</span></button></li>`,
        )
        .join('')}
    </ol>

    ${eventHTML(st.event, st.step)}

    <h3>On the map</h3>
    <ul class="inc-legend">
      <li>${swatch(COLOURS.center)}En route center (ARTCC), 22 in all; ${swatch(COLOURS.tracon)}TRACON; ${swatch(COLOURS.airport)}airport; ${swatch(COLOURS.site)}remote site</li>
      <li>${swatch(COLOURS.alert)}affected; ${swatch(COLOURS.down)}down; ${swatch(COLOURS.blocked)}blocked</li>
      <li>${swatch(COLOURS.access, true)}${swatch(COLOURS.primary, true)}a circuit, ${swatch(COLOURS.flood, true)}flooding, dashed ${swatch(COLOURS.down, true)}down. <i>Circuit routes are modelled: the real ones aren't public. Hover a line for what it stands for.</i></li>
    </ul>

    <details class="app-about"${st.about ? ' open' : ''}>
      <summary>How ATC's network is built</summary>
      <p><b>Leased lines, private network.</b> The FAA buys its wide-area network from a contractor, L3Harris under the FTI contract,
        moving to Verizon under FENS. Its circuits are leased from the big carriers, so they share their conduits, central offices
        and rights-of-way, but they are dedicated circuits, not the public internet. Many are still copper; L3Harris says over 70%
        have moved to fiber, and the FAA plans to finish by September 2027.</p>
      <p><b>Remote sites.</b> Radars and the radio sites controllers talk to pilots through sit away from the centers and TRACONs, each
        backhauled to its facility. That's why a cut line, or one bad router, can take out radar and voice together.</p>
      <p><b>What's public.</b> The facilities' places, and what the FAA and the press reported. Which circuit joins which site to which
        facility, over which carrier, isn't, so those lines are modelled here.</p>
    </details>`;
  wire();
}

function wire() {
  const $ = (sel) => root.querySelector(sel);
  $('[data-fly]')?.addEventListener('click', () => ctx.flyTo({ bbox: st.event.bbox }));
  $('[data-geo]')?.addEventListener('click', () => ctx.view.set({ mode: 'geo' }));
  $('[data-prev]')?.addEventListener('click', () => setStep(st.step - 1, 'prev'));
  $('[data-next]')?.addEventListener('click', () => setStep(st.step + 1, 'next'));
  $('[data-range]')?.addEventListener('input', (e) => setStep(Number(e.target.value), 'range'));
  for (const b of root.querySelectorAll('[data-event]')) b.addEventListener('click', () => setEvent(b.dataset.event));
  for (const b of root.querySelectorAll('[data-step]')) b.addEventListener('click', () => setStep(Number(b.dataset.step)));
  for (const b of root.querySelectorAll('[data-place]')) b.addEventListener('click', () => selectPlace(st.place === b.dataset.place ? null : b.dataset.place, { fly: st.place !== b.dataset.place }));
  const d = root.querySelector('.app-about');
  d?.addEventListener('toggle', () => {
    if (d.open === st.about) return;
    st.about = d.open;
    ctx.hash.set('about', st.about ? null : '0');
  });
}

// --- lifecycle ---

function fromParams(get) {
  const event = eventById(st.incident, get('event'));
  const step = parseStep(event, get('step'));
  const place = event.points.some((p) => p.id === get('place')) ? get('place') : null;
  return { event, step, place, about: get('about') !== '0' };
}

export function mount(el, c) {
  import('./incidents.css').catch(() => {}); // on mount, so node's tests can load the app's code
  ctx = c;
  root = el;
  st = fresh();
  Object.assign(st, fromParams((k) => ctx.hash.get(k)));
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
  const next = fromParams((k) => params[k] ?? null);
  if (next.event === st.event && next.step === st.step && next.place === st.place && next.about === st.about) return;
  Object.assign(st, next);
  render();
  ctx.layers.redraw();
}
