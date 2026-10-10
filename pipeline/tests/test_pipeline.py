import bz2
import gzip
import json

import igraph as ig
import numpy as np
import pytest

from netmap import asrel, export, geo, layout, metrics, tiles
from netmap.iata import Gazetteer, Place
from netmap.regions import REGIONS


def test_overlap_join():
    a_s = np.array([0, 100, 300], np.uint64)
    a_e = np.array([99, 199, 399], np.uint64)
    b_s = np.array([50, 150, 350], np.uint64)
    b_e = np.array([149, 349, 1000], np.uint64)
    ia, ib, w = geo.overlap_join(a_s, a_e, b_s, b_e)
    got = sorted(zip(ia.tolist(), ib.tolist(), w.tolist()))
    assert got == [(0, 0, 50.0), (1, 0, 50.0), (1, 1, 50.0), (2, 1, 50.0), (2, 2, 50.0)]


def test_range_to_cidrs():
    assert geo.range_to_cidrs(int(0x0A000000), int(0x0A0000FF)) == ["10.0.0.0/24"]
    assert geo.range_to_cidrs(int(0x0A000000), int(0x0A000180)) == ["10.0.0.0/24", "10.0.1.0/25", "10.0.1.128/32"]


def _prefix_and_geo():
    # AS 1: all in Paris; AS 2: half Paris, half Tokyo.
    pfx = geo.PrefixTable(
        start=np.array([0, 1000, 2000], np.uint64),
        end=np.array([999, 1999, 2999], np.uint64),
        asn=np.array([1, 2, 2], np.uint32),
        names={1: "One", 2: "Two"},
    )
    g = geo.GeoTable(
        start=np.array([0, 1500, 2000], np.uint64),
        end=np.array([1499, 1999, 2999], np.uint64),
        lat=np.array([48.85, 35.68, 35.68], np.float32),
        lon=np.array([2.35, 139.69, 139.69], np.float32),
        cc=np.array([0, 1, 1], np.int16),
        city=np.array([0, 1, 1], np.int32),
        countries=["FR", "JP"],
        cities=["Paris", "Tokyo"],
    )
    return pfx, g


def test_profile_ases():
    pfx, g = _prefix_and_geo()
    p = geo.profile_ases(pfx, g)
    ix = p.index()
    one, two = ix[1], ix[2]
    assert p.addrs[one] == 1000 and p.addrs[two] == 2000
    assert p.country[one] == "FR" and p.concentration[one] == pytest.approx(1.0)
    # AS 2 has 500 addrs in Paris and 1500 in Tokyo: Tokyo dominates.
    assert p.country[two] == "JP"
    assert p.lat[two] == pytest.approx(35.68, abs=0.01)
    assert p.concentration[two] == pytest.approx(0.75)
    assert p.sites[two][0][3] == "Tokyo"


def test_parse_asrel_and_as2org(tmp_path):
    rel = tmp_path / "20260101.as-rel2.txt.bz2"
    rel.write_bytes(bz2.compress(b"# comment\n1|2|-1|bgp\n2|3|0|mlp\n1|3|-1\n"))
    t = asrel.parse_asrel(rel)
    assert t.asns.tolist() == [1, 2, 3]
    assert t.e == 3 and t.rel.tolist() == [-1, 0, -1]

    org = tmp_path / "x.as-org2info.txt.gz"
    org.write_bytes(gzip.compress(
        b"# format:org_id|changed|org_name|country|source\nO1|x|Org One|US|ARIN\n"
        b"# format:aut|changed|aut_name|org_id|opaque_id|source\n1|x|ONE-AS|O1||ARIN\n"
    ))
    o = asrel.parse_as2org(org)
    assert o[1].org == "Org One" and o[1].country == "US" and o[1].name == "ONE-AS"


def test_mercator_roundtrip():
    lon = np.array([-170.0, 0.0, 151.2])
    lat = np.array([-60.0, 0.0, 70.5])
    x, y = layout.lonlat_to_merc(lon, lat)
    lo, la = layout.merc_to_lonlat(x, y)
    assert np.allclose(lo, lon) and np.allclose(la, lat)


def test_sunflower_separates_colocated():
    lat = np.full(20, 40.0)
    lon = np.full(20, -74.0)
    w = np.arange(20, dtype=float)
    lo, la = layout.sunflower(lon, lat, w, np.ones(20, bool))
    pts = np.stack([lo, la], 1)
    assert len({(round(a, 6), round(b, 6)) for a, b in pts}) == 20
    # Heaviest stays on the site.
    assert lo[19] == pytest.approx(-74.0) and la[19] == pytest.approx(40.0)


def _tiny_topology():
    # A star of 4 leaves around 0, plus a chain 0-5-6.
    edges = [(0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (5, 6)]
    t = asrel.Topology(
        asns=np.arange(100, 107, dtype=np.uint32),
        src=np.array([a for a, _ in edges], np.int32),
        dst=np.array([b for _, b in edges], np.int32),
        rel=np.array([-1, -1, -1, -1, 0, -1], np.int8),
    )
    return t


def test_metrics_cone_and_level():
    t = _tiny_topology()
    m = metrics.compute(t)
    assert m.cone[0] == 5  # itself + 4 customers (peer 5 not in cone)
    assert m.cone[5] == 2
    assert m.customers[0] == 4 and m.peers[0] == 1 and m.providers[1] == 1
    assert m.rank[0] == 1 and 0 <= m.level.min() and m.level.max() <= 1


def test_cyber_layout_in_mercator_square():
    g = ig.Graph.Barabasi(300, 2, directed=False)
    lo, la = layout.cyber(g, algo="fr")
    assert np.all(np.abs(lo) < 180) and np.all(np.abs(la) < 85.06)
    assert len(np.unique(np.round(lo, 4))) > 250


def _bundle(tmp_path):
    t = _tiny_topology()
    m = metrics.compute(t)
    g = metrics.graph_of(t)
    n = t.n
    cyber = layout.cyber(g)
    lat = np.linspace(-40, 40, n)
    lon = np.linspace(-100, 100, n)
    has_geo = np.ones(n, bool)
    has_geo[6] = False
    out = tmp_path / "b"
    export.write_bundle(
        out, name="tiny", topo=t, metrics=m, prof_rows=None,
        layouts={"cyber": cyber, "geo": (lon, lat), "hybrid": (lon, lat)},
        region_idx=np.arange(n) % len(REGIONS), has_geo=has_geo, pinned=has_geo,
        names=[f"AS{a}" for a in t.asns], info_records=[{"asn": int(a)} for a in t.asns],
        attribution=["test"],
    )
    return out, t


def test_bundle_roundtrip(tmp_path):
    out, t = _bundle(tmp_path)
    meta, a = export.read_bundle(out)
    assert meta["counts"]["nodes"] == 7 and meta["counts"]["p2p"] == 1
    assert a["asn"].tolist() == t.asns.tolist()
    assert a["edges"].shape == (6, 2) and a["edges"][5].tolist() == [5, 6]
    assert a["flags"][6] == 0 and a["flags"][0] == 3
    assert json.loads((out / "info" / "0.json").read_text())[3]["asn"] == 103


def test_tiles_render_and_pyramid(tmp_path):
    out, _ = _bundle(tmp_path)
    sc = tiles.Scene(out, "geo")
    assert len(sc.es) == 5  # edge 5-6 hidden: node 6 has no geo
    rgba = tiles.render(sc, 0, 0, 0)
    assert rgba.shape == (256, 256, 4) and rgba[..., 3].max() > 0
    n = tiles.pyramid(out, out / "tiles", "cyber", maxzoom=2)
    assert n >= 1 and (out / "tiles" / "cyber" / "0" / "0" / "0.png").exists()
    tj = json.loads((out / "tiles" / "cyber" / "tiles.json").read_text())
    assert tj["maxzoom"] == 2 and tj["count"] == n


def test_clip_segments():
    ok, x0, y0, x1, y1 = tiles._clip(
        np.array([-10.0, 5.0, -10.0]), np.array([5.0, 5.0, -10.0]),
        np.array([20.0, 6.0, -5.0]), np.array([5.0, 6.0, -5.0]), 0.0, 10.0,
    )
    assert ok.tolist() == [True, True, False]
    assert (x0[0], x1[0]) == (0.0, 10.0)


def test_iata_hints():
    gz = Gazetteer(
        {
            "dfw": Place("DFW", "Dallas", 32.9, -97.0),
            "ams": Place("AMS", "Amsterdam", 52.3, 4.8),
            "lhr": Place("LHR", "London", 51.5, -0.45),
            "net": Place("NET", "Nowhere", 0, 0),
        },
        {"frankfurt": Place("FRA", "Frankfurt", 50.0, 8.6)},
    )
    assert gz.locate("be3037.ccr21.dfw01.atlas.cogentco.com").code == "DFW"
    assert gz.locate("ae2.cs1.ams17.nl.eth.zayo.com").code == "AMS"
    assert gz.locate("ae-1-3502.edge4.Frankfurt1.Level3.net").name == "Frankfurt"
    assert gz.locate("lhr25s34-in-f14.1e100.net").code == "LHR"
    assert gz.locate("host-1-2-3-4.example.net") is None


def test_backbone_keeps_primary_provider_tree():
    t = _tiny_topology()
    m = metrics.compute(t)
    bb = layout.backbone(t.n, t.src, t.dst, t.rel, m.cone, m.level, core_level=2.0)
    got = sorted(tuple(sorted(e)) for e in bb.get_edgelist())
    # Every customer keeps its single provider; node 0 has no provider so its
    # peering link to 5 is kept too.
    assert got == [(0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (5, 6)]


def test_sample_rank_sweeps_from_tree_to_full():
    g = ig.Graph.Erdos_Renyi(200, m=800)
    g = g.connected_components().giant()
    el = np.asarray(g.get_edgelist())
    t = asrel.Topology(asns=np.arange(g.vcount(), dtype=np.uint32), src=el[:, 0].astype(np.int32),
                       dst=el[:, 1].astype(np.int32), rel=np.zeros(len(el), np.int8))
    r = metrics.sample_rank(t, trees=20)
    # First vantage point's tree spans the graph with exactly n-1 links.
    assert (r == 0).sum() == g.vcount() - 1
    counts = [(r <= k).sum() for k in range(20)]
    assert all(a <= b for a, b in zip(counts, counts[1:]))
    sub = ig.Graph(n=g.vcount(), edges=el[r == 0].tolist())
    assert sub.is_connected()


def test_pops_reattach_links_and_build_core_routes():
    from netmap import pops

    # Node 0: a transit network with sites in New York, London and Tokyo
    # (plus a suburb of London that should merge). Nodes 1-3 are pinned
    # customers in those cities; node 4 is another PoP'd network in London
    # and Tokyo.
    sites = {
        0: [(40.7, -74.0, 0.5, "New York"), (51.5, -0.1, 0.3, "London"),
            (51.6, -0.3, 0.05, "Watford"), (35.7, 139.7, 0.15, "Tokyo")],
        4: [(51.5, -0.1, 0.6, "London"), (35.7, 139.7, 0.4, "Tokyo")],
    }
    lat = np.array([20.0, 40.7, 51.5, 35.7, 45.0])
    lon = np.array([-30.0, -74.0, -0.1, 139.7, 60.0])
    src = np.array([0, 0, 0, 0])
    dst = np.array([1, 2, 3, 4])
    p = pops.build(5, src, dst, [0, 4], lambda i: sites.get(i, []), lat, lon)
    assert p.count == 5 and list(np.diff(p.offset)) == [3, 0, 0, 0, 2]
    city = lambda k: p.city[k]  # noqa: E731
    assert [city(p.edge_pop[k, 0]) for k in range(3)] == ["New York", "London", "Tokyo"]
    assert (p.edge_pop[:3, 1] == -1).all()
    # 0 and 4 interconnect where both are (London or Tokyo), not mid-ocean.
    assert city(p.edge_pop[3, 0]) == city(p.edge_pop[3, 1])
    # MST: 2 routes for node 0's three PoPs, 1 for node 4's two.
    assert len(p.routes) == 3
    assert all(p.node[a] == p.node[b] for a, b in p.routes)
    merged = [p.share[k] for k in range(3) if p.city[k] == "London"][0]
    assert merged == pytest.approx(0.35)


def test_native_lgl_deterministic_and_sane():
    from netmap import native

    try:
        native.load()
    except native.NativeUnavailable:
        pytest.skip("no C compiler")
    import random

    random.seed(1)
    g = ig.Graph.Tree(3000, 3)  # a tree with some shortcuts, like the AS backbone
    g.add_edges([(random.randrange(3000), random.randrange(3000)) for _ in range(150)])
    el = np.asarray(g.get_edgelist(), np.int32)
    a = native.lgl(g.vcount(), el[:, 0], el[:, 1], root=0, seed=3, threads=1)
    b = native.lgl(g.vcount(), el[:, 0], el[:, 1], root=0, seed=3, threads=4)
    assert np.isfinite(a).all() and np.array_equal(a, b)

    # Quality on par with igraph's LGL: mean link length relative to the
    # mean distance between random pairs (lower = tighter neighbourhoods).
    def ratio(xy):
        d_edge = np.hypot(*(xy[el[:, 0]] - xy[el[:, 1]]).T).mean()
        i, j = np.random.default_rng(0).integers(0, g.vcount(), (2, 5000))
        return d_edge / np.hypot(*(xy[i] - xy[j]).T).mean()

    ref = np.asarray(g.layout_lgl(root=0).coords)
    assert ratio(a) < 1.25 * ratio(ref)
    # Disconnected input is laid out rather than rejected.
    c = native.lgl(4, np.array([0, 2], np.int32), np.array([1, 3], np.int32), root=0)
    assert np.isfinite(c).all()


def hub_and_spoke_graph(hubs=12, spokes=40, seed=0):
    """A ring of hubs plus a few chords, each hub with its own spokes (leaves)."""
    rng = np.random.default_rng(seed)
    edges = [(h, (h + 1) % hubs) for h in range(hubs)]
    edges += [tuple(rng.choice(hubs, 2, replace=False)) for _ in range(hubs // 3)]
    n = hubs
    for h in range(hubs):
        for _ in range(spokes):
            edges.append((h, n))
            n += 1
    el = np.asarray(edges, np.int32)
    return n, el


def spoke_quality(xy, n, el, hubs):
    """(evenness, ownership): how evenly each hub's spokes surround it (1 =
    perfectly, 0 = all on one side) and the share of spokes nearer their own
    hub than any other hub."""
    owner = np.full(n, -1)
    owner[el[el[:, 0] < hubs][:, 1]] = el[el[:, 0] < hubs][:, 0]
    leaf = owner >= 0
    leaf[:hubs] = False
    even = []
    for h in range(hubs):
        v = xy[leaf & (owner == h)] - xy[h]
        u = v / np.maximum(np.hypot(*v.T), 1e-12)[:, None]
        even.append(1 - np.hypot(*u.mean(0)))
    d = np.hypot(xy[leaf, None, 0] - xy[None, :hubs, 0], xy[leaf, None, 1] - xy[None, :hubs, 1])
    own = np.mean(d.argmin(1) == owner[leaf])
    return float(np.mean(even)), float(own)


def test_native_lgl_opte_hub_and_spoke():
    """A hub-and-spoke topology must render as hub and spoke: each hub's
    spokes all around it, nearer to it than to other hubs."""
    from netmap import native

    try:
        native.load()
    except native.NativeUnavailable:
        pytest.skip("no C compiler")
    hubs = 12
    n, el = hub_and_spoke_graph(hubs)
    a, lev = native.lgl_opte(n, el[:, 0], el[:, 1], seed=3, threads=1, return_levels=True)
    b = native.lgl_opte(n, el[:, 0], el[:, 1], seed=3, threads=4)
    assert np.isfinite(a).all() and np.array_equal(a, b)  # same for any thread count
    assert lev.min() == 0 and lev.max() >= 2
    even, own = spoke_quality(a, n, el, hubs)
    assert even > 0.85 and own > 0.9, (even, own)
    # Default lglayout mode (all edges, no leaves-close) still lays it out.
    c = native.lgl_opte(n, el[:, 0], el[:, 1], tree_only=False, leaves_close=False, seed=3)
    assert np.isfinite(c).all()
    # Disconnected input: one tree per component, nothing rejected.
    d = native.lgl_opte(4, np.array([0, 2], np.int32), np.array([1, 3], np.int32))
    assert np.isfinite(d).all()


def test_native_sample_rank_bfs_and_dijkstra():
    from netmap import native

    try:
        native.load()
    except native.NativeUnavailable:
        pytest.skip("no C compiler")
    g = ig.Graph.Erdos_Renyi(400, m=1600, directed=False).connected_components().giant()
    el = np.asarray(g.get_edgelist(), np.int32)
    roots = np.random.default_rng(1).permutation(g.vcount())[:50]
    r1 = native.sample_rank(g.vcount(), el[:, 0], el[:, 1], roots, threads=1)
    r4 = native.sample_rank(g.vcount(), el[:, 0], el[:, 1], roots, threads=4)
    assert np.array_equal(r1, r4)
    assert (r1 == 0).sum() == g.vcount() - 1  # one spanning tree
    # Dijkstra: an edge that's far heavier than any detour is never sampled.
    w = np.ones(len(el), np.float32)
    w[0] = 1e6
    rd = native.sample_rank(g.vcount(), el[:, 0], el[:, 1], roots, weights=w)
    assert rd[0] == len(roots)
    # Unit weights: every tree is still a spanning tree.
    ru = native.sample_rank(g.vcount(), el[:, 0], el[:, 1], roots, weights=np.ones(len(el)))
    assert (ru == 0).sum() == g.vcount() - 1


def test_tile_pool_matches_single_process(tmp_path):
    out, _ = _bundle(tmp_path)
    n1 = tiles.pyramid(out, tmp_path / "t1", "hybrid", maxzoom=4, workers=1)
    n2 = tiles.pyramid(out, tmp_path / "t2", "hybrid", maxzoom=4, workers=3)
    assert n1 == n2 > 1
    f1 = sorted(p.relative_to(tmp_path / "t1") for p in (tmp_path / "t1").rglob("*.png"))
    f2 = sorted(p.relative_to(tmp_path / "t2") for p in (tmp_path / "t2").rglob("*.png"))
    assert f1 == f2
    assert all((tmp_path / "t1" / f).read_bytes() == (tmp_path / "t2" / f).read_bytes() for f in f1)


def test_itdk_aggregate_to_pops(tmp_path):
    pytest.importorskip("pandas")
    from netmap import itdk

    def bz(name, text):
        p = tmp_path / name
        p.write_bytes(bz2.compress(text.encode()))
        return p

    # AS 10 has routers in Paris (N1, N2) and London (N3); AS 20 in London (N4).
    files = {
        "nodes.as": bz("as.bz2", "# c\nnode.AS\tN1\t10\torigins\nnode.AS\tN2\t10\torigins\n"
                       "node.AS\tN3\t10\trefinement\nnode.AS\tN4\t20\tlasthop\nnode.AS\tN5\t-1\tunknown\n"),
        "nodes.geo": bz("geo.bz2", "# c\n"
                        "node.geo N1:\tEU\tFR\tIDF\tParis\t48.85\t2.35\t\t\thoiho\n"
                        "node.geo N2:\tEU\tFR\tIDF\tParis\t48.86\t2.34\t\t\thoiho\n"
                        "node.geo N3:\tEU\tGB\tENG\tLondon\t51.50\t-0.12\t\t\tmaxmind\n"
                        "node.geo N4:\tEU\tGB\tENG\tLondon\t51.51\t-0.13\t\t\tix\n"),
        "links": bz("links.bz2", "# c\n"
                    "link L1:  N1:1.1.1.1 N3:1.1.1.2\n"      # AS10 Paris-London (backbone)
                    "link L2:  N2 N3\n"                       # again: weight 2
                    "link L3:  N3:2.2.2.1 N4:2.2.2.2 N5\n"   # AS10-AS20 London; N5 has no PoP
                    "link L4:  N1 N2\n"),                     # inside the Paris PoP: dropped
    }
    agg = itdk.aggregate(files, tmp_path / "cache")
    assert len(agg["pop_asn"]) == 3 and sorted(agg["routers"].tolist()) == [1, 1, 2]
    lab = {i: (int(agg["pop_asn"][i]), str(agg["places"][agg["pop_place"][i]]).split("|")[-1])
           for i in range(3)}
    links = {tuple(sorted((lab[s], lab[d]))): int(w) for s, d, w in zip(agg["src"], agg["dst"], agg["weight"])}
    assert links == {((10, "London"), (10, "Paris")): 2, ((10, "London"), (20, "London")): 1}
    # cached on second call
    assert (tmp_path / "cache" / "pops.npz").exists()
    p = itdk.prune(agg, min_routers=2)
    assert len(p["pop_asn"]) == 0  # the only 2-router PoP has no remaining links
    mask = itdk.max_spanning_forest(3, agg["src"], agg["dst"], agg["weight"])
    assert mask.all()  # a tree already


def test_ip2asn_boundaries_and_file(tmp_path):
    """The viewer's IP->AS table: gaps are AS 0, nested ranges keep the outer
    one, neighbours of the same AS merge, and the file round-trips."""
    import gzip

    from netmap import lookups
    from netmap.geo import PrefixTable

    pfx = PrefixTable(
        np.array([100, 200, 210, 300, 400], np.uint32),
        np.array([199, 299, 220, 349, 499], np.uint32),
        np.array([7, 7, 9, 8, 7], np.uint32),
        {},
    )
    st, an = lookups.ip2asn_boundaries(pfx)
    look = lambda ip: lookups.lookup(st, an, ip)  # noqa: E731
    assert [look(ip) for ip in (0, 99, 100, 250, 215, 299, 300, 349, 350, 450, 500, 2**32 - 1)] == [
        0, 0, 7, 7, 7, 7, 8, 8, 0, 7, 0, 0,
    ]
    assert list(an[:3]) == [0, 7, 8]  # 100-299 is one run of AS 7
    path = tmp_path / "ip2asn.bin.gz"
    n = lookups.write_ip2asn(path, pfx)
    raw = gzip.decompress(path.read_bytes())
    assert raw[:4] == b"NMIP" and int.from_bytes(raw[8:12], "little") == n == len(st)
    assert np.array_equal(np.frombuffer(raw, "<u4", n, 12), st)
    assert np.array_equal(np.frombuffer(raw, "<u4", n, 12 + 4 * n), an)


def test_hybrid_grows_opte_families_around_pins():
    """Hybrid pins the hubs to their cities and lets LGL place the rest: the
    pins stay put and each hub's spokes come out as an Opte star around it,
    nearer to it than to any other hub, a few hundred km across."""
    from netmap import native

    try:
        native.load()
    except native.NativeUnavailable:
        pytest.skip("no C compiler")
    hubs, spokes = 8, 30
    n, el = hub_and_spoke_graph(hubs, spokes)
    rng = np.random.default_rng(1)
    glon = np.r_[rng.uniform(-150, 150, hubs), np.zeros(n - hubs)]
    glat = np.r_[rng.uniform(-50, 60, hubs), np.zeros(n - hubs)]
    pins = np.arange(n) < hubs
    lon, lat = layout.hybrid(n, el[:, 0], el[:, 1], (glon, glat), pins, located=pins, km=100)
    assert np.allclose(lon[:hubs], glon[:hubs], atol=1e-4) and np.allclose(lat[:hubs], glat[:hubs], atol=1e-4)
    x, y = layout.lonlat_to_merc(lon, lat)
    even, own = spoke_quality(np.stack([x, y], 1), n, el, hubs)
    assert even > 0.6 and own > 0.95, (even, own)
    owner = np.full(n, -1)
    owner[el[el[:, 0] < hubs][:, 1]] = el[el[:, 0] < hubs][:, 0]
    leaf = np.arange(n) >= hubs
    km = 111 * np.hypot((lon[leaf] - glon[owner[leaf]]) * np.cos(np.radians(glat[owner[leaf]])),
                        lat[leaf] - glat[owner[leaf]])
    assert 20 < np.median(km) < 500, np.median(km)
