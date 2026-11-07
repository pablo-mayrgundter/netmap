// The PoPs section's deck.gl layers, as ctx.layers groups: PoP markers and
// labels, customer regions with their lines to their PoPs, PeeringDB's IXes
// and facilities, and the backbone when there is one. Each group is a
// function of the render's env, reading the section's state through `view`;
// data arrays are memoised so deck sees the same objects between renders.

import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { greatCircle, km, popLabel, regionLabel } from './data.js';
import { portsLabel } from './peeringdb.js';

// The globe: the Earth hides the far side, and nothing writes depth over it.
const GLOBE_PARAMS = { depthCompare: 'less-equal', depthWriteEnabled: false };
const FLAT_PARAMS = { depthCompare: 'always' };
const params = (env) => (env.globe ? GLOBE_PARAMS : FLAT_PARAMS);
// Metres above the ground on the globe, so markers clear the Earth's mesh.
const MARK_ALT = 12e3;
const LINE_ALT = 6e3;
const alt = (env) => (env.globe ? MARK_ALT : 0);

const IX_COLOUR = [236, 120, 255];
const PLACED = { shared: "at Starlink's facilities there", ix: 'at its facilities', pop: "at Starlink's PoP: no facility coordinates" };
const FAC_COLOUR = [210, 216, 228];
const BACKBONE_COLOUR = [255, 214, 120];
const DARK = [8, 12, 20];
// Labels for every PoP from this zoom on; below it the largest and the selected.
// 2D map only: deck 9.4's TextLayer draws nothing in GlobeView (on the globe,
// the tooltip and the panel name a PoP).
const LABEL_ALL_ZOOM = 3.6;
const LABEL_TOP = 14;

function memo() {
  const m = new Map();
  return (key, fn) => {
    if (!m.has(key)) {
      if (m.size > 24) m.clear();
      m.set(key, fn());
    }
    return m.get(key);
  };
}

/**
 * The groups for ctx.layers.set. `view` gives the section's state:
 * shaped(), selected() (a PoP or null), served() (a Set of region ids),
 * layers() (the Set on), peering(), backbone(); and its handlers:
 * pickPop(code), pickRegion(region), pickIx(ix).
 */
export function createMapLayers(view) {
  const cache = memo();
  const at = (d, env, target) => ((target[0] = d.lon), (target[1] = d.lat), (target[2] = alt(env)), target);
  const posTrig = (env) => `${env.globe}`;

  function pops(env) {
    const s = view.shaped();
    if (!s || !view.layers().has('pops')) return [];
    const sel = view.selected();
    const data = cache(`pops|${s.pops.length}`, () => s.pops.filter((p) => p.placed));
    const selKey = sel?.code ?? '';
    const dense = env.zoom >= LABEL_ALL_ZOOM;
    const labels = cache(`labels|${selKey}|${dense}|${data.length}`, () => {
      if (dense) return data;
      const top = new Set([...data].sort((a, b) => b.radius - a.radius).slice(0, LABEL_TOP));
      if (sel?.placed) top.add(sel);
      return data.filter((p) => top.has(p));
    });
    return [
      new ScatterplotLayer({
        id: 'pop-dots',
        data,
        getPosition: (d, { target }) => at(d, env, target),
        getRadius: (d) => d.radius,
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: (d) => [...d.colour, !sel || d === sel ? 235 : 110],
        stroked: true,
        getLineColor: (d) => (d === sel ? [255, 255, 255, 255] : [...DARK, 230]),
        getLineWidth: (d) => (d === sel ? 2.5 : 1.2),
        lineWidthUnits: 'pixels',
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        onClick: (info) => (info.object ? (view.pickPop(info.object.code), true) : false),
        parameters: params(env),
        updateTriggers: { getPosition: posTrig(env), getFillColor: selKey, getLineColor: selKey, getLineWidth: selKey },
      }),
      sel?.placed &&
        new ScatterplotLayer({
          id: 'pop-ring',
          data: cache(`ring|${selKey}`, () => [sel]),
          getPosition: (d, { target }) => at(d, env, target),
          getRadius: (d) => d.radius + 6,
          radiusUnits: 'pixels',
          billboard: true,
          filled: false,
          stroked: true,
          getLineColor: [90, 220, 255, 255],
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          parameters: params(env),
          updateTriggers: { getPosition: posTrig(env) },
        }),
      !env.globe &&
        new TextLayer({
          id: 'pop-labels',
          data: labels,
          getPosition: (d, { target }) => at(d, env, target),
          getText: popLabel,
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: (d) => (d === sel ? 13 : 11),
          getColor: (d) => (d === sel ? [255, 255, 255, 255] : !sel ? [230, 236, 248, 230] : [200, 208, 222, 150]),
          getPixelOffset: (d) => [d.radius + 4, 0],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          billboard: true,
          fontSettings: { sdf: true },
          outlineWidth: 3,
          outlineColor: [...DARK, 230],
          parameters: params(env),
          updateTriggers: { getPosition: posTrig(env), getSize: selKey, getColor: selKey },
        }),
    ];
  }

  function regions(env) {
    const s = view.shaped();
    if (!s || !view.layers().has('regions')) return [];
    const sel = view.selected();
    const served = view.served();
    const selKey = sel?.code ?? '';
    const dots = cache(`regions|${s.regions.length}`, () => s.regions.filter((r) => r.placed));
    const links = cache(`links|${env.globe}|${s.assignments.length}`, () =>
      s.assignments.map((a) => {
        const r = s.regions[a.region], p = s.pops[a.pop];
        const lift = env.globe ? Math.min(a.km * 1000 * 0.06, 220e3) : 0;
        return { ...a, colour: p.colour, path: greatCircle([r.lon, r.lat], [p.lon, p.lat], { alt: env.globe ? LINE_ALT : 0, lift }) };
      }),
    );
    const on = (a) => !sel || a.pop === sel.index;
    return [
      new PathLayer({
        id: 'region-links',
        data: links,
        getPath: (d) => d.path,
        getColor: (d) => [...d.colour, on(d) ? (sel ? 230 : 120) : 18],
        getWidth: (d) => (on(d) && sel ? 1.6 : 1) * (0.8 + Math.log2(1 + d.prefixes) * 0.35),
        widthUnits: 'pixels',
        widthMinPixels: 0.5,
        capRounded: true,
        billboard: true,
        pickable: true,
        parameters: params(env),
        updateTriggers: { getColor: selKey, getWidth: selKey },
      }),
      new ScatterplotLayer({
        id: 'region-dots',
        data: dots,
        getPosition: (d, { target }) => at(d, env, target),
        getRadius: (d) => d.radius,
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: (d) => [...d.colour, !sel ? 190 : served.has(d.id) ? 255 : 35],
        stroked: true,
        getLineColor: (d) => (sel && served.has(d.id) ? [255, 255, 255, 220] : [...DARK, 160]),
        lineWidthUnits: 'pixels',
        getLineWidth: (d) => (sel && served.has(d.id) ? 1.2 : 0.6),
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        onClick: (info) => (info.object ? (view.pickRegion(info.object), true) : false),
        parameters: params(env),
        updateTriggers: { getPosition: posTrig(env), getFillColor: selKey, getLineColor: selKey, getLineWidth: selKey },
      }),
    ];
  }

  function peering(env) {
    const pdb = view.peering();
    if (!pdb || !view.layers().has('peering')) return [];
    const key = `${pdb.fetched_at}|${pdb.pops_placed ?? -1}`;
    const facs = cache(`facs|${key}`, () => pdb.facilities.filter((f) => f.lon !== null && f.lat !== null));
    const ixes = cache(`ixes|${key}`, () => pdb.ixes.filter((x) => x.lon !== null && x.lat !== null));
    const maxSpeed = Math.max(1, ...ixes.map((x) => x.speed));
    return [
      new ScatterplotLayer({
        id: 'facilities',
        data: facs,
        getPosition: (d, { target }) => at(d, env, target),
        getRadius: 2.2,
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: [...FAC_COLOUR, 220],
        stroked: true,
        getLineColor: [...DARK, 200],
        lineWidthMinPixels: 0.6,
        pickable: true,
        parameters: params(env),
        updateTriggers: { getPosition: posTrig(env) },
      }),
      new ScatterplotLayer({
        id: 'ixes',
        data: ixes,
        getPosition: (d, { target }) => at(d, env, target),
        getRadius: (d) => 6 + 9 * Math.sqrt(d.speed / maxSpeed),
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: [...IX_COLOUR, 28],
        stroked: true,
        getLineColor: [...IX_COLOUR, 235],
        lineWidthUnits: 'pixels',
        getLineWidth: 1.6,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 90],
        onClick: (info) => (info.object ? (view.pickIx(info.object), true) : false),
        parameters: params(env),
        updateTriggers: { getPosition: posTrig(env) },
      }),
    ];
  }

  function backbone(env) {
    const b = view.backbone();
    if (!b || !view.layers().has('backbone')) return [];
    const data = cache(`backbone|${env.globe}|${b.links.length}|${b.source}`, () =>
      b.links.map((l) => {
        const d = Math.hypot(l.a.lon - l.b.lon, l.a.lat - l.b.lat) * 111e3;
        return { ...l, path: greatCircle([l.a.lon, l.a.lat], [l.b.lon, l.b.lat], { alt: env.globe ? LINE_ALT : 0, lift: env.globe ? Math.min(d * 0.08, 250e3) : 0 }) };
      }),
    );
    return [
      new PathLayer({
        id: 'backbone-links',
        data,
        getPath: (d) => d.path,
        getColor: [...BACKBONE_COLOUR, b.kind === 'measured' ? 220 : 150],
        getWidth: 2,
        widthUnits: 'pixels',
        capRounded: true,
        billboard: true,
        pickable: true,
        parameters: params(env),
      }),
    ];
  }

  const end = (info, id) => info?.layer?.id?.endsWith(`:${id}`);
  const tooltips = {
    pops: (info) => {
      const p = info.object;
      if (!p || !end(info, 'pop-dots')) return null;
      return `Starlink PoP ${p.code} · ${p.city || p.name}, ${p.country} (${(p.iata || '').toUpperCase()}) · ${p.v4_prefixes} IPv4 + ${p.v6_prefixes} IPv6 prefixes · ${p.regions.length} regions`;
    },
    regions: (info) => {
      const o = info.object;
      const s = view.shaped();
      if (!o || !s) return null;
      if (end(info, 'region-dots')) {
        const pop = s.pops[o.pop];
        const where = o.precision && o.precision !== 'city' ? ` (${o.precision} point)` : '';
        return `${regionLabel(o)}${where} · ${o.v4_prefixes + o.v6_prefixes} prefixes · ${pop ? `PoP ${pop.code} (${pop.city}), ${km(o.km)}` : 'no PoP'}`;
      }
      if (end(info, 'region-links')) return `${regionLabel(s.regions[o.region])} → ${s.pops[o.pop].city} (${s.pops[o.pop].code}) · ${km(o.km)} · ${o.prefixes} prefixes`;
      return null;
    },
    peering: (info) => {
      const o = info.object;
      if (!o) return null;
      if (end(info, 'ixes')) return `IX ${o.name} · ${o.city}, ${o.country} · ${portsLabel(o.speeds)}${o.rs ? ' · route server' : ''} (PeeringDB; ${PLACED[o.located] ?? ''})`;
      if (end(info, 'facilities')) return `Facility ${o.name} · ${o.city}, ${o.country}${o.ixes.length ? ` · ${o.ixes.length} of its IXes` : ''} (PeeringDB)`;
      return null;
    },
    backbone: (info) => {
      const o = info.object;
      const b = view.backbone();
      if (!o || !b) return null;
      return `${o.a.city} (${o.from}) ↔ ${o.b.city} (${o.to})${o.rtt_ms !== null ? ` · ${o.rtt_ms.toFixed(1)} ms` : ''} · ${b.kind}: ${b.source}`;
    },
  };
  // In drawing order: the regions' lines under everything, then the PoPs, and
  // the IX rings over them (an IX is often in a PoP's city).
  return { groups: { regions, backbone, pops, peering }, tooltips };
}
