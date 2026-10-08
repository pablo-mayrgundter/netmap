# netmap

Maps of cyberspace. AS-level maps of the internet in three layouts that share
one Web Mercator world, so the same zoom levels, tiles and basemaps work for all
of them:

| mode       | what it shows |
|------------|---------------|
| **cyber**  | Pure topology. Large Graph Layout (Adai et al. 2004, the Opte-project look), with the basemap faded out. |
| **geo**    | Every geolocated AS at the site that holds most of its address space. ASes in the same metro fan out on a sunflower spiral, so they separate as you zoom in. |
| **hybrid** | ASes concentrated in one metro are **pinned** to it. Global transit, CDNs, national backbones and ASes with no geo data **float**: the graph places them between the things they connect. A harmonic (Tutte) embedding solves for their positions, then a Fruchterman–Reingold pass relaxes them while pinned nodes stay fixed. On the **3D globe**, altitude shows hierarchy: last-mile networks sit on the ground and the core hovers above the oceans. Long hops are drawn as great-circle arcs. |

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
                      WebGL vectors or raster tiles · OSM / CARTO / none · 2D map or 3D globe
```

## Quick start

```sh
pip install -e pipeline            # numpy, scipy, igraph, pycairo

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

Keys: `1` cyber · `2` hybrid · `3` geo · `g` globe · `/` search · `Esc` deselect.
The URL hash keeps mode, view, camera and selected AS, so links are shareable.

Full-size build times on a 4-core box (84k ASes, about 350k links): profiling
geography takes about 30 s (plus about 20 s the first time to parse DB-IP),
LGL a few minutes, and the hybrid harmonic solve plus relaxation under a
minute. `--cyber drl` is available but much slower at this scale.

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

In hybrid mode an AS is pinned when its concentration is ≥ `--pin-threshold`
(0.6) and its customer cone is ≤ `--pin-max-cone` (400). Everything bigger or
more spread out floats.

## Outputs

**Bundle** (`web/public/data/<id>/`):

* `meta.json` holds counts, palette, provenance and the section table for
  `graph.bin`.
* `graph.bin` holds packed typed arrays: `asn`, `pos_cyber`, `pos_geo` and
  `pos_hybrid` (lon/lat float32), `level`, `degree`, `cone`, `region`,
  `flags`, `edges` (uint32 pairs) and `edge_rel` (−1 transit, 0 peering).
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
  on the PR. The preview is removed when the PR closes. Previews only rebuild
  the viewer and read the production data at `../../data`, so they take about
  a minute.
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
