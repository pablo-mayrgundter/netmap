// The ATC app's deck.gl layers, as ctx.layers groups: the en route centers,
// and the open incident's sites, modelled access lines and flood reach. Each
// group is a function of the render's env, reading the app's state through
// `view`; data is memoised so deck sees the same objects between renders.

import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { CENTERS, shapeIncident } from './data.js';

const GLOBE_PARAMS = { depthCompare: 'less-equal', depthWriteEnabled: false };
const FLAT_PARAMS = { depthCompare: 'always' };
const params = (env) => (env.globe ? GLOBE_PARAMS : FLAT_PARAMS);
const MARK_ALT = 12e3;
const alt = (env) => (env.globe ? MARK_ALT : 0);

export const COLOURS = {
  center: [120, 190, 255],
  home: [255, 214, 120],
  site: [255, 96, 72],
  blocked: [150, 156, 170],
  flood: [255, 120, 60],
  access: [255, 214, 120],
};
const DARK = [8, 12, 20];
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * `view`: incident(), step() (an index), pickSite(id).
 * Returns { groups, tooltips } for ctx.layers.set.
 */
export function createMapLayers(view) {
  let memoKey = null, memoVal = null;
  const shaped = (env) => {
    const inc = view.incident();
    if (!inc) return null;
    const key = `${inc.id}|${view.step()}|${env.globe}`;
    if (key !== memoKey) (memoKey = key), (memoVal = shapeIncident(inc, view.step(), { globe: env.globe }));
    return memoVal;
  };
  const at = (d, env, target) => ((target[0] = d.lon), (target[1] = d.lat), (target[2] = alt(env)), target);

  function centers(env) {
    const s = shaped(env);
    const homes = new Set(s?.homes.map((h) => h.id) ?? []);
    const key = `${[...homes].join()}|${s?.flood}`;
    return [
      new ScatterplotLayer({
        id: 'center-dots',
        data: CENTERS,
        getPosition: (d, { target }) => at(d, env, target),
        getRadius: (d) => (homes.has(d.id) ? 7 : 5.5),
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: (d) => (homes.has(d.id) ? [...COLOURS.home, 240] : s?.flood ? [...COLOURS.flood, 200] : [...COLOURS.center, 220]),
        stroked: true,
        getLineColor: [...DARK, 230],
        getLineWidth: 1.2,
        lineWidthUnits: 'pixels',
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        parameters: params(env),
        updateTriggers: { getPosition: `${env.globe}`, getRadius: key, getFillColor: key },
      }),
      s?.flood &&
        new ScatterplotLayer({
          id: 'center-rings',
          data: CENTERS,
          getPosition: (d, { target }) => at(d, env, target),
          getRadius: 11,
          radiusUnits: 'pixels',
          billboard: true,
          filled: false,
          stroked: true,
          getLineColor: [...COLOURS.flood, 150],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          parameters: params(env),
          updateTriggers: { getPosition: `${env.globe}` },
        }),
      !env.globe &&
        new TextLayer({
          id: 'center-labels',
          data: CENTERS,
          getPosition: (d, { target }) => at(d, env, target),
          getText: (d) => d.id,
          fontFamily: FONT,
          fontWeight: 600,
          getSize: 11,
          getColor: [230, 236, 248, 220],
          getPixelOffset: [9, 0],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          fontSettings: { sdf: true },
          outlineWidth: 3,
          outlineColor: [...DARK, 230],
          parameters: params(env),
          updateTriggers: { getPosition: `${env.globe}` },
        }),
    ];
  }

  function incident(env) {
    const s = shaped(env);
    if (!s) return [];
    const k = `${memoKey}`;
    return [
      s.reach.length &&
        new PathLayer({
          id: 'reach',
          data: s.reach,
          getPath: (d) => d.path,
          getColor: [...COLOURS.flood, 150],
          getWidth: 1.6,
          widthUnits: 'pixels',
          capRounded: true,
          pickable: true,
          parameters: params(env),
          updateTriggers: { getPath: k },
        }),
      new PathLayer({
        id: 'access',
        data: s.access,
        getPath: (d) => d.path,
        getColor: (d) => (d.site.blocked ? [...COLOURS.blocked, 200] : [...COLOURS.access, 230]),
        getWidth: 2.5,
        widthUnits: 'pixels',
        capRounded: true,
        pickable: true,
        parameters: params(env),
        updateTriggers: { getPath: k, getColor: k },
      }),
      new ScatterplotLayer({
        id: 'site-dots',
        data: s.sites,
        getPosition: (d, { target }) => at(d, env, target),
        getRadius: (d) => (d.focus ? 9 : 7),
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: (d) => [...(d.blocked ? COLOURS.blocked : COLOURS.site), 245],
        stroked: true,
        getLineColor: (d) => (d.focus ? [255, 255, 255, 255] : [...DARK, 230]),
        getLineWidth: (d) => (d.focus ? 2.5 : 1.2),
        lineWidthUnits: 'pixels',
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        onClick: (info) => (info.object ? (view.pickSite(info.object.id), true) : false),
        parameters: params(env),
        updateTriggers: { getPosition: `${env.globe}`, getRadius: k, getFillColor: k, getLineColor: k, getLineWidth: k },
      }),
      s.flood &&
        new ScatterplotLayer({
          id: 'site-halo',
          data: s.sites,
          getPosition: (d, { target }) => at(d, env, target),
          getRadius: 16,
          radiusUnits: 'pixels',
          billboard: true,
          filled: false,
          stroked: true,
          getLineColor: [...COLOURS.site, 170],
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          parameters: params(env),
          updateTriggers: { getPosition: `${env.globe}` },
        }),
      !env.globe &&
        new TextLayer({
          id: 'site-labels',
          data: s.sites,
          getPosition: (d, { target }) => at(d, env, target),
          getText: (d) => `${d.name}${d.blocked ? ' · blocked' : ''}`,
          fontFamily: FONT,
          fontWeight: 700,
          getSize: 12,
          getColor: [255, 255, 255, 240],
          getPixelOffset: [12, 0],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          fontSettings: { sdf: true },
          outlineWidth: 3,
          outlineColor: [...DARK, 230],
          parameters: params(env),
          updateTriggers: { getPosition: `${env.globe}`, getText: k },
        }),
    ];
  }

  const end = (info, id) => typeof info.layer?.id === 'string' && info.layer.id.endsWith(`:${id}`);
  const km = (x) => `${Math.round(x).toLocaleString('en-US')} km`;
  const tooltips = {
    centers: (info) => {
      const c = info.object;
      if (!c || !end(info, 'center-dots')) return null;
      return `${c.id} · ${c.name} · ${c.city}`;
    },
    incident: (info) => {
      const o = info.object;
      if (!o) return null;
      if (end(info, 'site-dots')) return `${o.name} · ${o.kind} · ${o.router}${o.blocked ? ' · blocked by L3Harris' : ''} · modelled home: ${o.home.id}`;
      if (end(info, 'access')) return `Modelled access line: ${o.site.name} → ${o.to.id} (nearest center, ${km(o.km)}). The real circuit isn't public.`;
      if (end(info, 'reach')) return `Flood reach (modelled): ${o.from.id} → ${o.to.id}. FTI's backbone topology isn't public; this shows reach, not the path.`;
      return null;
    },
  };

  return { groups: { centers, incident }, tooltips };
}
