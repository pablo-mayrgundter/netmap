// The app host: which app is open, its ctx (the interface apps build on),
// its layers and hash params, and the events main.js feeds it. README in
// this folder documents ctx. DOM-free: main.js hands it a `bridge` of
// functions over its own state, and the sidebar (sidebar.js) a mount point,
// so node's tests drive it with fakes.

import { createLayerStore } from './layers.js';
import { appHashChanges, PARAM_KEY, readAppHash, writeAppHash } from './appHash.js';
import { datasetOf, indexOf, neighboursOf, nodeSummary } from './graph.js';

export const EVENTS = ['dataset', 'view', 'camera', 'selection', 'orbits'];

/**
 * @param {object} o
 * @param {ReturnType<import('./registry.js').createRegistry>} o.registry
 * @param {object} o.bridge main.js's side (see main.js, "apps"): graph(),
 *   dataBase, position(i), select(i|null), flyToNode(i), flyTo({lon, lat,
 *   zoom}), fitBounds([w, s, e, n]), setRoute(nodes, {fly}), view(),
 *   setView({view, mode}), selection(), orbits(), clock(), redraw(),
 *   writeHash(), notice(text), track(name, params)
 * @param {(app) => object} o.mountPoint a fresh element for an app to mount into
 * @param {(...a) => void} [o.warn]
 */
export function createAppHost({ registry, bridge, mountPoint, warn = (...a) => console.warn(...a) }) {
  const store = createLayerStore({ onChange: () => bridge.redraw(), warn });
  const listeners = new Map(EVENTS.map((e) => [e, new Set()]));
  const params = new Map(); // app id -> { key: value }, the open app's in the hash
  const changes = new Set(); // the sidebar's subscriptions (onChange)
  let want = { app: null, side: true }; // what's asked for (the hash): app may still be loading
  let cur = null; // the mounted app: { id, app, el, ctx, abort, offs }
  let gen = 0;

  const notify = () => {
    for (const fn of changes) fn(host.state());
  };

  const selectionOf = () => {
    const g = bridge.graph();
    const s = bridge.selection();
    const i = s.explore ?? s.selected;
    if (!g || i === null || i === undefined) return null;
    return { asn: g.asn[i], name: g.names[i], kind: s.explore !== null && s.explore !== undefined ? 'explore' : 'waypoint' };
  };
  // What each event hands its listeners when main.js gives no payload.
  const PAYLOAD = {
    dataset: () => datasetOf(bridge.graph(), bridge.dataBase),
    view: () => bridge.view(),
    camera: () => bridge.view().camera,
    selection: selectionOf,
    orbits: () => ({ active: !!bridge.orbits() }),
  };

  function emit(event, payload) {
    if (!listeners.get(event)?.size) return;
    if (payload === undefined) payload = PAYLOAD[event]();
    for (const fn of [...(listeners.get(event) ?? [])]) {
      try {
        fn(payload);
      } catch (err) {
        warn(`[apps] a ${event} listener:`, err);
      }
    }
  }

  function makeCtx(c) {
    const { id } = c;
    const alive = () => cur === c;
    const G = () => bridge.graph();
    const node = (asn) => indexOf(G(), asn);
    const ctx = {
      app: { id, title: c.app.title },
      el: c.el,
      /** Aborted when the app unmounts: pass it to fetch, WebSocket closers, timers. */
      signal: c.abort.signal,

      // --- the dataset and the graph ---
      dataBase: bridge.dataBase,
      dataset: () => datasetOf(G(), bridge.dataBase),
      node: (asn) => nodeSummary(G(), asn),
      info: async (asn) => {
        const g = G();
        const i = node(asn);
        if (i === undefined) return null;
        const rec = await g.info(i);
        return G() === g ? rec ?? null : null; // a new dataset meanwhile
      },
      neighbours: (asn) => neighboursOf(G(), asn),
      position: (asn) => {
        const i = node(asn);
        return i === undefined ? null : bridge.position(i);
      },

      // --- selection and the camera ---
      selection: selectionOf,
      select(asn, { fly = true } = {}) {
        if (!alive()) return false;
        const i = node(asn);
        if (i === undefined) return false;
        bridge.select(i);
        if (fly) bridge.flyToNode(i);
        return true;
      },
      clearSelection() {
        if (alive()) bridge.select(null);
      },
      route(asns, { fly = true } = {}) {
        if (!alive()) return 0;
        const nodes = asns.map(node).filter((i) => i !== undefined);
        bridge.setRoute(nodes, { fly });
        return nodes.length;
      },
      flyTo(target) {
        if (!alive() || !target) return false;
        if (target.asn !== undefined) {
          const i = node(target.asn);
          if (i === undefined) return false;
          bridge.flyToNode(i);
          return true;
        }
        if (Array.isArray(target.bbox) && target.bbox.length === 4 && target.bbox.every(Number.isFinite)) {
          bridge.fitBounds(target.bbox);
          return true;
        }
        if (Number.isFinite(target.lon) && Number.isFinite(target.lat)) {
          bridge.flyTo({ lon: target.lon, lat: target.lat, zoom: Number.isFinite(target.zoom) ? target.zoom : undefined });
          return true;
        }
        return false;
      },
      view: {
        get: () => bridge.view(),
        set: (v) => alive() && bridge.setView(v),
      },

      // --- events: dataset, view, camera, selection, orbits ---
      on(event, fn) {
        if (!listeners.has(event)) throw new TypeError(`no event ${event} (${EVENTS.join(', ')})`);
        if (!alive()) return () => {};
        listeners.get(event).add(fn);
        const off = () => listeners.get(event).delete(fn);
        c.offs.push(off);
        return off;
      },

      // --- layers over the map ---
      layers: {
        set: (group, layers, opts) => alive() && store.set(id, group, layers, opts),
        remove: (group) => store.remove(id, group),
        clear: () => store.clear(id),
        /** Call a group's function again (it read something that changed). */
        redraw: () => alive() && bridge.redraw(),
      },

      // --- the Orbits layer (read-only; null/[] while it's off) and the clock ---
      orbits: {
        active: () => !!bridge.orbits(),
        anchors: () => bridge.orbits()?.anchors() ?? [],
        starlinkLinks: () => bridge.orbits()?.links() ?? [],
        time: () => bridge.orbits()?.time() ?? null,
      },
      clock: {
        now: () => bridge.clock().now(),
        get live() {
          return bridge.clock().live;
        },
      },

      // --- this app's permalink params (<id>.<key> in the hash) ---
      hash: {
        get: (key) => params.get(id)?.[key] ?? null,
        all: () => ({ ...(params.get(id) ?? {}) }),
        set(key, value) {
          if (!alive()) return;
          const next = { ...(params.get(id) ?? {}) };
          const entries = typeof key === 'object' && key !== null ? Object.entries(key) : [[key, value]];
          for (const [k, v] of entries) {
            if (!PARAM_KEY.test(k)) throw new TypeError(`hash key ${JSON.stringify(k)}: a-z, 0-9, _ and -, up to 32`);
            if (v === null || v === undefined || v === '') delete next[k];
            else next[k] = String(v);
          }
          params.set(id, next);
          bridge.writeHash();
        },
      },

      notice: (text) => alive() && bridge.notice(String(text)),
      track: (name, p = {}) => bridge.track(name, { app_id: id, ...p }),
    };
    return Object.freeze(ctx);
  }

  function unmount() {
    const c = cur;
    cur = null;
    if (!c) return;
    c.abort.abort();
    for (const off of c.offs) off();
    store.clear(c.id);
    try {
      c.app.unmount();
    } catch (err) {
      warn(`[apps] ${c.id} unmount:`, err);
    }
    c.el.remove?.();
  }

  const host = {
    registry,
    /** { app, side, loading, mounted }: what the sidebar draws. */
    state: () => ({ app: want.app, side: want.side, loading: !!want.app && cur?.id !== want.app, mounted: cur?.id ?? null }),
    onChange(fn) {
      changes.add(fn);
      return () => changes.delete(fn);
    },

    /** Open an app (loading its code if need be), unmounting the one open. */
    async open(id, { side = true } = {}) {
      if (!registry.has(id)) return false;
      if (want.app === id) {
        host.setSide(side);
        return true;
      }
      unmount();
      want = { app: id, side };
      const g = ++gen;
      notify();
      bridge.writeHash();
      let app;
      try {
        app = await registry.resolve(id);
      } catch (err) {
        if (g !== gen) return false;
        warn(`[apps] ${id} didn't load:`, err);
        bridge.notice(`${registry.get(id).title} didn't load (${err.message}).`);
        want = { app: null, side: true };
        notify();
        bridge.writeHash();
        return false;
      }
      if (g !== gen) return false; // another app (or none) meanwhile
      const c = { id, app, el: mountPoint(app), abort: new AbortController(), offs: [] };
      cur = c;
      c.ctx = makeCtx(c);
      const failed = (err) => {
        warn(`[apps] ${id} mount:`, err);
        if (cur === c && c.el) c.el.textContent = `${app.title} failed to start: ${err?.message ?? err}`;
      };
      try {
        Promise.resolve(app.mount(c.el, c.ctx)).catch(failed);
      } catch (err) {
        failed(err);
      }
      notify();
      bridge.track('app_open', { app_id: id });
      return true;
    },
    close() {
      if (!want.app) return;
      const id = want.app;
      gen++;
      unmount();
      want = { app: null, side: true };
      notify();
      bridge.writeHash();
      bridge.track('app_close', { app_id: id });
    },
    /** The panel shown (true) or collapsed to the rail / the drawer's peek (false); the app stays mounted. */
    setSide(open) {
      if (want.side === !!open) return;
      want = { ...want, side: !!open };
      notify();
      bridge.writeHash();
    },

    /** main.js's render() feeds these; listeners get them only on change. */
    emit,
    /** The apps' layers for one render ({ below, above }: layers.js composeLayers). */
    layers: (env) => store.compose(env),
    tooltip: (info) => store.tooltip(info),
    /** The open app's ctx (tests, the console). */
    ctx: () => cur?.ctx ?? null,

    /** Write the apps' keys into a permalink (URLSearchParams). */
    writeHash: (h) => writeAppHash(h, { app: want.app, side: want.side, params: params.get(want.app) ?? {} }),
    /**
     * Apply a hash (on load, and when it's edited): open or close the app it
     * names, show or collapse the panel, and hand the open app params that
     * changed to its onHash.
     */
    applyHash(h) {
      const next = readAppHash(h, (id) => registry.has(id));
      const now = { app: want.app, side: want.side, params: params.get(want.app) ?? {} };
      const ch = appHashChanges(next, now);
      if (next.app && (ch.app || ch.params)) params.set(next.app, next.params);
      if (ch.app) {
        if (next.app) host.open(next.app, { side: next.side });
        else host.close();
        return;
      }
      if (ch.side) host.setSide(next.side);
      if (ch.params && cur?.id === next.app && cur.app.onHash) {
        try {
          cur.app.onHash({ ...next.params });
        } catch (err) {
          warn(`[apps] ${cur.id} onHash:`, err);
        }
      }
    },
  };
  return host;
}
