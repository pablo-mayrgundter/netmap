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

Keys: `1` cyber · `2` hybrid · `3` geo (jumps on the layout slider) · `g` globe · `/` search · `]` the
apps panel · `Esc` stop exploring, then clear the route. Camera (hold): `↑`/`↓` pitch, `←`/`→` rotate,
`A`/`D` strafe, `W`/`S` zoom; on the globe the arrows orbit. The compass resets
rotation and pitch.
The URL hash is a full permalink: every control (layout, view, basemap,
renderer, sliders, toggles), the dataset, the camera (2D map or globe), the
selected AS, and the open app with its own state (`app=starlink`). Opening a link restores the view exactly, and an edit to the
hash (typed, pasted, or back and forward) applies without a reload; picking
a dataset from the list starts it without a route. Without a hash the
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

## Apps

The **apps sidebar** holds apps that each focus the map on one network. It's
a panel at the right on desktop (collapsible and resizable, the map reflows
to its left) and a bottom drawer on phones (peek, half, full). The rail lists
the apps. The first is **Starlink** (AS14593): its summary from the loaded
graph (cone, k-core, upstreams and peers), fly-to, and what's public about
its routing. Its **PoPs** section draws Starlink's PoPs (sized by IPv4
addresses) and customer regions (coloured by the PoP serving them, with a line
to it) from [Starlink data](#starlink-data), lists the regions farthest from
their PoP, and shows AS14593's IXes and facilities, fetched live from
PeeringDB's API and kept for the session. Click a PoP for its prefixes, IATA
code and top regions (`starlink.pop=<code>`; `starlink.layer=` picks the map
layers). The PoP-to-PoP backbone isn't published yet: the section says so,
and draws one when a source supplies it (`web/src/apps/starlink/pops/backbone.js`).
Its **Gateways and links** section (all of it *modelled*, and labelled so)
draws Starlink's gateway sites from [Starlink data](#starlink-data), and for
a dish you place on the map (`starlink.at=<lat>,<lon>`, or an example, or
your location rounded to 0.1°) the satellites above its 25° mask, the
serving satellite, the gateways that satellite sees above 25°, and the PoP
nearest the gateway: dish → satellite → gateway → PoP, straight radio legs
up to the satellite on the globe, through the sub-satellite point on the 2D
map, with each leg's slant range and light time. Satellite positions are
SGP4 from CelesTrak's elements (the snapshot celestiary's Orbits layer
draws, so the two agree), propagated in a Web Worker once a second on
netmap's clock; the serving satellite is the highest one in view that also
sees a gateway, held for the scheduler's 15 s slot. Where none does (mid-ocean,
or far from the gateways known), the traffic crosses the **laser mesh**: a
+Grid per shell among the satellites launched with lasers (from Group 2-1,
September 2021), two links in the plane and one to the nearest satellite in
each neighbouring plane, up to 5,000 km and clear of the Earth by 80 km,
rebuilt every 15 s, and Dijkstra finds the shortest path in light time to a
satellite that sees a gateway. The panel shows the hops and the latency
against fibre along the great circle (c/1.47), to the PoP and to a
destination PoP (`starlink.dest=<code>`). `starlink.layer` also takes `mesh`
(drawn round the camera on the globe) and `traffic`, an **estimate**: each of
the geofeed's customer regions, weighted by its IPv4 addresses, served and
routed by the same rules, summed into the load on each laser link, feeder
link and gateway and drawn as a heat map. No measured traffic data is public.
`starlink.sat=<norad>` selects a satellite. The section's "How this is
modelled" lists the assumptions and sources (`web/src/apps/starlink/links/`).
More panels are coming (#28). How to write an app, and the `ctx`
interface apps build on, are in [`web/src/apps/README.md`](web/src/apps/README.md).

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
* **No lag behind the camera.** A guest frame is rendered for the view
  netmap sent and lands a draw or more later, so while you pan or zoom the
  globe was at the new view and the satellites a frame behind it (the
  probe's `lagDraws` 1, `lagMs` 100 to 150 ms). portal-netgl's host
  reprojection (0.6.3, `reproject` on the adapter) now composes each guest
  frame for the globe's current view: the replay rewrites the guest's
  vertex shaders and corrects each `gl_Position` by C = VP_now · VP_frame⁻¹,
  exact for positions (and depth). Wide lines (the DSN's beams, Iridium's
  links) are extruded in pixels in the guest's shader, so a correction
  after that scaled their width: since portal-netgl 0.6.4 a guest shader
  that declares `uniform mat4 netgl_reproject` isn't wrapped and applies
  it to the line's ends before extruding (celestiary#306), and the lines
  keep their width and place too. The satellites still move in time only
  when the guest's next frame lands, and the guest's far-side cull of the
  DSN's dishes is the old view's for that frame. `?orbits_reproject=0`
  turns it off, to compare.
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
* host reprojection: of the draws that showed a guest frame behind the
  camera, the share composed for deck's view (`reprojected`), and how far
  the correction moved the guest's content, in pixels (`reprojectShiftPx`;
  each draw's `reproject` in the full JSON has its frame's `viewId`);
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

## map.html: NetMap as a guest in another app

`map.html` (built and deployed next to the app, at
`https://pablo-mayrgundter.github.io/netmap/map.html`) is NetMap for other
apps to embed: a [NetGL](https://github.com/pablo-mayrgundter/portal/tree/main/packages/portal-netgl)
**guest**. A host page loads it in a hidden cross-origin iframe; deck.gl
draws the globe into portal-netgl's recording WebGL2 context
(`makeNetGLGuestContext`, passed to deck as `gl`), and the host replays the
calls into its own context. [exo.cafe](https://exo.cafe) shows it live in
the gate on its street, and in place under its street, the map the die
sits on. It's portal RFC 0004 §5
([portal#56](https://github.com/pablo-mayrgundter/portal/issues/56)): a
window, drawn full frame for a globe camera the host asks for, or the
host's own camera as a matrix view in ECEF, drawn in place in its frame.

It draws the app's default globe from the same code (`src/globeScene.js`,
`src/earth.js`, `arcs.js`, `data.js`): the geo layout, backbone links in one
vantage tree, points of presence and their core routes, and the nodes,
glowing, over the dark grid and land. No MapLibre basemap and no fiber
bundles yet. It loads `?data=` if given, else the first AS-level dataset.

The protocol (`src/mapView.js`, `npm test`):

```
host                                        map.html (guest)
netgl:ready-ack                        ◄──  netgl:ready
layer:hello-ack {accepted}             ◄──  layer:hello {adapter: 'netmap',
                                              capabilities: {kinds: ['map'], frames: ['ecef'],
                                              views: ['globe-camera', 'matrix'], time, marks, parts},
                                              units: {meters: 1}, earth: {model: 'sphere', radius: 6370972},
                                              contracts: {color: 'display' | 'linear', alpha: 'premultiplied'}}
                                       ◄──  layer:status {status: 'loading' | 'ready' | 'degraded' | 'error'}
layer:view {viewId, view: {kind: 'globe-camera',
  lon, lat, zoom | fit, bearing, pitch,
  width, height, timeMs,
  marks: [{lon, lat, rgb?}]}}          ──►  deck draws that camera, full frame
layer:view {viewId, view: {kind: 'matrix', frame: 'ecef',
  viewMatrix, projectionMatrix,
  width, height, timeMs}}             ──►  deck draws the host's own camera
layer:view {viewId, part: 'window',
  view: {…}}                           ──►  another view, drawn as a frame of its own
replay into a texture                  ◄──  netgl:batch … frame-end {viewId, part?}
(send the view again)                  ◄──  layer:invalidate (the map's data came)
```

* **The camera** is deck's `GlobeView` view state. `fit` instead of `zoom`
  asks for the globe's disc to span that much of the frame's height (deck's
  zoom depends on the frame's height and the latitude; `fitZoom` works it
  out). Up to 16 `marks` are drawn as rings, e.g. where the host sits.
* **A matrix view** (`src/matrixView.js`) is the host's camera exactly: a
  view matrix from ECEF metres to its eye (rigid, column-major, float64)
  and its projection (only its field is used; deck makes its own near and
  far). deck's globe is float32 with no offset trick, about 0.75 m of
  precision, so as its `GlobeView` does it switches to a flat Web Mercator
  viewport above zoom 12, below some 30 km, centred under the camera and
  with deck's float64 offsets: it holds from 1 cm up. Low down the
  graticule near the camera is drawn densified (`nearGraticule`), since
  deck can't draw its own 2°-long segments from a few metres up.
  `npm test` checks that every point lands on the pixel the host's own
  matrices put it at, from orbit and from a centimetre over the ground.
* **`?output=linear`** decodes the frame from sRGB in a last pass (a deck
  `PostProcessEffect`, premultiplied), for a host that draws it into a
  linear buffer of its own and encodes it at its end; the hello's
  `contracts.color` says which.
* **Several views, one page.** A host that shows the map more than once
  (exo: the map in place under its street, and a framed globe at its gate)
  names each view but its main one with a `part`. Each is drawn as its own
  frame, tagged with it on its frame-end, so the host can replay each into
  its own target (portal-netgl's parts and `beforeFrame`): one deck and
  one download of the map for all of them. Each part keeps its own layers,
  hidden while another draws, and its own post-process buffers per size, so
  turning from one view to the other doesn't re-tessellate the land or
  re-upload the network; deck's own size is set with each view's. (deck
  tessellates a polygon once, under the viewport current then, so the ocean
  is 10° cells rather than one quad: a part's layers are first made under
  its own view, flat or globe.)
* **One frame per view**, and no other: deck's own redraws (data or shaders
  coming in) are held back (`_customRender`) and turned into a
  `layer:invalidate`, so the host never replays a frame it didn't ask for.
  Each frame updates deck's layers, draws, and submits luma's queued
  commands before `endFrame()`, so the frame holds all of its calls.
* **Who may embed it:** `https://exo.cafe` and
  `https://pablo-mayrgundter.github.io`, from `location.ancestorOrigins` or
  the referrer, or loopback hosts while `map.html` is itself on loopback.
  Messages are pinned to that origin both ways. Opened on its own, the page
  says what it is and draws nothing.

To try it locally, serve a build on one port and a host on another (two
origins):

```sh
cd web && npm run build && python3 -m http.server 5481 --directory dist
# exo: http://localhost:4173/?enter&netmap_src=http://127.0.0.1:5481/map.html
```

## Data

| source | used for | licence |
|---|---|---|
| [CAIDA AS Relationships](https://www.caida.org/catalog/datasets/as-relationships/) (serial-2) | links, transit vs. peering | CAIDA AUA |
| [CAIDA AS-to-Organization](https://www.caida.org/catalog/datasets/as-organizations/) | names, org country | CAIDA AUA |
| RouteViews prefix→AS (via [ip-location-db](https://github.com/sapics/ip-location-db), from npm) | address space per AS, prefixes | CC BY 4.0 |
| [DB-IP lite](https://db-ip.com) city (via ip-location-db) | per-AS geography | CC BY 4.0, attribution required |
| GeoLite2 city (`--geo geolite2-city`) | alternative geography | MaxMind EULA |
| OpenFlights airports (`@nwpr/airport-codes`) | hostname → airport geo hints | ODbL |
| Starlink's [geofeed](https://geoip.starlinkisp.net/feed.csv) and [PoP list](https://geoip.starlinkisp.net/pops.csv) | Starlink PoPs, prefixes, regions; AS14593's sites | published by Starlink, no licence stated |
| [OurAirports](https://ourairports.com/data/) airports, regions, countries | Starlink PoP and region locations | public domain |
| [clarkzjw/starlink-geoip-data](https://github.com/clarkzjw/starlink-geoip-data) | the previous Starlink snapshot, for the diff | CC BY-SA 4.0 |

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

**Starlink (AS14593)** is the exception. DB-IP puts its addresses where its
customers are, which for a satellite ISP says little about where the network
is. When `web/public/data/starlink/pops.json` exists (run `netmap starlink`
first, as the deploy workflows do), `build` sites AS14593 at its PoPs
instead, weighted by the IPv4 space Starlink assigns each one
(`geo.resite`): its main site moves from Atlanta to Miami, its concentration
drops from 0.24 to 0.05, and its points of presence in geo are its biggest
PoPs (12 at most, as for any AS). `--starlink-pops <file>` uses another file; `--starlink-pops none` keeps DB-IP's.

## Starlink data

`python -m netmap starlink` writes `web/public/data/starlink/` from Starlink's
own feeds, for the Starlink app. It takes a few seconds and needs no
other netmap data:

```sh
python -m netmap starlink                    # live feeds, cached per day in data/raw/starlink/
python -m netmap starlink --previous none    # no diff
python -m netmap starlink --feed feed.csv --pops pops.csv --ourairports ourairports/   # local files
```

**Sources.** `feed.csv` is Starlink's RFC 8805 geofeed (`prefix,country,region,city,`):
where the customers on each address block are. `pops.csv`, published since
October 2025, is `prefix,popcode,iata` (`9.170.0.0/24,lsancax1,lax`): the
point of presence each block is assigned to. Every `pops.csv` prefix is in the
feed (so far), but about one feed prefix in ten has no PoP. PoPs are placed at their
IATA code's airport and regions at a city, region or country point, all from
[OurAirports](https://ourairports.com/data/) (public domain, cached in
`data/raw/ourairports/`). Codes with a trailing digit (`atl2`, `pdx2`, second
PoPs in a metro) are matched without it; metro-area codes (`jkt`) go to the
area's main airport (CGK). Codes that are neither (`staging2`) leave the PoP
without a location, and `meta.json` lists them. The diff's previous snapshot
is from [clarkzjw/starlink-geoip-data](https://github.com/clarkzjw/starlink-geoip-data),
which archives both feeds a few times a week (CC BY-SA 4.0: attribute it,
and share derived data under the same licence). By default it's the newest
snapshot at least 30 days old (`--previous-days`), found through the GitHub
API (with `GITHUB_TOKEN` if set) or, where that's blocked, a tree-only git
clone. `--previous <pops.csv>` (and `--previous-feed`) diffs against a file
instead.

**Files.** All JSON. Lat/lon are degrees (4 decimals), `null` where unknown.
Prefixes are canonical CIDR strings, IPv4 in address order, then IPv6.

* **`pops.json`**, a list sorted by `code` (its index is the PoP index used
  below):
  `{code, iata, airport, located, name, city, country, lat, lon, v4_prefixes,
  v6_prefixes, v4_addresses, regions: [{id, country, region, city, prefixes}]}`.
  `iata` is the code as published (`atl2`), `airport` the one used to place it
  (`ATL`), `located` how (`"iata"`, `"metro"` or `null`), and `name`, `city`,
  `country` the airport's. `regions` are the feed locations its prefixes
  serve, most prefixes first; `id` is the index into `regions.json`.
* **`prefixes.json`**, columnar:
  `{schema, pops: [code], regions: [[country, region, city]], prefix: [cidr],
  pop: [int], region: [int]}`. Row `k` is `prefix[k]`, assigned to PoP
  `pops[pop[k]]` (`-1`: none) and located at `regions[region[k]]` (`-1`: not in
  the feed). `pops` and `regions` are in the same order as `pops.json` and
  `regions.json`. About 120 KB, 23 KB gzipped.
* **`regions.json`**, one entry per distinct feed `(country, region, city)`,
  sorted by those: `{id, country, country_name, region, region_name, city, lat,
  lon, precision, v4_prefixes, v6_prefixes, v4_addresses, pops: [{pop, code,
  prefixes}], no_pop_prefixes}`. `precision` says what the point is: `"city"`
  (an airport in a town of that name, or with it in its keywords), `"region"`
  or `"country"` (the mean of that ISO 3166-2 region's or country's airports),
  or `null`. In November 2026, 294 of 327 were cities, 14 regions, 16
  countries and 3 unplaced (Pitcairn, Svalbard, Tokelau).
* **`meta.json`**: `{schema, kind: "starlink", name, asn, fetched_at,
  generated, sources: {feed, pops, ourairports_*: {url, sha256, bytes,
  fetched_at, rows?, skipped?}}, counts, unmatched: {iata: [{code, iata,
  prefixes}], regions: [{country, region, city}]}, diff, diff_error, files,
  attribution, caveats}`. `diff` is `null` without a previous snapshot (and
  `diff_error` says why), else `{previous: {snapshot, pops, feed}, pops_added,
  pops_removed, pop_prefix_counts: [{code, before, after}], prefixes_assigned,
  prefixes_unassigned, prefixes_moved, moves: [{from, to, prefixes}], moved:
  [[prefix, from, to]], moved_truncated, feed: {prefixes_added,
  prefixes_removed, prefixes_relocated}}`.

In November 2026: 66 PoPs (65 placed), 4,548 prefixes (3,632 IPv4 and 916
IPv6, 883k IPv4 addresses), 4,095 of them with a PoP, in 327 locations in
224 countries and territories.

**Caveats.**

* A prefix's PoP is where Starlink assigns that block. It does not reliably
  predict which PoP a given user's traffic leaves through.
* Before October 2025 there was no PoP list. PoP mappings from then (such as
  clarkzjw's `geoip/` snapshots) came from DNS PTR records, which were often
  stale, so a diff across that date compares different methods.
* The feed's city is the market a block is sold into, not always a town
  (mines such as Meliadine, Starbase, "Mawson Peak"), and a few are
  misspelt. Customers can be far from it.
* A PoP is drawn at its airport, not at the facility.

`ci.yml` never fetches any of it: the tests run the command on a dozen-row
fixture in `pipeline/tests/fixtures/starlink/`. `pages.yml` and
`preview.yml` fetch the live feeds before building the map.

### Gateways

`python -m netmap starlink-gateways` writes `starlink/gateways.json`: the
gateway (ground station) sites the app's modelled links come down at, each
with where it's from. SpaceX publishes no list. The sites are
[NodalArc](https://github.com/dotchance/nodalarc)'s catalog
(`catalog/nodalarc/sites/earth/`, Apache-2.0; "facts are not owned by
NodalArc"), cloned sparsely at a pinned commit (`--ref`; `--sites <dir>`
reads a checkout). Only its Starlink gateway sites are kept, in two tiers:

* **`filing`**: the site's FCC earth-station licence (IBFS file numbers
  `SES-LIC-…`, `SES-MOD-…`, `SES-STA-…`; US government records, public
  domain), with a link to it. `located` is `"filing"` when the point is the
  licence's, `"town"` for the one site placed by a geocoder.
* **`reported`**: a site the catalog notes as a confirmed Starlink gateway
  with no filing (outside the US), placed at its town (±20 km or so).

The catalog's city-centre guesses, its own scenario sites, sites with no
source and sites that aren't Starlink gateways are left out (`excluded`
counts them). Licensed sites are cross-checked against
[tlrobinson/satsim](https://github.com/tlrobinson/satsim)'s list (BSD-2-Clause;
FCC file numbers from 2019 and 2020): by file number, or by place for a later
licence of the same site. In November 2026: 91 sites in 19 countries, 62 of
them licensed (US, Guam, Puerto Rico) and 29 reported; 32 cross-checked, all
within a kilometre but Sanderson TX, where satsim's longitude is 48 km out.

Rows: `{id, name, country, lat, lon, alt_m, tier, located, filing,
filing_url, source, antennas, cross_check: {source, by, km} | null}`, with
`sources` (the commit, licences, satsim's sha256), `counts`, `excluded`,
`attribution` and `caveats`. A licence isn't a working site, and Starlink
runs many more gateways than are public, above all outside the US: the app
says where its customer regions have no gateway within reach.

These hosts weren't reachable when this was built, so they aren't sources
yet: the FCC's own search (`licensing.fcc.gov`, `fcc.report`, `apps.fcc.gov`),
and the regulators of Canada (`sms-sgs.ic.gc.ca`), Australia
(`web.acma.gov.au`) and the UK (`ofcom.org.uk`).

### Orbital elements

The app propagates the constellation itself (SGP4, satellite.js) from
CelesTrak's general perturbations elements. It takes them, in order, from
celestiary's snapshot (`celestiary.org/data/earth/satellites/networks/starlink.json`,
the elements its Orbits layer draws), from netmap's own snapshot, or from
CelesTrak live. `python -m netmap starlink-gp` writes that snapshot,
`starlink/gp.json`: CelesTrak's Starlink group as columns (`fields`, `rows`,
the OMM fields SGP4 needs), about 1 MB, with the fetch's time and sha256
(`--gp <file>` reads a saved GP JSON). CelesTrak asks for one download per
two hours; the command caches by the hour.

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

## Analytics

The viewer can count how it's used with Google Analytics 4. It's **off by
default** and **opt-in**: nothing loads unless the build has a measurement ID
and the viewer clicks *Allow analytics* in the small prompt at the bottom of
the page. *No thanks* drops everything, and the choice is remembered in
`localStorage`. *Privacy*, at the foot of the controls card, opens the prompt
again to change it. With Do Not Track or Global Privacy Control set, netmap
never asks and never loads the tag.

What's sent (`web/src/analytics.js`): Consent Mode v2 starts with ads and
analytics storage denied, and *Allow* grants analytics storage only. Google
signals and ad personalisation are off. The page is sent as its origin and
path: never the query, and never the hash, which holds the whole view. Each
event instead carries `view`, the mode, map or globe, and dataset, as in
`geo:globe:internet`. Parameters are names, ids, ASNs and counts. Nothing you
type is sent, only the search's length and whether it found something.

| event | params |
| --- | --- |
| `dataset_load` | `dataset_id`, `kind` (as, routers), `nodes` (`lt1k` … `gte1m`), `load_ms`, `trigger` (boot, picker, hash) |
| `permalink_open` | `has_route`, `has_sel`, `has_camera`, `dataset_id`: opened with a hash |
| `mode_change` | `mode`, `from` (cyber, hybrid, geo), `via` (slider on release, button, key) |
| `globe_toggle` | `to` (map, globe) |
| `as_select` | `asn`, `how` (search, click, dblclick, neighbour), `role` (waypoint, explore), `waypoint` |
| `search` | `result` (hit, miss), `q_len`, `results`, `rank` |
| `route_trace` | `source` (search, traceroute, permalink), `waypoints`, `found`, `hops` |
| `orbits_toggle` | `layer` (orbits, sats, starlink, iridium, dsn), `on` |
| `basemap_change`, `renderer_change` | `basemap`, `renderer` |
| `style_change` | `control`, `on` (sliders report on release) |
| `app_open` | `app_id` |

The site's GA4 stream is `G-3PWPNFW02J` (a measurement ID is public: it's in
every page that loads the tag). `pages.yml` builds with it as
`VITE_GA_MEASUREMENT_ID`; the repository variable `GA_MEASUREMENT_ID`
(**Settings → Secrets and variables → Actions → Variables**) overrides it, for
a fork or another stream. PR previews build without it, so they stay out of
the data. In the GA4 data stream's *Enhanced
measurement*, turn off *Page changes based on browser history events*:
netmap rewrites its hash as you move, and those page views would carry it.
Locally, a dev server stays off unless it's asked to:
`VITE_GA_MEASUREMENT_ID=G-… npm run dev` and open `?ga_debug=1`, which also
shows the events in GA's DebugView. `VITE_GA_FORCE=1` turns it on for a
dev server or test build without the query. Other code records events with `track(name, params)` from
`web/src/analytics.js`, a no-op until the viewer allows it.

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
* Both deploy workflows run `netmap starlink` (Starlink's live feeds) before
  the map build.
* `ci.yml` runs the pipeline tests and the viewer build. It fetches nothing.

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
