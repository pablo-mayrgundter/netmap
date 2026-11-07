// The links section's deck.gl layers, as ctx.layers groups: the gateways, and
// the modelled path dish → satellite → gateway → PoP. On the globe the radio
// links are straight lines up to the satellite's altitude; on the 2D map they
// run through the sub-satellite point. Everything modelled is dashed (the
// PoPs, which are measured, are solid in the PoPs section). Each group is a
// function of the render's env; data is rebuilt only when a tick lands.

import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import { greatCircle } from '../pops/data.js';
import { ring } from './geometry.js';
import { fmtKm, fmtMs } from './format.js';

const GLOBE_PARAMS = { depthCompare: 'less-equal', depthWriteEnabled: false };
const FLAT_PARAMS = { depthCompare: 'always' };
const params = (env) => (env.globe ? GLOBE_PARAMS : FLAT_PARAMS);
const GROUND = 9e3; // m: ground points sit just above the Earth's mesh on the globe

export const COLOURS = {
  dish: [90, 220, 255],
  up: [90, 220, 255],
  sat: [235, 242, 255],
  inView: [170, 186, 214],
  down: [255, 186, 80],
  gateway: [255, 186, 80],
  backhaul: [255, 236, 190],
  footprint: [255, 186, 80],
};
const DARK = [8, 12, 20];
const DASH = new PathStyleExtension({ dash: true });
const dashed = { extensions: [DASH], getDashArray: [5, 3], dashJustified: true, dashGapPickable: true };

// The world, as 10° cells (the globe tessellates them; one quad doesn't
// draw): a click target for placing the dish.
const CELLS = [];
for (let lon = -180; lon < 180; lon += 10) for (let lat = -80; lat < 80; lat += 10) CELLS.push([[lon, lat], [lon + 10, lat], [lon + 10, lat + 10], [lon, lat + 10]]);
CELLS.push([[-180, 80], [180, 80], [180, 90], [-180, 90]], [[-180, -90], [180, -90], [180, -80], [-180, -80]]);

/** Unwrap `lon` to within 180° of `ref`, so a 2D line goes the short way. */
const near = (lon, ref) => lon + 360 * Math.round((ref - lon) / 360);

/**
 * The groups for ctx.layers.set. `view` gives the section's state: dish()
 * (the last tick's dish result or null), sat() (the selected satellite or
 * null), gateways() (gateways.json's rows), layers() (a Set), picking()
 * (placing the dish), and handlers placeAt(lon, lat), pickSat(norad).
 */
export function createLinkLayers(view) {
  let memoKey = null, memo = null;

  // Rebuilt once a tick (or when the view kind flips): the links' paths.
  function build(env) {
    const d = view.dish();
    const sel = view.sat();
    const key = `${env.globe}`;
    if (memo && memoKey === key && memo.d === d && memo.sel === sel) return memo;
    const alt = (h) => (env.globe ? h : 0);
    const out = { d, sel, paths: [], sats: [], inView: [], rings: [], gws: new Set(), labels: [] };
    if (d) {
      const u = [d.user.lon, d.user.lat];
      for (const v of d.visible) {
        const lon = env.globe ? v.lon : near(v.lon, u[0]);
        out.inView.push({ ...v, kind: 'in-view', position: [lon, v.lat, alt(v.alt)] });
      }
      const s = d.serving;
      if (s) {
        const sp = [env.globe ? s.lon : near(s.lon, u[0]), s.lat, alt(s.alt)];
        out.sats.push({ ...s, kind: 'serving', position: sp });
        out.labels.push({ position: sp, text: s.name, colour: COLOURS.sat }, { position: [u[0], u[1], 0], text: 'dish', colour: COLOURS.dish });
        out.paths.push({ kind: 'up', path: [[u[0], u[1], alt(GROUND)], sp], km: s.range, ms: (s.range / 299792.458) * 1000, colour: COLOURS.up, width: 2.6 });
        for (const g of d.gateways) out.gws.add(g.g);
        d.gateways.forEach((g, k) => {
          const exit = k === 0;
          const gp = [env.globe ? g.lon : near(g.lon, sp[0]), g.lat, alt(GROUND)];
          out.paths.push({ kind: exit ? 'down' : 'down-alt', path: [sp, gp], km: g.range, ms: (g.range / 299792.458) * 1000, gw: g, colour: COLOURS.down, width: exit ? 2.6 : 1, alpha: exit ? 255 : 90 });
        });
        const e = d.exit;
        if (e) out.labels.push({ position: [near(e.lon, sp[0]), e.lat, 0], text: `${e.name} gateway`, colour: COLOURS.gateway });
        if (e && e.popLon !== null) {
          const lift = env.globe ? Math.min(e.backhaulKm * 1000 * 0.05, 120e3) : 0;
          const gc = greatCircle([e.lon, e.lat], [e.popLon, e.popLat], { alt: alt(GROUND), lift });
          if (!env.globe) for (const p of gc) p[0] = near(p[0], e.lon);
          out.paths.push({ kind: 'backhaul', path: gc, km: e.backhaulKm, ms: e.backhaulMs, gw: e, colour: COLOURS.backhaul, width: 1.6 });
        }
        // The satellite's footprint at the gateway mask: where gateways can see it.
        if (s.footprint) out.rings.push({ path: ring(s.lon, s.lat, s.footprint).map(([lo, la]) => [env.globe ? lo : near(lo, u[0]), la, alt(GROUND)]), kind: 'footprint' });
      }
    }
    if (sel && (!d?.serving || d.serving.norad !== sel.norad) && Number.isFinite(sel.lon)) {
      out.sats.push({ ...sel, kind: 'selected', position: [sel.lon, sel.lat, alt(sel.alt)] });
      for (const g of sel.gateways ?? []) {
        out.gws.add(g.g);
        out.paths.push({ kind: 'sel-down', path: [[sel.lon, sel.lat, alt(sel.alt)], [env.globe ? g.lon : near(g.lon, sel.lon), g.lat, alt(GROUND)]], km: g.range, ms: (g.range / 299792.458) * 1000, gw: g, colour: COLOURS.down, width: 1.2, alpha: 160 });
      }
    }
    memoKey = key;
    memo = out;
    return out;
  }

  function pick(env) {
    if (!view.picking()) return [];
    return [
      new SolidPolygonLayer({
        id: 'place',
        data: CELLS,
        getPolygon: (d) => d,
        getFillColor: [90, 220, 255, 6],
        pickable: true,
        onClick: (info) => {
          const c = info.coordinate;
          if (!c) return false;
          view.placeAt(((((c[0] + 180) % 360) + 360) % 360) - 180, Math.max(-89.9, Math.min(89.9, c[1])));
          return true;
        },
        parameters: params(env),
      }),
    ];
  }

  function gateways(env) {
    const gws = view.gateways();
    if (!gws?.length || !view.layers().has('gateways')) return [];
    const b = view.layers().has('links') ? build(env) : null;
    const lit = b?.gws ?? new Set();
    const key = [...lit].join(',');
    return [
      new ScatterplotLayer({
        id: 'gateways',
        data: gws,
        getPosition: (g) => [g.lon, g.lat, env.globe ? GROUND : 0],
        getRadius: (g) => (lit.has(g.index) ? 6.5 : 4),
        radiusUnits: 'pixels',
        billboard: true,
        filled: true,
        stroked: true,
        // Filing: a solid marker at the licence's point; reported: a ring at the town.
        getFillColor: (g) => (g.tier === 'filing' ? [...COLOURS.gateway, lit.has(g.index) ? 255 : 200] : [...COLOURS.gateway, 30]),
        getLineColor: (g) => (lit.has(g.index) ? [255, 255, 255, 255] : g.tier === 'filing' ? [...DARK, 220] : [...COLOURS.gateway, 220]),
        getLineWidth: (g) => (g.tier === 'filing' && !lit.has(g.index) ? 1 : 1.6),
        lineWidthUnits: 'pixels',
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        parameters: params(env),
        updateTriggers: { getPosition: env.globe, getRadius: key, getFillColor: key, getLineColor: key, getLineWidth: key },
      }),
    ];
  }

  function links(env) {
    if (!view.layers().has('links')) return [];
    const b = build(env);
    const d = b.d;
    const layers = [];
    layers.push(
      new PathLayer({
        id: 'footprint',
        data: b.rings,
        getPath: (r) => r.path,
        getColor: [...COLOURS.footprint, 110],
        getWidth: 1,
        widthUnits: 'pixels',
        billboard: true,
        ...dashed,
        getDashArray: [2, 3],
        parameters: params(env),
      }),
      new PathLayer({
        id: 'in-view',
        data: b.inView,
        getPath: (v) => [[d.user.lon, d.user.lat, env.globe ? GROUND : 0], v.position],
        getColor: [...COLOURS.inView, 34],
        getWidth: 0.8,
        widthUnits: 'pixels',
        billboard: true,
        parameters: params(env),
      }),
      // A dark casing under the dashed legs, so they read over the busy network.
      new PathLayer({
        id: 'legs-casing',
        data: b.paths,
        getPath: (p) => p.path,
        getColor: (p) => [...DARK, p.alpha && p.alpha < 200 ? 60 : 170],
        getWidth: (p) => p.width + 3,
        widthUnits: 'pixels',
        capRounded: true,
        billboard: true,
        parameters: params(env),
      }),
      new PathLayer({
        id: 'legs',
        data: b.paths,
        getPath: (p) => p.path,
        getColor: (p) => [...p.colour, p.alpha ?? 240],
        getWidth: (p) => p.width,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        capRounded: true,
        billboard: true,
        pickable: true,
        ...dashed,
        parameters: params(env),
      }),
      new ScatterplotLayer({
        id: 'in-view-sats',
        data: b.inView,
        getPosition: (v) => v.position,
        getRadius: 2.2,
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: (v) => [...COLOURS.inView, v.terminal ? 210 : 130],
        pickable: true,
        onClick: (info) => (info.object ? (view.pickSat(info.object.norad), true) : false),
        parameters: params(env),
      }),
      new ScatterplotLayer({
        id: 'sats',
        data: b.sats,
        getPosition: (s) => s.position,
        getRadius: (s) => (s.kind === 'serving' ? 5.5 : 4.5),
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: (s) => (s.kind === 'serving' ? [...COLOURS.sat, 255] : [...COLOURS.down, 230]),
        stroked: true,
        getLineColor: (s) => (s.kind === 'serving' ? [...COLOURS.up, 255] : [255, 255, 255, 220]),
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        pickable: true,
        onClick: (info) => (info.object ? (view.pickSat(info.object.norad), true) : false),
        parameters: params(env),
      }),
    );
    // Names on the 2D map (deck's TextLayer draws nothing on the globe; there the tooltip names them).
    if (!env.globe && b.labels.length) {
      layers.push(
        new TextLayer({
          id: 'labels',
          data: b.labels,
          getPosition: (l) => l.position,
          getText: (l) => l.text,
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 11,
          getColor: (l) => [...l.colour, 240],
          getPixelOffset: [9, 0],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          fontSettings: { sdf: true },
          outlineWidth: 3,
          outlineColor: [...DARK, 230],
          parameters: params(env),
        }),
      );
    }
    if (d) {
      layers.push(
        new ScatterplotLayer({
          id: 'dish',
          data: [d.user],
          getPosition: (u) => [u.lon, u.lat, env.globe ? GROUND : 0],
          getRadius: 6,
          radiusUnits: 'pixels',
          billboard: true,
          getFillColor: [...COLOURS.dish, 255],
          stroked: true,
          getLineColor: [...DARK, 255],
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          pickable: true,
          parameters: params(env),
          updateTriggers: { getPosition: env.globe },
        }),
      );
    }
    return layers;
  }

  const end = (info, id) => info?.layer?.id?.endsWith(`:${id}`);
  const LEG = { up: 'Uplink, dish → satellite', down: 'Downlink, satellite → gateway', 'down-alt': 'Another gateway in view', backhaul: 'Backhaul, gateway → PoP (fibre at c/1.47)', 'sel-down': 'Gateway in the selected satellite\'s view' };
  const tooltips = {
    gateways: (info) => {
      const g = info.object;
      if (!g || !end(info, 'gateways')) return null;
      const src = g.tier === 'filing' ? `FCC licence ${g.filing}${g.located === 'town' ? ' (placed at its town)' : ''}` : 'reported, no filing here: placed at its town';
      return `Gateway ${g.name}, ${g.country} · ${src}${g.antennas ? ` · ${g.antennas} antennas` : ''}${g.pop ? ` · nearest PoP ${g.pop} (${fmtKm(g.popKm)})` : ''}`;
    },
    links: (info) => {
      const o = info.object;
      if (!o) return null;
      if (end(info, 'legs')) return `${LEG[o.kind] ?? o.kind} (modelled) · ${fmtKm(o.km)} · ${fmtMs(o.ms)} one way${o.gw ? ` · ${o.kind === 'backhaul' ? `${o.gw.name} → PoP ${o.gw.popCode} (${o.gw.popCity})` : o.gw.name}` : ''}`;
      if (end(info, 'sats') || end(info, 'in-view-sats')) {
        const what = o.kind === 'serving' ? 'serving satellite (modelled)' : o.kind === 'selected' ? 'selected satellite' : `in view${o.terminal ? ', sees a gateway' : ''}`;
        return `${o.name ?? `NORAD ${o.norad}`} · NORAD ${o.norad} · ${what}${Number.isFinite(o.el) ? ` · ${o.el.toFixed(0)}° up, ${fmtKm(o.range)}` : ''}${o.shell ? ` · ${o.shell}` : ''}`;
      }
      if (end(info, 'dish')) return `The dish (modelled user terminal) · ${o.lat.toFixed(2)}, ${o.lon.toFixed(2)}`;
      return null;
    },
    pick: () => 'Click to place the dish here',
  };
  return { groups: { pick, gateways, links }, tooltips };
}
