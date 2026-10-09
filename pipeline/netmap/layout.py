"""The three layouts. All are returned as (lon, lat) degrees so that every mode
lives in the same Web Mercator world: same tiles, same zoom levels, same
basemaps (the cyber layout simply ignores the basemap).

* cyber:  Large Graph Layout (Adai et al. 2004, via igraph) or DrL, scaled
          into the Mercator square.
* geo:    every geolocated AS at its dominant site; co-located ASes are fanned
          out on a sunflower spiral (largest in the middle) so they separate
          as you zoom in.
* hybrid: ASes whose address space is concentrated in one metro are pinned at
          their site; everything else (global transit, CDNs, national
          backbones, ASes without geo) is placed by the graph: a harmonic
          (Tutte) embedding against the pinned nodes, then a short
          Fruchterman-Reingold relaxation with pinned nodes held fixed.
"""

from __future__ import annotations

import math
import random
import sys
import time

import igraph as ig
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

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


# --- morph: cyber -> geo ----------------------------------------------------

def morph(n: int, src, dst, cyber_ll, geo_ll, pin_w, stops: int = 9, km: float = 250.0,
          lam_mid: float = 0.1) -> list[tuple[np.ndarray, np.ndarray]]:
    """Layouts from cyber (stop 0) to geo (the last stop), deforming the cyber
    layout rather than rebuilding from geography, so local structure (a hub
    and its spokes) survives as it moves next to its points of presence.

    Each stop solves a least-squares (Laplacian) deformation over the layout
    graph's links (src, dst):

        min  sum_ij w_ij |(x_i - x_j) - s (c_i - c_j)|^2 + lam sum_i pin_i |x_i - g_i|^2

    c is the cyber layout, g the geo one, pin_i in [0, 1] how much a node's
    geolocation is trusted. Along the way the cyber shape shrinks (s goes
    from 1 to a scale where a typical link is ``km`` long) and the geo pins
    strengthen (lam_mid at the halfway stop, the hybrid); links between hubs
    loosen first, so the backbone stretches across geography while small
    families keep their form. Returns (lon, lat) per stop.
    """
    t0 = time.time()
    C = np.stack(lonlat_to_merc(*cyber_ll), 1).astype(np.float64)
    Gm = np.stack(lonlat_to_merc(*geo_ll), 1).astype(np.float64)
    src = np.asarray(src, np.int64)
    dst = np.asarray(dst, np.int64)
    pin = np.clip(np.asarray(pin_w, np.float64), 0, 1)
    deg = np.bincount(np.concatenate([src, dst]), minlength=n)
    family = np.minimum(deg[src], deg[dst]) <= 2  # a link inside a small family
    el = np.hypot(*(C[src] - C[dst]).T)
    s_min = (km / 40075.0) / max(float(np.median(el[el > 0])) if (el > 0).any() else 1.0, 1e-12)
    out = [tuple(cyber_ll)]
    prev = C
    for k in range(1, stops - 1):
        t = k / (stops - 1)
        u = min(1.0, t / 0.5)
        s = float(np.exp(np.log(s_min) * u))  # 1 -> s_min by the halfway stop
        lam = lam_mid * (t / (1 - t)) ** 2  # lam_mid at the halfway stop
        w = np.where(family, 1.0, 1.0 + (0.02 - 1.0) * u)
        A = sp.coo_matrix((w, (src, dst)), shape=(n, n))
        A = (A + A.T).tocsr()
        Lap = (sp.diags(np.asarray(A.sum(1)).ravel()) - A).tocsr()
        pw = lam * pin + 1e-6  # a whisper of anchoring keeps islands well-posed
        anchor = np.where(pin[:, None] > 0, Gm, 0.5 + (C - 0.5) * s)
        M = (Lap + sp.diags(pw)).tocsr()
        X = np.empty_like(C)
        for d in range(2):
            b = s * (Lap @ C[:, d]) + pw * anchor[:, d]
            X[:, d], _ = spla.cg(M, b, x0=prev[:, d], rtol=1e-8, maxiter=3000)
        X = np.clip(X, 0.001, 0.999)
        out.append(merc_to_lonlat(X[:, 0], X[:, 1]))
        prev = X
    # the last stop is geo; nodes without a location stay where the previous stop put them
    glon, glat = (np.asarray(v, np.float64).copy() for v in geo_ll)
    plon, plat = out[-1]
    nogeo = pin <= 0
    glon[nogeo], glat[nogeo] = np.asarray(plon)[nogeo], np.asarray(plat)[nogeo]
    out.append((glon, glat))
    _log(f"cyber->geo morph, {stops} stops (pinned {int((pin > 0).sum())}, typical link {km:.0f} km at hybrid)", t0)
    return out


