"""Command line: ``netmap fetch | build | tiles | serve-tiles``."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

from . import asrel, export, geo, layout, metrics, pops, sources, synthetic, tiles
from .regions import REGIONS, region_of

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CACHE = ROOT / "data" / "raw"
DEFAULT_OUT = ROOT / "web" / "public" / "data"

ATTRIBUTION_ITDK = ('The CAIDA UCSD Macroscopic Internet Topology Data Kit (ITDK) - {release}, '
                    '<a href="https://catalog.caida.org/dataset/macroscopic_internet_topology_data_kit_itdk">catalog</a>')
ATTRIBUTION_CAIDA_REL = ('The CAIDA UCSD AS Relationships Dataset - {name}, '
                         '<a href="https://catalog.caida.org/dataset/as_relationships_serial_2">catalog</a>')

ATTRIBUTION_CAIDA_ORG = ('The CAIDA UCSD AS to Organization Mapping Dataset, '
                         '<a href="https://catalog.caida.org/dataset/as_organizations">catalog</a>')

ATTRIBUTION = {
    "routeviews": "Prefix-to-AS: RouteViews / NRO via ip-location-db (CC BY 4.0)",
    "dbip-city": 'IP geolocation: <a href="https://db-ip.com">DB-IP</a> lite (CC BY 4.0)',
    "geolite2-city": "IP geolocation: GeoLite2 by MaxMind (GeoLite2 EULA)",
    "caida": "AS relationships & AS-to-org: CAIDA (https://www.caida.org/catalog/datasets/)",
}


def _step(msg):
    print(f"[netmap] {msg}", file=sys.stderr)


def cmd_fetch(args):
    cache = Path(args.cache)
    sources.fetch_npm(cache, "asn")
    sources.fetch_npm(cache, args.geo)
    if args.caida:
        sources.fetch_caida_asrel(cache, args.date)
        sources.fetch_caida_as2org(cache)


def cmd_build(args):
    t0 = time.time()
    cache = Path(args.cache)
    out = Path(args.out) / args.name
    attribution = [ATTRIBUTION["routeviews"], ATTRIBUTION[args.geo]]

    _step("loading prefix->AS and geolocation tables")
    pfx_path = sources.fetch_npm(cache, "asn")["asn-ipv4-num.csv"]
    geo_path = next(iter(sources.fetch_npm(cache, args.geo).values()))
    pfx = geo.load_prefixes(pfx_path, cache / "parsed")
    gt = geo.load_geo(geo_path, cache / "parsed")
    _step("profiling AS address space and geography")
    prof = geo.profile_ases(pfx, gt)

    orgs: dict[int, asrel.OrgInfo] = {}
    if args.topology == "synthetic":
        _step("synthesising topology over real ASNs (no CAIDA data)")
        topo = synthetic.synthesize(prof, seed=args.seed, scale=args.synthetic_scale)
    else:
        path = Path(args.asrel) if args.asrel else sources.fetch_caida_asrel(cache, args.date)
        _step(f"parsing AS relationships {path.name}")
        topo = asrel.parse_asrel(path)
        org_path = Path(args.as2org) if args.as2org else None
        if org_path is None and not args.asrel:
            org_path = sources.fetch_caida_as2org(cache)
        if org_path:
            orgs = asrel.parse_as2org(org_path)
        attribution.append(ATTRIBUTION_CAIDA_REL.format(name=path.name[:8]))
        attribution.append(ATTRIBUTION_CAIDA_ORG)
    _step(f"topology: {topo.n} ASes, {topo.e} links")

    # Align profile rows to topology nodes.
    pidx = prof.index()
    rows = np.array([pidx.get(int(a), -1) for a in topo.asns], np.int64)
    known = rows >= 0
    r = np.where(known, rows, 0)
    has_geo = known & prof.has_geo[r]
    lat = np.where(has_geo, prof.lat[r], 0.0)
    lon = np.where(has_geo, prof.lon[r], 0.0)
    conc = np.where(has_geo, prof.concentration[r], 0.0)
    addrs = np.where(known, prof.addrs[r], 0.0)

    _step("computing metrics")
    g = metrics.graph_of(topo)
    m = metrics.compute(topo, g)

    names, countries = [], []
    for i, a in enumerate(topo.asns):
        a = int(a)
        o = orgs.get(a)
        nm = (o.org or o.name) if o else ""
        nm = nm or prof.names.get(a, "") or f"AS{a}"
        names.append(nm)
        cc = prof.country[rows[i]] if known[i] and has_geo[i] else ""
        countries.append(cc or (o.country if o else ""))
    region_idx = np.array([REGIONS.index(region_of(c)) for c in countries], np.uint8)

    _step("traceroute-style link sampling order")
    srank = metrics.sample_rank(topo, g, seed=args.seed)
    _step(f"cyber layout ({args.cyber} on {args.cyber_graph} graph)")
    bmask = layout.backbone_mask(topo.n, topo.src, topo.dst, topo.rel, m.cone, m.level)
    _step(f"  backbone: {int(bmask.sum())} of {topo.e} links")
    lg = g
    if args.cyber_graph == "backbone":
        lg = layout.backbone(topo.n, topo.src, topo.dst, topo.rel, m.cone, m.level)
    cyber = layout.cyber(lg, algo=args.cyber, seed=args.seed)
    pinned = has_geo & (conc >= args.pin_threshold) & (m.cone <= args.pin_max_cone)
    _step("geo layout")
    weight = np.log1p(m.degree) + np.log1p(addrs) * 0.1
    geo_ll = layout.geo(lat, lon, has_geo, weight)
    _step("cyber -> geo morph (hybrid is its halfway stop)")
    plon, plat = geo_ll
    lel = np.asarray(lg.get_edgelist(), np.int64).reshape(-1, 2)
    pin_w = np.where(has_geo, 0.25 + 0.75 * conc, 0.0)  # trust concentrated geolocation more
    stops = layout.morph(topo.n, lel[:, 0], lel[:, 1], cyber, geo_ll, pin_w, km=args.morph_km)
    hyb = stops[len(stops) // 2]
    _step("points of presence for floating ASes")
    sites_of = lambda i: prof.sites[rows[i]] if rows[i] >= 0 else []  # noqa: E731
    pp = pops.build(topo.n, topo.src, topo.dst, np.flatnonzero(has_geo & ~pinned), sites_of,
                    hyb[1], hyb[0])
    pp_lon, pp_lat = layout.sunflower(pp.lon, pp.lat, m.level[pp.node].astype(float),
                                      np.ones(pp.count, bool))
    _step(f"  {pp.count} PoPs for {int((np.diff(pp.offset) > 0).sum())} ASes, "
          f"{len(pp.routes)} core routes, {int((pp.edge_pop >= 0).any(1).sum())} links re-attached")
    # Nodes without geo sit at their hybrid position in geo mode (hidden there).
    geo_lon = np.where(has_geo, plon, hyb[0])
    geo_lat = np.where(has_geo, plat, hyb[1])

    _step("assembling info records")
    pfx_lists = geo.prefixes_by_as(pfx) if args.prefixes else {}
    info = []
    for i, a in enumerate(topo.asns):
        a = int(a)
        o = orgs.get(a)
        ri = int(rows[i])
        info.append({
            "asn": a,
            "name": names[i],
            "as_name": (o.name if o else ""),
            "country": countries[i],
            "addrs": int(addrs[i]),
            "nprefix": int(prof.nprefix[ri]) if ri >= 0 else 0,
            "prefixes": pfx_lists.get(a, []),
            "sites": prof.sites[ri][:5] if ri >= 0 else [],
            "pops": [[pp.city[k], round(float(pp.share[k]), 3)]
                     for k in range(pp.offset[i], pp.offset[i + 1])],
            "concentration": round(float(conc[i]), 3),
            "pinned": bool(pinned[i]),
            "degree": int(m.degree[i]),
            "providers": int(m.providers[i]),
            "customers": int(m.customers[i]),
            "peers": int(m.peers[i]),
            "cone": int(m.cone[i]),
            "coreness": int(m.coreness[i]),
            "rank": int(m.rank[i]),
            "level": round(float(m.level[i]), 3),
        })

    _step(f"writing bundle to {out}")
    meta = export.write_bundle(
        out, name=args.name, topo=topo, metrics=m, prof_rows=rows,
        layouts={"cyber": cyber, "geo": (geo_lon, geo_lat), "hybrid": hyb}, morph=stops,
        region_idx=region_idx, has_geo=has_geo, pinned=pinned, names=names, backbone=bmask,
        sample_rank=srank, pops=(pp, pp_lon, pp_lat),
        info_records=info, attribution=attribution,
    )
    _update_index(Path(args.out))
    _write_lookups(Path(args.out), pfx, cache)
    _step(f"done in {time.time() - t0:.0f}s: {meta['counts']}")


def _write_lookups(root: Path, pfx, cache: Path):
    """IP->AS and airport tables the viewer uses to resolve pasted traceroutes."""
    from . import iata, lookups

    n = lookups.write_ip2asn(root / "ip2asn.bin.gz", pfx)
    msg = f"{n} IP->AS boundaries"
    try:
        air = sources.fetch_npm(cache, "airports")["dist/airports.json"]
        msg += f", {lookups.write_iata(root / 'iata.json', iata.Gazetteer.from_openflights(air))} airports"
    except Exception as exc:  # optional: traces still resolve, just without city hints
        msg += f" (no airports: {exc})"
    _step(f"lookup tables: {msg}")


def cmd_build_itdk(args):
    """Router-level map from CAIDA's ITDK (traceroutes), aggregated to PoPs."""
    import igraph as ig

    from . import itdk

    t0 = time.time()
    cache = Path(args.cache)
    release, files = itdk.fetch(cache, args.release)
    _step(f"ITDK {release}: routers -> (AS, city) PoPs")
    agg = itdk.aggregate(files, cache / f"itdk-{release}")
    p = itdk.prune(agg, args.min_routers)
    n = len(p["pop_asn"])
    src, dst, weight = p["src"].astype(np.int64), p["dst"].astype(np.int64), p["weight"]
    _step(f"  {n} PoPs with >= {args.min_routers} routers, {len(src)} PoP links, "
          f"{int(weight.sum())} router links")

    # AS-level context from CAIDA: names, relationships, hierarchy.
    orgs, as_level, rel_p2c, rel_p2p = {}, {}, set(), set()
    attribution = [ATTRIBUTION_ITDK.format(release=release)]
    try:
        asrel_path = sources.fetch_caida_asrel(cache, args.date)
        orgs = asrel.parse_as2org(sources.fetch_caida_as2org(cache))
        at = asrel.parse_asrel(asrel_path)
        am = metrics.compute(at)
        as_level = dict(zip(at.asns.tolist(), am.level.tolist()))
        a_s, a_d = at.asns[at.src].astype(np.int64), at.asns[at.dst].astype(np.int64)
        p2c = at.rel == asrel.P2C
        rel_p2c = set(zip(a_s[p2c].tolist(), a_d[p2c].tolist()))
        rel_p2p = set(zip(np.minimum(a_s, a_d)[~p2c].tolist(), np.maximum(a_s, a_d)[~p2c].tolist()))
        attribution.append(ATTRIBUTION_CAIDA_REL.format(name=asrel_path.name[:8]))
    except Exception as exc:  # offline: no relationships, names from ASNs
        _step(f"  no CAIDA AS relationships ({exc}); all inter-AS links unlabelled")

    asn = p["pop_asn"]
    a_s, a_d = asn[src], asn[dst]
    rel = np.zeros(len(src), np.int8)
    rel[a_s == a_d] = itdk.INTRA
    for k in np.flatnonzero(a_s != a_d):
        x, y = int(a_s[k]), int(a_d[k])
        if (x, y) in rel_p2c:
            rel[k] = asrel.P2C
        elif (y, x) in rel_p2c:
            rel[k] = asrel.P2C
            src[k], dst[k] = dst[k], src[k]  # provider first
        elif (min(x, y), max(x, y)) in rel_p2p:
            rel[k] = asrel.P2P
    _step(f"  links: {int((rel == itdk.INTRA).sum())} intra-AS backbone, "
          f"{int((rel == asrel.P2C).sum())} transit, {int((rel == asrel.P2P).sum())} peering")

    topo = asrel.Topology(asns=asn.astype(np.uint32), src=src.astype(np.int32),
                          dst=dst.astype(np.int32), rel=rel,
                          source=f"CAIDA ITDK {release} ({itdk.TOPOLOGY}), routers aggregated to (AS, city) PoPs")
    g = metrics.graph_of(topo)
    m = metrics.compute(topo, g)
    wdeg = np.bincount(np.concatenate([src, dst]), weights=np.concatenate([weight, weight]), minlength=n)
    lw = np.log1p(wdeg)
    lw = lw / max(lw.max(), 1e-9)
    al = np.array([as_level.get(int(a), 0.0) for a in asn])
    m.level = np.clip(0.6 * al + 0.4 * lw, 0, 1).astype(np.float32)

    places = p["places"]
    lat, lon = p["place_lat"][p["pop_place"]], p["place_lon"][p["pop_place"]]
    _step("layouts")
    geo_ll = layout.sunflower(lon, lat, np.log1p(p["routers"]).astype(float), np.ones(n, bool))
    bmask = itdk.max_spanning_forest(n, src, dst, weight)
    lg = ig.Graph(n=n, edges=np.stack([src[bmask], dst[bmask]], 1).tolist())
    cyber = layout.cyber(lg, algo=args.cyber, seed=args.seed)
    stops = layout.morph(n, src[bmask], dst[bmask], cyber, geo_ll, np.ones(n), km=args.morph_km)
    srank = metrics.sample_rank(topo, g, seed=args.seed)

    names, countries, info = [], [], []
    for i in range(n):
        cc, region, city = (str(places[p["pop_place"][i]]).split("|") + ["", "", ""])[:3]
        o = orgs.get(int(asn[i]))
        as_name = (o.org or o.name) if o else f"AS{int(asn[i])}"
        names.append(f"{as_name} · {city or cc}")
        countries.append(cc)
        info.append({
            "asn": int(asn[i]), "name": names[-1], "as_name": as_name, "country": cc,
            "city": city, "region": region, "routers": int(p["routers"][i]),
            "router_links": int(wdeg[i]), "degree": int(m.degree[i]),
            "providers": int(m.providers[i]), "customers": int(m.customers[i]),
            "peers": int(m.peers[i]), "level": round(float(m.level[i]), 3),
            "rank": int(m.rank[i]), "coreness": int(m.coreness[i]),
        })
    region_idx = np.array([REGIONS.index(region_of(c)) for c in countries], np.uint8)
    out = Path(args.out) / args.name
    _step(f"writing bundle to {out}")
    allpin = np.ones(n, bool)
    meta = export.write_bundle(
        out, name=args.name, topo=topo, metrics=m, prof_rows=None,
        layouts={"cyber": cyber, "geo": geo_ll, "hybrid": stops[len(stops) // 2]}, morph=stops,
        region_idx=region_idx, has_geo=allpin, pinned=allpin, names=names, info_records=info,
        attribution=attribution, backbone=bmask, sample_rank=srank, edge_weight=weight,
        kind="routers",
    )
    _update_index(Path(args.out))
    _step(f"done in {time.time() - t0:.0f}s: {meta['counts']}")


def _update_index(root: Path):
    """datasets.json listing every bundle under the output root."""
    import json

    items = []
    for p in sorted(root.glob("*/meta.json")):
        mt = json.loads(p.read_text())
        items.append({"id": p.parent.name, "name": mt["name"], "synthetic": mt["synthetic"],
                      "kind": mt.get("kind", "as"),
                      "counts": mt["counts"], "generated": mt["generated"],
                      "tiles": sorted(d.name for d in (p.parent / "tiles").glob("*") if d.is_dir())})
    (root / "datasets.json").write_text(json.dumps(items, indent=1))


def cmd_tiles(args):
    bundle = Path(args.bundle)
    for mode in args.modes.split(","):
        _step(f"rendering {mode} tiles to z{args.maxzoom}")
        tiles.pyramid(bundle, bundle / "tiles", mode, args.maxzoom, backbone_only=args.backbone,
                      fmt=args.format, workers=args.workers)
    _update_index(bundle.parent)


def cmd_serve_tiles(args):
    bundle = Path(args.bundle)
    tiles.serve(bundle, Path(args.tile_cache or bundle / "tiles"), port=args.port)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="netmap", description=__doc__)
    ap.add_argument("--cache", default=str(DEFAULT_CACHE), help="raw data cache dir")
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="download raw datasets into the cache")
    f.add_argument("--geo", default="dbip-city", choices=["dbip-city", "geolite2-city"])
    f.add_argument("--caida", action="store_true", help="also fetch CAIDA as-rel2 + as2org")
    f.add_argument("--date", help="CAIDA snapshot YYYYMMDD (default latest)")
    f.set_defaults(fn=cmd_fetch)

    b = sub.add_parser("build", help="build a map bundle for the web viewer")
    b.add_argument("--name", default="internet", help="bundle id (directory name)")
    b.add_argument("--out", default=str(DEFAULT_OUT))
    b.add_argument("--topology", default="caida", choices=["caida", "synthetic"])
    b.add_argument("--asrel", help="local CAIDA as-rel(2) file instead of downloading")
    b.add_argument("--as2org", help="local CAIDA as-org2info file")
    b.add_argument("--date", help="CAIDA snapshot YYYYMMDD (default latest)")
    b.add_argument("--geo", default="dbip-city", choices=["dbip-city", "geolite2-city"])
    b.add_argument("--cyber", default="opte", choices=["opte", "lgl", "lgl-igraph", "drl", "fr"],
                   help="graph layout: opte = port of Opte's lglayout (default), lgl = FR-style "
                        "native LGL; both fall back to igraph's")
    b.add_argument("--cyber-graph", default="backbone", choices=["backbone", "full"],
                   help="lay out the primary-provider tree + core (Opte look) or every link")
    b.add_argument("--pin-threshold", type=float, default=0.6,
                   help="min share of an AS's addresses near its main site to pin it in hybrid")
    b.add_argument("--pin-max-cone", type=int, default=400,
                   help="ASes with bigger customer cones are never pinned (the core floats)")
    b.add_argument("--morph-km", type=float, default=250.0,
                   help="hybrid: how long a typical link of the cyber layout is once moved onto the map")
    b.add_argument("--no-prefixes", dest="prefixes", action="store_false",
                   help="omit per-AS prefix lists from info records")
    b.add_argument("--seed", type=int, default=7)
    b.add_argument("--synthetic-scale", type=float, default=1.0, help="peering density for synthetic")
    b.set_defaults(fn=cmd_build)

    r = sub.add_parser("build-itdk", help="router-level map from CAIDA ITDK traceroute topology")
    r.add_argument("--name", default="routers", help="bundle id (directory name)")
    r.add_argument("--out", default=str(DEFAULT_OUT))
    r.add_argument("--release", help="ITDK release YYYY-MM (default latest)")
    r.add_argument("--min-routers", type=int, default=5,
                   help="drop (AS, city) PoPs with fewer geolocated routers")
    r.add_argument("--date", help="CAIDA AS relationships snapshot YYYYMMDD (default latest)")
    r.add_argument("--cyber", default="opte", choices=["opte", "lgl", "lgl-igraph", "drl", "fr"])
    r.add_argument("--morph-km", type=float, default=250.0,
                   help="hybrid: how long a typical link of the cyber layout is once moved onto the map")
    r.add_argument("--seed", type=int, default=7)
    r.set_defaults(fn=cmd_build_itdk)

    t = sub.add_parser("tiles", help="pre-render raster XYZ tiles for a bundle")
    t.add_argument("bundle")
    t.add_argument("--modes", default="cyber,hybrid,geo")
    t.add_argument("--maxzoom", type=int, default=5)
    t.add_argument("--workers", type=int, default=0, help="processes (default: all cores)")
    t.add_argument("--format", default="png", choices=["png", "webp"],
                   help="webp is ~3x smaller (lossy q80); png is lossless")
    t.add_argument("--backbone", action="store_true",
                   help="draw only backbone links (tiles/backbone/<mode>/...)")
    t.set_defaults(fn=cmd_tiles)

    s = sub.add_parser("serve-tiles", help="render tiles on demand (any zoom), with a disk cache")
    s.add_argument("bundle")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--tile-cache", help="tile cache dir (default <bundle>/tiles)")
    s.set_defaults(fn=cmd_serve_tiles)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
