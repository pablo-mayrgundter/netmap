// The Incidents app's deck.gl layers, as ctx.layers groups: the en route
// centers with their status, and the open event's points and links at the
// current step. Each group is a function of the render's env, reading the
// app's state through `view`; data is memoised so deck sees the same objects
// between renders.

import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import { shapeEvent } from './data.js';

const GLOBE_PARAMS = { depthCompare: 'less-equal', depthWriteEnabled: false };
const FLAT_PARAMS = { depthCompare: 'always' };
const params = (env) => (env.globe ? GLOBE_PARAMS : FLAT_PARAMS);
const MARK_ALT = 12e3;
const alt = (env) => (env.globe ? MARK_ALT : 0);

export const COLOURS = {
  center: [120, 190, 255],
  site: [255, 214, 120],
  tracon: [190, 150, 255],
  airport: [200, 208, 222],
  alert: [255, 120, 60],
  down: [255, 64, 64],
  blocked: [150, 156, 170],
  access: [255, 214, 120],
  primary: [110, 220, 160],
  backup: [110, 220, 160],
  flood: [255, 120, 60],
};
const DARK = [8, 12, 20];
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const DASH = new PathStyleExtension({ dash: true });

const pointColour = (d) => (d.status === 'ok' ? COLOURS[d.kind] ?? COLOURS.center : COLOURS[d.status]);
const linkColour = (d) => (d.status === 'flood' ? COLOURS.flood : d.status === 'down' ? COLOURS.down : COLOURS[d.kind] ?? COLOURS.access);
const STATUS_WORD = { ok: '', alert: ' · affected', down: ' · down', blocked: ' · blocked' };

/**
 * `view`: event(), step() (an index), pickPoint(id).
 * Returns { groups, tooltips } for ctx.layers.set.
 */
export function createMapLayers(view) {
  let memoKey = null, memoVal = null;
  const shaped = (env) => {
    const ev = view.event();
    if (!ev) return null;
    const key = `${ev.id}|${view.step()}|${env.globe}`;
    if (key !== memoKey) (memoKey = key), (memoVal = shapeEvent(ev, view.step(), { globe: env.globe }));
    return memoVal;
  };
  const at = (d, env, target) => ((target[0] = d.lon), (target[1] = d.lat), (target[2] = alt(env)), target);
  const trig = (env) => `${memoKey}|${env.globe}`;

  const dots = (id, data, env, { radius, pick = false }) =>
    new ScatterplotLayer({
      id,
      data,
      getPosition: (d, { target }) => at(d, env, target),
      getRadius: (d) => (d.focus ? radius + 2 : d.status === 'ok' ? radius : radius + 1.5),
      radiusUnits: 'pixels',
      billboard: true,
      getFillColor: (d) => [...pointColour(d), 240],
      stroked: true,
      getLineColor: (d) => (d.focus ? [255, 255, 255, 255] : [...DARK, 230]),
      getLineWidth: (d) => (d.focus ? 2.5 : 1.2),
      lineWidthUnits: 'pixels',
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 110],
      onClick: pick ? (info) => (info.object ? (view.pickPoint(info.object.id), true) : false) : undefined,
      parameters: params(env),
      updateTriggers: { getPosition: trig(env), getRadius: trig(env), getFillColor: trig(env), getLineColor: trig(env), getLineWidth: trig(env) },
    });

  const rings = (id, data, env, radius) =>
    data.length > 0 &&
    new ScatterplotLayer({
      id,
      data,
      getPosition: (d, { target }) => at(d, env, target),
      getRadius: radius,
      radiusUnits: 'pixels',
      billboard: true,
      filled: false,
      stroked: true,
      getLineColor: (d) => [...COLOURS[d.status], 170],
      getLineWidth: 1.8,
      lineWidthUnits: 'pixels',
      parameters: params(env),
      updateTriggers: { getPosition: trig(env), getLineColor: trig(env) },
    });

  const labels = (id, data, env, text, { size = 11, offset = 9, weight = 600 } = {}) =>
    !env.globe &&
    new TextLayer({
      id,
      data,
      getPosition: (d, { target }) => at(d, env, target),
      getText: text,
      characterSet: 'auto',
      fontFamily: FONT,
      fontWeight: weight,
      getSize: size,
      getColor: [235, 240, 250, 230],
      getPixelOffset: (d) => [d.labelLeft ? -offset : offset, 0],
      getTextAnchor: (d) => (d.labelLeft ? 'end' : 'start'),
      getAlignmentBaseline: 'center',
      fontSettings: { sdf: true },
      outlineWidth: 3,
      outlineColor: [...DARK, 230],
      parameters: params(env),
      updateTriggers: { getPosition: trig(env), getText: trig(env) },
    });

  function centers(env) {
    const s = shaped(env);
    if (!s) return [];
    const hot = s.centers.filter((c) => c.status !== 'ok');
    return [dots('center-dots', s.centers, env, { radius: 5.5 }), rings('center-rings', hot, env, 11), labels('center-labels', s.centers, env, (d) => d.id)];
  }

  function event(env) {
    const s = shaped(env);
    if (!s) return [];
    const hot = s.points.filter((p) => p.status === 'alert' || p.status === 'down');
    const solid = s.links.filter((l) => l.status !== 'down');
    const cut = s.links.filter((l) => l.status === 'down');
    const pathLayer = (id, data, extra) =>
      data.length > 0 &&
      new PathLayer({
        id,
        data,
        getPath: (d) => d.path,
        getColor: (d) => [...linkColour(d), d.kind === 'reach' ? 150 : 230],
        getWidth: (d) => (d.kind === 'reach' ? 1.6 : 2.5),
        widthUnits: 'pixels',
        capRounded: true,
        pickable: true,
        parameters: params(env),
        updateTriggers: { getPath: trig(env), getColor: trig(env) },
        ...extra,
      });
    return [
      pathLayer('links', solid),
      pathLayer('links-down', cut, { getDashArray: [4, 3], dashJustified: true, extensions: [DASH] }),
      rings('point-rings', hot, env, 15),
      dots('point-dots', s.points, env, { radius: 7, pick: true }),
      labels('point-labels', s.points, env, (d) => `${d.label ?? d.name}${STATUS_WORD[d.status] ?? ''}`, { size: 12, offset: 12, weight: 700 }),
    ];
  }

  const end = (info, id) => typeof info.layer?.id === 'string' && info.layer.id.endsWith(`:${id}`);
  const km = (x) => `${Math.round(x).toLocaleString('en-US')} km`;
  const tooltips = {
    centers: (info) => {
      const c = info.object;
      if (!c || !end(info, 'center-dots')) return null;
      return `${c.id} · ${c.name} · ${c.city}${STATUS_WORD[c.status] ?? ''}`;
    },
    event: (info) => {
      const o = info.object;
      if (!o) return null;
      if (end(info, 'point-dots')) return `${o.name}${STATUS_WORD[o.status] ?? ''}${o.detail ? ` · ${o.detail}` : ''}`;
      if (end(info, 'links') || end(info, 'links-down')) return `${o.label} (${o.from.name} → ${o.to.name}, ${km(o.km)})${o.status === 'down' ? ' · down' : ''}`;
      return null;
    },
  };

  return { groups: { centers, event }, tooltips };
}
