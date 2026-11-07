# Apps

The apps sidebar holds apps that each focus the map on one network. The first
one is Starlink (AS14593, epic #28). On desktop the open app's panel docks at
the right: it collapses to the rail (`]`, or its chevron) and you resize it by
the grip on its left edge (drag it, or focus it and use `←` `→`). The map and
the details card reflow to its left. On narrow screens (≤ 720 px) it's a
bottom drawer with three heights: peek, half and full. You drag its handle or
header, or use its `⌃` `⌄` buttons, or focus the handle and use `↑` `↓`. The
rail lists the apps. Its button opens an app, and the open app's button shows
or collapses its panel.

| file | what |
|------|------|
| `index.js` | the apps the rail lists, in order |
| `registry.js` | the app contract and its checks; loads an app's code once |
| `host.js` | which app is open, and its `ctx` (below) |
| `layers.js` | apps' deck.gl layers, and how main.js composes them |
| `appHash.js` | the apps' part of the permalink |
| `graph.js` | the loaded graph by ASN |
| `sidebar.js` | the DOM: the rail, the panel, the drawer (no tests: needs a browser) |
| `util.js` | `esc` and `fmt` for apps' HTML |
| `starlink/` | the Starlink app; `app.js` lists its sections (`SECTIONS`) |
| `starlink/pops/` | its PoPs section: PoPs, regions, PeeringDB and the backbone hook (#31) |
| `starlink/links/` | its gateways and modelled links section: SGP4 in a worker, the link model (#34) |

Everything but `sidebar.js` is DOM-free, and `npm test` covers it
(`*.test.js` here and in each app's folder; `fixtures.js` has a tiny graph
and a fake main.js).

## Writing an app

An app is a folder with an `index.js` entry, which `index.js` here lists:

```js
// apps/bgp/index.js
export default {
  id: 'bgp',              // lowercase, digits, dashes: app=bgp, and its params are bgp.<key>
  title: 'BGP live',
  icon: '<svg viewBox="0 0 24 24" aria-hidden="true">…</svg>', // inline, fill currentColor
  load: () => import('./app.js'), // its own chunk, loaded when first opened
};

// apps/bgp/app.js
export function mount(el, ctx) { … }   // may be async; el is a fresh <div> in the panel
export function unmount() { … }        // release what ctx doesn't (see below)
export function onHash(params) { … }   // optional: the hash's bgp.* params were edited
```

An entry may also carry `mount`, `unmount` and `onHash` itself instead of
`load`.

**Lifecycle.** One app is mounted at a time. Opening another one unmounts the
first. Collapsing the panel (`side=0`) keeps the app mounted, so its layers
stay on the map. Closing it (✕, or a hash without `app=`) unmounts it.
`unmount` can come before an async `mount` finishes. After `unmount`, the host
has already:

* aborted `ctx.signal`, so pass it to `fetch` and close sockets on its `abort`;
* removed the app's layers and its `ctx.on` listeners;
* made the old `ctx` inert: its `layers.set`, `hash.set`, `select`, `flyTo`,
  `route` and `notice` do nothing, so a late callback can't touch the next app.

Timers, sockets and anything else the app made itself are its own to stop.
If `mount` throws, the panel shows the error and the rest of netmap carries
on. A layer function that throws is skipped and warned about once.

**Looks.** The panel styles `h2`, `h3`, `dl`/`dt`/`dd`, `.asn`, `.muted`,
`code`, `.btn`/`.btn.primary` like the details card. It adds `.app-warn` (an
amber note), `.app-actions` (a row of buttons), `.app-nbrs` with `.app-link`
(a list of clickable ASes), and `details`/`summary`. Escape text with `esc`
from `util.js`. Anything modelled says so in the UI, and measured data shows
its timestamp (epic #28).

## `ctx`

Apps only use `ctx`, never main.js's state, so main.js can change underneath
them. ASes are named by ASN everywhere. On router maps (`dataset().kind ===
'routers'`) an ASN means the AS's best-connected PoP.

### The dataset and the graph

| | |
|-|-|
| `ctx.dataset()` | `{ id, base, root, name, kind: 'as'\|'routers', synthetic, counts, generated }` or `null` before the first load. `base` is the data base URL (`VITE_DATA_BASE`), `root` this dataset's (`${base}/${id}`), for files the pipeline writes next to it. |
| `ctx.dataBase` | the data base URL, at once |
| `ctx.node(asn)` | `{ asn, name, degree, level, region, geolocated }` or `null` if it isn't on this map. Synchronous, from the graph. `level` is 0 (edge) to 1 (core). |
| `ctx.info(asn)` | `Promise<record \| null>`: the details card's record (`info/<chunk>.json`: `cone`, `coreness` (k-core), `rank`, `providers`, `customers`, `peers`, `country`, `prefixes`, `nprefix`, `addrs`, `sites`, `pops`, …). It's `null` if the AS is absent, or if the dataset changed while it loaded. |
| `ctx.neighbours(asn)` | `[{ asn, name, rel, degree }]`, most links first. `rel` is what the neighbour is to `asn`: `'provider'`, `'customer'`, `'peer'` (or `'backbone'` on router maps). |
| `ctx.position(asn)` | `[lon, lat, alt]` where the node is drawn now, or `null`. In the cyber and hybrid layouts that's a layout position, not a place (see `view`). |

### Selection and the camera

| | |
|-|-|
| `ctx.selection()` | `{ asn, name, kind: 'explore'\|'waypoint' }` or `null`: the node explored (a click, the cyan card) or else the active waypoint |
| `ctx.select(asn, { fly = true })` | explore the AS (as a click does: its card, its links highlighted), and fly to it. Returns `false` if it isn't on the map. |
| `ctx.clearSelection()` | stop exploring |
| `ctx.route(asns, { fly = true })` | replace the search stack's waypoints with these ASes (an AS path, say); the route is drawn between them. Returns how many were on the map. |
| `ctx.flyTo(target)` | `{ asn }`, `{ lon, lat, zoom? }` (zoom in the 2D map's units, on the globe too), or `{ bbox: [west, south, east, north] }` (west > east crosses the antimeridian). Works on the 2D map and the globe. |
| `ctx.view.get()` | `{ view: 'map'\|'globe', mode: 'cyber'\|'hybrid'\|'geo', morph: 0..1, geographic, camera: { lon, lat, zoom } }`. `geographic` is true when nodes are at their places (`mode === 'geo'`). Lon/lat data (PoPs, probes) only line up with the nodes then. |
| `ctx.view.set({ view?, mode? })` | switch to the map or the globe, or jump the layout slider |

### Events

`ctx.on(event, fn)` returns an `off()`. Listeners are dropped when the app
unmounts. Each event fires only when what it reports changed.

| event | payload | when |
|-|-|-|
| `dataset` | `ctx.dataset()` | a dataset finished loading (the first, or another one picked) |
| `view` | `ctx.view.get()` | map ↔ globe, or the layout slider moved |
| `camera` | `{ lon, lat, zoom }` | the camera settled (debounced 250 ms) |
| `selection` | `ctx.selection()` | the explored node or the active waypoint changed |
| `orbits` | `{ active }` | the Orbits layer came or went, or its linked satellites changed |

### Layers over the map

```js
ctx.layers.set('pops', (env) => [
  env.geographic && new ScatterplotLayer({ id: 'dots', data, getPosition: (d) => [d.lon, d.lat, 0], … }),
], { tooltip: (info) => info.object?.name, placement: 'above' });
ctx.layers.remove('pops');
ctx.layers.clear();
ctx.layers.redraw(); // run the group functions again (something they read changed)
```

* A group is an array of deck.gl layers, or a function of the render's
  `env = { globe, view, mode, geographic, zoom }` that returns one (falsy
  entries are skipped). A function runs on every render (each zoom step), so
  keep it cheap. Keep `data` the same object between renders unless it
  changed, as main.js does: deck compares it by reference.
* main.js composes them on both views (`composeLayers`): the globe's Earth,
  the apps' `below` groups, the network, the apps' `above` groups (the
  default), then the Orbits links. The 2D map has no Earth and no Orbits.
* Each layer id becomes `app:<app>:<group>:<id>`, so apps can't collide with
  each other or with main.js's ids, which picking reads.
* On the globe, give layers `parameters: { depthCompare: 'less-equal',
  depthWriteEnabled: false }` so the Earth hides the far side. Arcs are
  yours to build (main.js uses `arcs.js`). The 2D map is a non-interleaved
  overlay on MapLibre (Web Mercator). Altitudes count only on the globe.
* Picking: make a layer `pickable` and give it `onClick`/`onHover`. The group's
  `tooltip(info)` text shows in netmap's tooltip. A click on an app's object
  doesn't change the selection.

### The Orbits layer and the clock (read-only)

| | |
|-|-|
| `ctx.orbits.active()` | the Orbits layer is on and running (globe only) |
| `ctx.orbits.anchors()` | `[{ id, name, kind, lon, lat, altKm }]`: what celestiary publishes now, the DSN's complexes and antennas (`dsn:*`) and the Starlink satellites linked to AS14593 |
| `ctx.orbits.starlinkLinks()` | those few Starlink satellites (`norad:*`), nearest AS14593's node |
| `ctx.orbits.time()` | the guest frame time of those anchors (Unix ms UTC), or `null` |
| `ctx.clock.now()` | netmap's clock, Unix ms UTC: the wall clock, or the moment `?orbits_t=` stops it at |
| `ctx.clock.live` | `false` while `?orbits_t=` stops it |

They are empty or `null` while the layer is off. Listen to `orbits`. Apps
can't subscribe to other anchors yet (`src/orbits.js`'s subscription is
netmap's own).

### Permalink

```
#…&app=starlink&side=1&starlink.pop=sea
```

`app=` is the open app, and `side=0` is its panel collapsed (desktop) or the
drawer at peek. The open app's own params are `<id>.<key>`.

| | |
|-|-|
| `ctx.hash.get(key)` | the value, a string, or `null` |
| `ctx.hash.all()` | `{ key: value }` |
| `ctx.hash.set(key, value)` / `ctx.hash.set({ k: v, … })` | `null`, `undefined` or `''` removes a key. Keys are `[a-z0-9_-]{1,32}`. Writes the permalink (debounced, as every control). |

Read your params in `mount`, since the hash's are there already. `onHash(params)`
gets them all when someone edits the hash (typed, pasted, back/forward) and
they differ from what the app has. Its own `hash.set` doesn't echo back. Only
the open app's params are in the permalink. Keep defaults out of it (a
`null` for the default), so links stay short.

### The rest

| | |
|-|-|
| `ctx.el` | the element mounted into |
| `ctx.app` | `{ id, title }` |
| `ctx.signal` | an `AbortSignal`, aborted on unmount |
| `ctx.notice(text)` | netmap's toast at the bottom (8 s): for "the live feed is offline" and the like |
| `ctx.track(name, params)` | analytics. It's main.js's one hook (`track` in "apps"), a no-op until `src/analytics.js` lands. The host adds `app_id`, and sends `app_open` and `app_close` itself. |
