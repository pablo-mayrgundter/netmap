// Apps' deck.gl layers over the map (ctx.layers; README in this folder), and
// how main.js composes them with its own on the 2D map and on the globe.
// DOM-free (layers are anything with an id and deck's clone()), so node's
// tests import it.
//
// Each app owns named groups of layers. A group is an array of layers, or a
// function of the render's env ({ globe, view, mode, geographic, zoom })
// returning one, called on every render, so a group can differ between the
// 2D map and the globe or follow the layout. Every layer's id is rewritten to
// app:<app>:<group>:<id>, so no app can take one of main.js's ids ('nodes',
// 'edges', ...), which picking reads.

export const LAYER_PREFIX = 'app:';
export const layerId = (app, group, id) => `${LAYER_PREFIX}${app}:${group}:${id}`;

/** { app, group, id } of a composed layer id, or null for one of main.js's. */
export function parseLayerId(id) {
  if (typeof id !== 'string' || !id.startsWith(LAYER_PREFIX)) return null;
  const [app, group, ...rest] = id.slice(LAYER_PREFIX.length).split(':');
  return rest.length ? { app, group, id: rest.join(':') } : null;
}

export function createLayerStore({ onChange = () => {}, warn = (...a) => console.warn(...a) } = {}) {
  const groups = new Map(); // app -> Map(group -> { layers, tooltip, placement })
  const failed = new Set(); // app:group whose function threw (warned once)

  const check = (app, group) => {
    if (typeof group !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(group)) throw new TypeError(`layer group ${JSON.stringify(group)}: letters, digits, _ and -`);
  };

  function expand(app, group, g, env) {
    let list = g.layers;
    if (typeof list === 'function') {
      try {
        list = list(env);
      } catch (err) {
        const k = `${app}:${group}`;
        if (!failed.has(k)) failed.add(k), warn(`[apps] ${app}'s layers ${group}:`, err);
        return [];
      }
    }
    const out = [];
    for (const l of [].concat(list ?? [])) {
      if (!l) continue; // [on && layer] reads naturally
      if (typeof l.clone !== 'function' || typeof l.id !== 'string') {
        const k = `${app}:${group}:shape`;
        if (!failed.has(k)) failed.add(k), warn(`[apps] ${app}'s layers ${group}: not a deck.gl layer`, l);
        continue;
      }
      out.push(l.clone({ id: layerId(app, group, l.id) }));
    }
    return out;
  }

  return {
    /**
     * Set (add or replace) an app's group of layers. `layers`: an array of
     * deck.gl layers, or (env) => layers. Options: `placement` 'above' (the
     * default: over the network) or 'below' (under it, over the globe's
     * Earth); `tooltip(info)` -> text for a hovered object of the group, or
     * null.
     */
    set(app, group, layers, { placement = 'above', tooltip = null } = {}) {
      check(app, group);
      if (placement !== 'above' && placement !== 'below') throw new TypeError(`placement ${placement}: above or below`);
      if (!groups.has(app)) groups.set(app, new Map());
      groups.get(app).set(group, { layers, placement, tooltip });
      failed.delete(`${app}:${group}`);
      onChange();
    },
    remove(app, group) {
      if (groups.get(app)?.delete(group)) onChange();
    },
    /** Drop every group of an app (when it unmounts). */
    clear(app) {
      if (groups.get(app)?.size) {
        groups.delete(app);
        onChange();
      } else groups.delete(app);
    },
    /** The groups an app has, in the order set. */
    groups: (app) => [...(groups.get(app)?.keys() ?? [])],
    /** Every app's layers for one render: { below, above }, each in the order set. */
    compose(env) {
      const out = { below: [], above: [] };
      for (const [app, gs] of groups) for (const [group, g] of gs) out[g.placement].push(...expand(app, group, g, env));
      return out;
    },
    /** The tooltip text for a deck picking info over an app's layer, or null. */
    tooltip(info) {
      const p = parseLayerId(info?.layer?.id);
      const g = p && groups.get(p.app)?.get(p.group);
      if (!g?.tooltip) return null;
      try {
        return g.tooltip(info) ?? null;
      } catch (err) {
        warn(`[apps] ${p.app}'s tooltip ${p.group}:`, err);
        return null;
      }
    },
  };
}

/**
 * One view's layer list: the base map (the globe's Earth), the apps' layers
 * placed below the network, the network, the apps' layers above it, and
 * what goes on top of everything (the Orbits links). main.js uses it for the
 * 2D map (no base, no top) and for the globe.
 */
export function composeLayers({ base = [], network = [], apps = { below: [], above: [] }, top = [] }) {
  return [...base, ...apps.below, ...network, ...apps.above, ...top];
}
