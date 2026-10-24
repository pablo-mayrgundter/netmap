# netmap

Maps of cyberspace. AS-level maps of the internet in three layouts that share
one Web Mercator world, so the same zoom levels, tiles and basemaps work for all
of them:

| mode       | what it shows |
|------------|---------------|
| **cyber**  | Pure topology. Large Graph Layout (Adai et al. 2004, the Opte-project look), with the basemap faded out. |
| **geo**    | Every geolocated AS at the site that holds most of its address space. ASes in the same metro fan out on a sunflower spiral, so they separate as you zoom in. |
| **hybrid** | Its own layout: pin first, then LGL. Well-connected networks with a firm location (≥ `--hybrid-pin-degree` layout links, 10 by default, about 850 ASes) are pinned at their site. The Opte LGL kernel (`lgl_opte.c`, given the pins) then grows and relaxes everything else around them, at `--hybrid-km` (100 km) per LGL unit. So the free subtrees come out as Opte families, a hub's spokes all around it, next to the pins they hang from. The **Layout** slider runs cyber → hybrid → geo; the viewer blends neighbouring layouts for the stops in between, and nodes glide from stop to stop. Points of presence and fiber bundles are about places, so they apply only on the geo half. On the **3D globe**, altitude shows hierarchy: last-mile networks sit on the ground and the core hovers above the oceans. Long hops are drawn as great-circle arcs. |

Switching modes animates every node and link between layouts. Click a node to
see its prefixes, sites, customer cone, k-core and neighbours.

```
                 ┌────────────── pipeline/ (Python) ──────────────┐
CAIDA as-rel2 ──►│ asrel.py ─┐                                     │
CAIDA as2org  ──►│           ├─► metrics.py (cone, k-core, level)  │
RouteViews    ──►│ geo.py ───┤   layout.py  cyber | geo | hybrid   │──► web/public/data/<id>/
 pfx→AS          │ (join →   │   export.py  graph.bin + meta.json  │      graph.bin, meta.json,
DB-IP lite    ──►│  per-AS   │   tiles.py   XYZ PNG pyramid /      │      names.json, info/*.json,
 IP→city         │  geo)     │              on-demand tile server  │      tiles/<mode>/{z}/{x}/{y}.png
                 └───────────┴─────────────────────────────────────┘
                                                                          │
                      web/ (Vite, deck.gl + MapLibre) ◄───────────────────┘
                      WebGL vectors or raster tiles · dark grid / OSM / none · 2D map or 3D globe
```

## Quick start

```sh
pip install -e pipeline            # numpy, scipy, igraph, pillow

# Real topology from CAIDA (downloads ~50 MB + ~150 MB of geo/prefix data, cached in data/raw)
python -m netmap build --topology caida --name internet

# ...or offline: real ASes, prefixes and geography, with a synthetic AS graph
python -m netmap build --topology synthetic --name synthetic

# optional: static raster tiles (drop-in XYZ layer for any slippy map)
python -m netmap tiles web/public/data/internet --maxzoom 5
# optional: deep-zoom tiles rendered on demand, with a disk cache
python -m netmap serve-tiles web/public/data/internet --port 8765

cd web && npm install && npm run dev   # http://localhost:5173
#   ?tiles=http://localhost:8765 uses the on-demand server for the raster renderer
```

**Sampling.** The *Sampling* slider mimics how traceroute maps see the
internet. Each link has a rank: the first of up to 255 random vantage ASes
whose shortest-path (BFS) tree uses it. All the way left is one vantage
point's spanning tree, about one link per AS, which is the sparse Opte look.
Sliding right adds vantage points (16 trees ≈ 63% of links) up to the full AS
graph. Links on no shortest path appear only at the far right. The filter
runs on the GPU, so the slider is instant. *Backbone only* is a separate
view: each AS's primary provider link plus the core mesh, which is what the
cyber layout is computed from.

**Fiber bundles.** Links whose two ends fall in the same pair of grid cells
are merged into one fiber. This happens after PoP re-attachment and with the
current filters and sampling applied. Each fiber runs between the centroids
of its members' ends, its width is `log2(1 + links)`, and its brightness
follows the light of the links it replaces. Member links are hidden. The
*Bundle* slider sets the cell size from metro (about 5 km) to region (about
650 km), and hovering a fiber shows its transit/peering counts. It works in
cyber mode too, where it bundles links between nearby clusters.

Keys: `1` cyber · `2` hybrid · `3` geo (jumps on the layout slider) · `g` globe · `/` search · `Esc` stop
exploring, then clear the route. Camera (hold): `↑`/`↓` pitch, `←`/`→` rotate,
`A`/`D` strafe, `W`/`S` zoom; on the globe the arrows orbit. The compass resets
rotation and pitch.
The URL hash is a full permalink: every control (layout, view, basemap,
renderer, sliders, toggles), the dataset, the camera (2D map or globe) and the
selected AS. Opening a link restores the view exactly. Without a hash the
viewer starts on the geo globe with backbone, points of presence and
region-scale fiber bundles on.

A full CAIDA build (81k ASes, 657k links) takes about 30 s on a 4-core
box, and everything uses all cores by default (`NETMAP_THREADS` overrides).
Parsing DB-IP adds about 20 s the first time only. Raster tiles render in a
process pool with a C line splatter: a z0–5 layer takes about 16 s and z6–7
about 90 s on 4 cores.

**Cyber layout: Opte's LGL** (`pipeline/netmap/native/lgl_opte.c`, the
default, `--cyber opte`) ports the layout procedure of `lglayout` from
[Opte's LGL](https://github.com/TheOpteProject/LGL) (Adai 2002–03, Lyon
2004–22). A spanning tree that prefers links between hubs guides the layout.
It's laid out level by level from the tree's median, and after each level a
particle simulation runs (unit-range repulsion, edges as springs of rest
length 0.5). Families of leaves start on their parent, so sparse parts become
stars around their hub while dense parts mesh. It's checked against
`lglayout` itself on the same graphs: built from source and run with Opte's
settings (`-y -L`), the two agree on spread, edge-length distribution, how
evenly spokes surround hubs, and radial density. One deliberate change:
`lglayout -L`'s "are these all leaves?" test never succeeds, so it stacks
every family on its parent. The port does what the flag says
(`leaves_close=1` reproduces the original). It's multithreaded and
deterministic: 25 s for the AS backbone and about 100 s for the 149k-PoP
router map on 4 cores, versus 8.5 and 14 minutes for `lglayout`. A test
requires a hub-and-spoke graph to render as hubs surrounded by their own
spokes.

This file is **GPL-2.0-or-later**, being derived from LGL; the rest of netmap
is MIT. The compiled native library includes it, so builds that link it are
GPL.

**FR-style LGL** (`pipeline/netmap/native/lgl.c`, `--cyber lgl`) is a
reimplementation of LGL (Adai et al. 2004) using igraph's scheme: BFS layers, placement around
parents, grid-cutoff Fruchterman–Reingold, the same cooling. It's built for
throughput:

* nodes are relabelled in BFS order, so the placed set is an array prefix;
* every iteration counting-sorts nodes into grid cells, so the repulsion loop
  over neighbouring cells is contiguous, branch-free and sqrt-free, and the
  compiler vectorizes it (AVX2, NEON, or wasm SIMD128);
* a small pthread pool with dynamic chunks runs repulsion, attraction and the
  grid build;
* positions are double-buffered, so output is bit-identical for any thread
  count.

On the real backbone it takes 11 s on one thread and 4.7 s on four,
versus igraph's 103 s. Layout quality matches igraph's on the tests, but
like igraph's it throws a hub's spokes outward as one-sided rays rather than
around the hub, which is why it is no longer the default.

The other native kernels, all in `pipeline/netmap/native/`:

* `paths.c` builds the traceroute-style link sampling: shortest-path trees
  from 255 vantage ASes, run in parallel. It's BFS, or Dijkstra when given
  weights, and lowers ranks with an atomic min so results are deterministic.
  It takes 0.25 s, versus about 8 s with igraph.
* `splat.c` is the tile rasterizer's inner loop: jittered, bilinear line
  samples splatted into a float accumulator in one pass. The heaviest tiles
  render about 20× faster than with numpy.

It's plain C11 + pthreads with no dependencies. Python compiles it on first
use with the system `cc` (cached in `~/.cache/netmap`, `-march=native` when
supported) and loads it via ctypes. Without a compiler it falls back to
igraph (`--cyber lgl-igraph` forces that). `NETMAP_THREADS` sets the thread
count and `NETMAP_LGL_PROFILE=1` prints a timing breakdown. `make
netmap-lgl.mjs` in that directory builds a threaded WASM+SIMD module with
emscripten, for in-browser layout later (not yet wired up).

The cyber layout of the AS map runs on a **backbone**: each AS's primary
(largest-cone) provider link, plus the mesh among core ASes. Every link is
still drawn. Laying out the full graph (`--cyber-graph full`) gives a
featureless ball, because multihoming and peering tie everything together.
The provider tree is where the Opte starbursts come from.

## Orbits: satellites and space networks on the globe

The **orbits** control (globe only, off by default) draws the Earth's
satellites, Starlink's whole constellation, Iridium NEXT and its
crosslinks, and the Deep Space Network's antennas and live links into the
3D globe, in the right places at the current time. Each sub-toggle
(satellites, Starlink, Iridium, DSN) is in the permalink (`orbits`,
`osats`, `ostarlink`, `oiridium`, `odsn`).

netmap doesn't compute any of it. [celestiary](https://celestiary.org)
does: its *layer mode* page (`layer.html`, celestiary/web#296) runs in a
hidden cross-origin iframe and renders with three.js into a
[portal-netgl](https://github.com/pablo-mayrgundter/portal/tree/main/packages/portal-netgl)
recorder. Its WebGL calls come back by `postMessage` and are replayed into
the globe's own context right after deck.gl draws (`attachNetGLDeckLayer`),
in deck's clip space and against deck's depth, so the globe hides the far
side's satellites and no pixels are copied. `src/orbits.js` is the host
side; the protocol is portal's RFC 0001 (globe and orbit layers).

* **The clock.** netmap sends UTC now with every view, rounded to a tick
  (4 Hz; `?orbits_hz=1..30`). Once a tick, while the layer is on and the
  tab is visible, it asks the guest for a frame at the new time
  (`requestGuestFrame`, portal-netgl 0.6.0), and deck draws once, when the
  frame lands. It doesn't ask while a frame waits for its deck draw, so a
  GPU slower than the tick isn't sent frames it can't show. It used to
  force a deck redraw each tick, so deck drew twice a tick (the old frame,
  then the new), and while frames stalled the queued redraws ran in bursts
  of up to 185 draws. Off, or on the 2D map, or in a hidden tab, nothing
  ticks. `?orbits_t=<ISO time>` stops the clock at a moment.
* **One draw a guest frame.** The adapter folds its redraw for a guest
  frame into a deck draw made meanwhile, and the links' layer is updated
  only when its endpoints change: once a tick, not once a guest frame
  (`src/orbitsLinks.js`).
* **The far plane.** While the layer is on, the globe's far plane is 4×
  deck's default so the geostationary belt (6.6 Earth radii) fits from any
  zoom.
* **Hover.** The DSN's complexes and antennas, which the guest publishes as
  anchors (`dsn:GDSCC`, `dsn:DSS-43`), show in the tooltip.
* **Across engines.** With Starlink on, faint lines join AS14593 (SpaceX's
  Starlink) to the four Starlink satellites nearest its node, re-picked
  every minute. A guest whose hello says it answers "the n anchors nearest
  this point" (`ext['portal.anchors/1'].near`, proposed in celestiary#304)
  gets a `{near: {p, n: 4}, pattern: 'norad:*'}` subscription and sends
  just those four with each frame. With any other guest, each pick
  subscribes to `norad:*` for one guest frame, so the guest sends every
  satellite's anchor, about 11.7k and 1 MB, which takes the main thread 80
  to 120 ms to receive. The pick rides the next view and asks for no draw
  of its own.
* **The 2D map** can't host it yet: Web Mercator isn't a 4×4 camera the
  guest can draw with (RFC 0001, open question).
* **Failure.** If the page doesn't load in 60 s, doesn't answer 20 s after
  loading, doesn't finish loading its data in 90 s, or reports an error,
  netmap removes it, shows a notice and turns the control off
  (`?orbits_timeout=<s>` raises the limits on slow machines).
* **Measuring it:** `?orbits_perf=1`, below.

**What loads from where.** Only while the control is on: the guest page and
its scripts (about 230 KB gzipped, mostly three.js) and its data snapshots
(the CelesTrak catalogue, Starlink, Iridium, the DSN's configuration) from
celestiary.org, and the DSN Now live feed from `eyes.nasa.gov`, which the
guest polls. netmap's own code for it is a chunk of about 24 KB (10 KB
gzipped) loaded on first use, and the perf probe another 15 KB, only with
`?orbits_perf=1`.

**Measuring the Orbits layer on your GPU.** Add `?orbits_perf=1` to the
URL and turn Orbits on (e.g. `/?orbits_perf=1#view=globe&orbits=1`), and a
panel in the bottom-left corner shows the
layer's costs from netmap's side (`src/orbitsPerf.js`), medians and p95s:

* deck draws per guest frame, overall, at rest and in input's wake; the most
  draws in one animation frame, and how many frames had a burst of 3 or more;
  what asked for the draws (`drawReasons`);
* input → shown: from a pointer or key event to the first deck draw showing a
  guest frame drawn for a view sent after it; and the lag behind the camera,
  in ms, of what a draw shows (`lagMs`);
* per guest frame: messages, GL calls, kB, and the main-thread time to
  receive them, deserialising (`deserMsPerFrame`) and handling;
* the host's main thread: how busy it is (long animation frames, 50 ms or
  more, so a lower bound) and which scripts ran in them (messages, animation
  frames, timers, input);
* the anchors: how many, and how long they take to receive;
* the adapter's redraws for guest frames, forced or folded into a draw deck
  made anyway, and how many views the clock asked for;
* the browser's animation frames: the gaps between them
  (`animationFrameGapMs`), and from a guest frame's end to the next one
  (`frameEndToNextAnimationFrameMs`). When a guest frame waits for its draw
  (`frameEndToDrawnMs`) about as long as it waits for the next animation
  frame, the browser wasn't giving the page a frame (GPU back-pressure), not
  the adapter skipping a redraw; when the draw waits much longer, it's the
  adapter;
* the guest's own means a frame, if it reports them: netmap sends
  `layer:stats-subscribe`, and a guest that answers (celestiary#304) sends
  `layer:stats` about once a second, with `updateMs`, `renderMs`,
  `recordMs`, `anchorsMs`, `calls`, `messages` and `bytes`.

Most of it hooks the adapter, not the wire: frames end at the receiver's
`onFrame`, views are the adapter's count, and draws are deck's own. The
wire's numbers (messages, bytes, deserialisation) are read where the
messages arrive: on window for wire 1 (a message a call), and on the
MessageChannel port for wire 2 (a frame as one `netgl:batch`). `wire` says
which the guest negotiated (`receiver.wire`).

To capture, load the view, wait about ten seconds at rest, then drag the
globe for ten seconds, then:

* **Copy summary** copies a short JSON (the browser, GPU and the summary)
  small enough to paste into a GitHub comment;
* **Copy JSON** copies everything: each guest frame, deck draw, view,
  input and long frame, on one clock (Unix ms), so a guest-side log lines
  up. It runs to a few MB;
* **Save JSON** downloads the same as a file, to attach to an issue (zip it
  if GitHub refuses `.json`).

`window.__orbitsPerf.snapshot()` returns it from the console. Nothing is sent
anywhere.

**Where the guest comes from.** Production is
`https://celestiary.org/layer.html`. A build can change that with
`VITE_ORBITS_SRC` and allow more origins with `VITE_ORBITS_ORIGINS`
(comma-separated). A link can pick another page with `?orbits_src=<url>`,
but only on an allowed origin, e.g. celestiary's PR previews,
`?orbits_src=https://celestiary.org/web/pr-preview/pr-296/layer.html`.
`localhost` and `127.0.0.1` are allowed only from a dev server or a
netmap served from localhost. The rules are in `src/orbitsConfig.js`
(`npm test`).

**Privacy.** The iframe is a third party. Turning the layer on makes your
browser request celestiary.org (and, through it, `eyes.nasa.gov`), which
see your IP address and, from the `Referer` and the `host=` parameter,
that netmap embedded them. netmap sends the guest only the camera, the
viewport size and the time, and the anchor patterns it wants; never what
you search, select or trace. The guest's draw calls are replayed only as
WebGL calls (portal-netgl refuses anything else), and the frame is
sandboxed (`allow-scripts allow-same-origin`: no navigating netmap,
popups or forms). Messages are pinned to the guest's origin both ways.

## Data

| source | used for | licence |
|---|---|---|
| [CAIDA AS Relationships](https://www.caida.org/catalog/datasets/as-relationships/) (serial-2) | links, transit vs. peering | CAIDA AUA |
| [CAIDA AS-to-Organization](https://www.caida.org/catalog/datasets/as-organizations/) | names, org country | CAIDA AUA |
| RouteViews prefix→AS (via [ip-location-db](https://github.com/sapics/ip-location-db), from npm) | address space per AS, prefixes | CC BY 4.0 |
| [DB-IP lite](https://db-ip.com) city (via ip-location-db) | per-AS geography | CC BY 4.0, attribution required |
| GeoLite2 city (`--geo geolite2-city`) | alternative geography | MaxMind EULA |
| OpenFlights airports (`@nwpr/airport-codes`) | hostname → airport geo hints | ODbL |

ip-location-db is pulled from the npm registry because it's mirrored
everywhere, including sandboxes that can't reach CAIDA or the CDNs.
**Synthetic bundles** keep the real ASes, names, prefixes and geography, but
`netmap.synthetic` generates their links. It's a tiered
preferential-attachment model with geographic affinity, a tier-1 clique,
IXP-style metro peering and hypergiant peering. The viewer labels these
bundles as synthetic.

### How an AS gets a place

`geo.profile_ases` joins every originated IPv4 range with the geolocation
ranges and weights each overlap by address count. That gives each AS:

* its **main site**: the address-weighted mode on a 1° grid, refined to the
  weighted mean inside that cell;
* its **concentration**: the share of its addresses within 400 km of that
  site. Regional ISPs score about 1. Cogent, Google and Comcast score 0.15–0.4;
* its country (weighted mode) and its top cities, shown in the info panel.

An AS has a firm location (concentrated) when its concentration is ≥ `--pin-threshold`
(0.6) and its customer cone is ≤ `--pin-max-cone` (400). Everything bigger or
more spread out floats, and gets points of presence in geo. Hybrid pins the
concentrated ASes with at least `--hybrid-pin-degree` layout links.

## Outputs

**Bundle** (`web/public/data/<id>/`):

* `meta.json` holds counts, palette, provenance and the section table for
  `graph.bin`.
* `graph.bin` holds packed typed arrays: `asn`, `pos_cyber`, `pos_geo` and
  `pos_hybrid` (lon/lat float32), `level`, `degree`, `cone`, `region`,
  `flags`, `edges` (uint32 pairs), `edge_rel` (−1 transit, 0 peering),
  `edge_rank` (sampling order, 255 = never sampled) and `edge_backbone`.
* `names.json` and `info/<k>.json` (1024 nodes per chunk) are loaded lazily on
  click.

**Tiles** (`<bundle>/tiles/<mode>/{z}/{x}/{y}.png` plus `tiles.json`) are
256 px Web Mercator tiles with transparent backgrounds. The renderer is a
numpy splatting rasteriser: edges are clipped, sampled into a float RGB
accumulator, then tone-mapped with `1 − exp(−gain·density)`. That gives the
additive Opte glow, where dense bundles blow out to white, and it's fast
enough for on-demand deep zoom. They work as a plain XYZ layer anywhere:

```js
// Leaflet
L.tileLayer('/data/internet/tiles/hybrid/{z}/{x}/{y}.png', { maxNativeZoom: 5 }).addTo(map);
// Google Maps
map.overlayMapTypes.push(new google.maps.ImageMapType({
  getTileUrl: (c, z) => `/data/internet/tiles/hybrid/${z}/${c.x}/${c.y}.png`, tileSize: new google.maps.Size(256, 256) }));
// Bing Maps (v8)
map.layers.insert(new Microsoft.Maps.TileLayer({ mercator: new Microsoft.Maps.TileSource({
  uriConstructor: '/data/internet/tiles/hybrid/{zoom}/{x}/{y}.png' }) }));
```

The WebGL viewer (`deck.gl` LineLayer/ArcLayer/ScatterplotLayer over MapLibre)
draws the full graph directly. SVG isn't viable at 350k+ links, but WebGL
handles it at interactive rates. The raster tiles are for embedding and for
static hosting without JavaScript-heavy clients.

## Deploying

Everything is served statically from the `gh-pages` branch:

* `pages.yml` runs on every push to `main`, monthly, and on demand. It builds
  the CAIDA bundle, renders raster tiles to z4, builds the viewer and pushes
  the result to the root of `gh-pages`. It leaves `pr-preview/` alone.
* `preview.yml` uses
  [rossjrw/pr-preview-action](https://github.com/rossjrw/pr-preview-action)
  to publish each PR's viewer to `/pr-preview/pr-<N>/` and comment the link
  on the PR. The preview is removed when the PR closes. Each preview builds
  its own CAIDA bundle and shallow tiles, about 2 minutes, so pipeline
  changes show up too.
* `ci.yml` runs the pipeline tests and the viewer build.

One-time setup: **Settings → Pages → Build and deployment → Source: Deploy
from a branch → `gh-pages` / `(root)`**. The branch is created by the first
`pages` run. Also set **Settings → Actions → General → Workflow permissions
→ Read and write**, so workflows can push to `gh-pages` and comment on PRs.

## Roadmap

* **Router level.** CAIDA Ark traceroutes and ITDK router-level topology.
  `netmap.iata` already pulls geo hints from router hostnames
  (`be3037.ccr21.dfw01.atlas.cogentco.com` → DFW), so long-haul router hops
  can be pinned to airports. That also means drawing them as catenary arcs
  between cities.
* **Cables.** Pin intercontinental hops to submarine cable routes
  (TeleGeography) and landing stations when a hop matches one.
* **IPv6.** Same pipeline over the `-ipv6-num` tables (128-bit ranges).
* **Time-lapse.** CAIDA has monthly as-rel snapshots back to 1998. Keep
  layouts stable across months by seeding each one from the previous
  snapshot.
* **Datacenter/cluster mode.** Same viewer, with a bundle from internal
  topology and traffic matrices instead of BGP.
