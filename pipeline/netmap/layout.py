"""The three layouts. All are returned as (lon, lat) degrees so that every mode
lives in the same Web Mercator world: same tiles, same zoom levels, same
basemaps (the cyber layout simply ignores the basemap).

* cyber:  Large Graph Layout (Adai et al. 2004, via igraph) or DrL, scaled
          into the Mercator square.
* geo:    every geolocated AS at its dominant site; co-located ASes are fanned
          out on a sunflower spiral (largest in the middle) so they separate
          as you zoom in.
* hybrid: well-connected networks with a firm location are pinned at their
          site, then Opte LGL lays out everything else around them, so the
          free subtrees keep the cyber look (hub and spoke) next to their
          pins. The viewer's cyber -> geo slider blends cyber, hybrid, geo.
"""

from __future__ import annotations

import math
import random
import sys
import time

import igraph as ig
import numpy as np

from . import native

MAX_LAT = 85.05112878
GOLDEN = math.pi * (3 - math.sqrt(5))


# --- Web Mercator helpers (unit square, y down like XYZ tiles) -------------

def lonlat_to_merc(lon, lat):
    lat = np.clip(lat, -MAX_LAT, MAX_LAT)
    x = (np.asarray(lon) + 180.0) / 360.0
    s = np.sin(np.radians(lat))
    y = 0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)
    return x, y


def merc_to_lonlat(x, y):
    lon = np.asarray(x) * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * np.asarray(y)))))
    return lon, lat


def _log(msg: str, t0: float):
    print(f"  {msg} ({time.time() - t0:.1f}s)", file=sys.stderr)


# --- cyber -----------------------------------------------------------------

def backbone_mask(n: int, src, dst, rel, cone, level, core_level: float = 0.75) -> np.ndarray:
    """Which links form the backbone: each AS's primary (largest-cone)
    provider link, the mesh among core ASes, and the links of ASes that have
    no provider at all.

    That's roughly one link per AS, like the traceroute-derived trees in the
    Opte maps. LGL lays out this graph (the full AS graph gives a featureless
    ball: multihoming and IXP peering tie everything to everything), and the
    viewer can draw only these links.
    """
    src = np.asarray(src, np.int64)
    dst = np.asarray(dst, np.int64)
    p2c = np.asarray(rel) == -1
    eid = np.flatnonzero(p2c)
    prov, cust = src[p2c], dst[p2c]
    order = np.lexsort((-np.asarray(cone)[prov], cust))
    first = np.ones(len(order), bool)
    first[1:] = cust[order][1:] != cust[order][:-1]
    mask = np.zeros(len(src), bool)
    mask[eid[order][first]] = True
    lv = np.asarray(level)
    mask |= (lv[src] > core_level) & (lv[dst] > core_level)
    orphan = np.ones(n, bool)
    orphan[cust] = False
    mask |= orphan[src] | orphan[dst]
    return mask


def backbone(n: int, src, dst, rel, cone, level, core_level: float = 0.75) -> ig.Graph:
    """The backbone (see backbone_mask) as a graph, for layout."""
    m = backbone_mask(n, src, dst, rel, cone, level, core_level)
    e = np.stack([np.asarray(src)[m], np.asarray(dst)[m]], 1)
    return ig.Graph(n=n, edges=e.tolist())


def cyber(g: ig.Graph, algo: str = "opte", seed: int = 1, root: int | None = None,
          margin: float = 0.06) -> tuple[np.ndarray, np.ndarray]:
    """Graph-only layout mapped into the Mercator square."""
    t0 = time.time()
    n = g.vcount()
    xy = np.zeros((n, 2))
    comps = g.connected_components()
    sizes = np.array([len(c) for c in comps])
    order = np.argsort(-sizes)
    giant = comps[int(order[0])]
    sub = g.induced_subgraph(giant)
    rng = np.random.default_rng(seed)
    random.seed(seed)  # igraph draws from Python's RNG: keep layouts reproducible
    r = int(np.argmax(sub.degree())) if root is None else root
    pts = None
    if algo == "opte":
        # Opte-style LGL (netmap/native/lgl_opte.c, a port of lglayout): the
        # spanning tree laid out level by level, leaf families as stars.
        try:
            el = np.asarray(sub.get_edgelist(), np.int32).reshape(-1, 2)
            pts = native.lgl_opte(sub.vcount(), el[:, 0], el[:, 1], root=-1 if root is None else root,
                                  seed=seed)
        except native.NativeUnavailable as exc:
            print(f"  native LGL unavailable ({exc}); using igraph", file=sys.stderr)
            algo = "lgl-igraph"
    if algo == "lgl":
        # Native parallel LGL (netmap/native/lgl.c); igraph's if no compiler.
        try:
            el = np.asarray(sub.get_edgelist(), np.int32).reshape(-1, 2)
            pts = native.lgl(sub.vcount(), el[:, 0], el[:, 1], root=r, seed=seed)
        except native.NativeUnavailable as exc:
            print(f"  native LGL unavailable ({exc}); using igraph", file=sys.stderr)
            algo = "lgl-igraph"
    if algo == "lgl-igraph":
        pts = np.asarray(sub.layout_lgl(maxiter=150, root=r).coords, np.float64)
    elif algo == "drl":
        pts = np.asarray(sub.layout_drl().coords, np.float64)
    elif algo == "fr":
        pts = np.asarray(sub.layout_fruchterman_reingold(niter=500, grid=True).coords, np.float64)
    elif pts is None:
        raise ValueError(algo)
    pts -= np.median(pts, axis=0)
    rad = np.quantile(np.hypot(pts[:, 0], pts[:, 1]), 0.995) or 1.0
    pts /= rad
    xy[giant] = pts
    _log(f"cyber layout ({algo}) of giant component {len(giant)}/{n}", t0)

    # Small components on an outer ring.
    rest = [comps[int(i)] for i in order[1:]]
    for k, comp in enumerate(rest):
        ang = k * GOLDEN
        rr = 1.08 + 0.04 * rng.random()
        cx, cy = rr * math.cos(ang), rr * math.sin(ang)
        m = len(comp)
        if m == 1:
            xy[comp] = (cx, cy)
        else:
            sl = g.induced_subgraph(comp).layout_fruchterman_reingold(niter=200)
            p = np.asarray(sl.coords)
            p -= p.mean(0)
            p /= max(np.abs(p).max(), 1e-9)
            xy[comp] = np.array([cx, cy]) + p * 0.01 * math.sqrt(m)

    # Fit into the Mercator square, softly compressing far-flung tree tips
    # so they don't shrink everything else.
    r = np.hypot(xy[:, 0], xy[:, 1])
    knee = 0.85
    big = r > knee
    r2 = r.copy()
    r2[big] = knee + (1 - knee) * np.tanh((r[big] - knee) / (1 - knee))
    xy *= np.where(r > 0, r2 / np.maximum(r, 1e-12), 1)[:, None]
    mx = 0.5 + xy[:, 0] * (0.5 - margin)
    my = 0.5 + xy[:, 1] * (0.5 - margin)
    return merc_to_lonlat(mx, my)


# --- geo -------------------------------------------------------------------

def sunflower(lon, lat, weight, valid, spacing_m: float = 900.0):
    """Fan out co-located points on a sunflower spiral around their site."""
    out_lon = lon.astype(np.float64).copy()
    out_lat = lat.astype(np.float64).copy()
    key = np.round(lat * 50).astype(np.int64) * 100000 + np.round(lon * 50).astype(np.int64)
    idx = np.flatnonzero(valid)
    order = idx[np.lexsort((-weight[idx], key[idx]))]
    ks = key[order]
    starts = np.r_[0, np.flatnonzero(np.diff(ks)) + 1]
    rank = np.arange(len(order)) - np.repeat(starts, np.diff(np.r_[starts, len(order)]))
    r_m = spacing_m * np.sqrt(rank)
    th = rank * GOLDEN
    dlat = (r_m * np.sin(th)) / 111320.0
    coslat = np.cos(np.radians(np.clip(lat[order], -80, 80)))
    dlon = (r_m * np.cos(th)) / (111320.0 * coslat)
    out_lat[order] += dlat
    out_lon[order] += dlon
    return out_lon, np.clip(out_lat, -MAX_LAT + 0.1, MAX_LAT - 0.1)


def geo(lat, lon, has_geo, weight):
    return sunflower(lon, lat, weight, has_geo)


# --- hybrid: pins, then LGL -------------------------------------------------

def hybrid(n: int, src, dst, geo_ll, pins, located=None, km: float = 100.0,
           seed: int = 1) -> tuple[np.ndarray, np.ndarray]:
    """Pin some geolocated networks to the map, then let Opte LGL grow and
    relax everything else around them (netmap/native/lgl_opte.c with pins),
    so the layout graph's free subtrees come out as Opte families (a hub's
    spokes all around it) next to the pins they hang from.

    ``pins``: bool [n]; ``located``: which geo_ll are real (default all).
    ``km``: the length of one LGL unit on the map (links
    rest at half a unit, neighbours repel within one). A tree of the layout
    graph without any pin keeps its best-connected geolocated node as one.
    """
    t0 = time.time()
    src = np.asarray(src, np.int64)
    dst = np.asarray(dst, np.int64)
    G = np.stack(lonlat_to_merc(*geo_ll), 1).astype(np.float64)
    has = np.isfinite(G).all(1) & (True if located is None else np.asarray(located, bool))
    pins = np.asarray(pins, bool) & has
    g = ig.Graph(n=n, edges=np.stack([src, dst], 1).tolist())
    deg = np.asarray(g.degree())
    extra = 0
    for comp in g.connected_components():
        c = np.asarray(comp)
        if pins[c].any() or not has[c].any():
            continue
        cand = c[has[c]]
        pins[cand[np.argmax(deg[cand])]] = True
        extra += 1
    u = 40075.0 / km  # LGL units per Mercator unit
    xy = native.lgl_opte(n, src, dst, pins=pins, pin_xy=np.where(has[:, None], G, 0.5) * u, seed=seed) / u
    xy = np.clip(xy, 0.001, 0.999)
    _log(f"hybrid: {int(pins.sum())} pinned ({extra} for trees without one), LGL on the rest, {km:.0f} km/unit", t0)
    return merc_to_lonlat(xy[:, 0], xy[:, 1])
