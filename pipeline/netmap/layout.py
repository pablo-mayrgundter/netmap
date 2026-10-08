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

def cyber(g: ig.Graph, algo: str = "lgl", seed: int = 1, root: int | None = None,
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
    if algo == "lgl":
        r = int(np.argmax(sub.degree())) if root is None else root
        lay = sub.layout_lgl(maxiter=150, root=r)
    elif algo == "drl":
        lay = sub.layout_drl()
    elif algo == "fr":
        lay = sub.layout_fruchterman_reingold(niter=500, grid=True)
    else:
        raise ValueError(algo)
    pts = np.asarray(lay.coords, np.float64)
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

    # Fit into the Mercator square.
    xy /= max(np.abs(xy).max(), 1e-9)
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


# --- hybrid ----------------------------------------------------------------

def hybrid(g: ig.Graph, lat, lon, pinned, cyber_lonlat, fr_iters: int = 0,
           local_shape: float = 0.25, world_units: float = 20000.0, seed: int = 1):
    """Pinned nodes at (lon, lat); the rest by harmonic embedding.

    Free nodes that share neighbourhoods would land on the same point, so each
    is offset by ``local_shape`` times its displacement from its neighbours'
    centroid in the cyber layout: the LGL's local structure, transplanted.
    ``fr_iters`` > 0 adds a (slow, igraph) Fruchterman-Reingold relaxation.
    """
    t0 = time.time()
    n = g.vcount()
    px, py = lonlat_to_merc(lon, lat)
    cx, cy = lonlat_to_merc(*cyber_lonlat)
    el = np.asarray(g.get_edgelist(), np.int64)
    A = sp.coo_matrix((np.ones(len(el)), (el[:, 0], el[:, 1])), shape=(n, n))
    A = (A + A.T).tocsr()
    A.data[:] = 1.0
    deg = np.asarray(A.sum(1)).ravel()

    U = np.flatnonzero(~pinned)
    P = np.flatnonzero(pinned)
    x = np.where(pinned, px, 0.0)
    y = np.where(pinned, py, 0.0)
    if len(U):
        # (D_uu - A_uu + eps) x_u = A_up x_p + eps * x_cyber
        # eps keeps islands with no pinned neighbour well-posed: they settle
        # near the middle of the world, keeping their cyber shape.
        eps = 1e-3
        Auu = A[U][:, U]
        Aup = A[U][:, P]
        L = sp.diags(deg[U] + eps) - Auu
        # Islands relax to a scaled copy of their cyber position around the
        # centre of the map.
        fx = 0.5 + (cx[U] - 0.5) * 0.35
        fy = 0.5 + (cy[U] - 0.5) * 0.35
        bx = Aup @ px[P] + eps * fx
        by = Aup @ py[P] + eps * fy
        x[U], _ = spla.cg(L, bx, x0=fx, rtol=1e-8, maxiter=2000)
        y[U], _ = spla.cg(L, by, x0=fy, rtol=1e-8, maxiter=2000)
    _log(f"hybrid harmonic embedding ({len(P)} pinned, {len(U)} free)", t0)

    if local_shape > 0 and len(U):
        with np.errstate(invalid="ignore", divide="ignore"):
            mcx = np.asarray(A @ cx).ravel() / deg
            mcy = np.asarray(A @ cy).ravel() / deg
        dx = np.nan_to_num(cx - mcx)[U]
        dy = np.nan_to_num(cy - mcy)[U]
        x[U] += local_shape * dx
        y[U] += local_shape * dy

    if fr_iters > 0 and len(U):
        # Relax: separate stacked leaves, keep pinned nodes fixed.
        rng = np.random.default_rng(seed)
        X = np.stack([x, y], 1) * world_units
        X[U] += rng.normal(0, 0.5, (len(U), 2))
        minx = X[:, 0].copy()
        maxx = X[:, 0].copy()
        miny = X[:, 1].copy()
        maxy = X[:, 1].copy()
        big = world_units * 2
        minx[U], maxx[U], miny[U], maxy[U] = -big, big, -big, big
        lay = g.layout_fruchterman_reingold(
            seed=X.tolist(), niter=fr_iters, start_temp=world_units * 0.002,
            minx=minx.tolist(), maxx=maxx.tolist(), miny=miny.tolist(), maxy=maxy.tolist(),
            grid=True,
        )
        X2 = np.asarray(lay.coords) / world_units
        x[U], y[U] = X2[U, 0], X2[U, 1]
        _log("hybrid FR relaxation", t0)

    x = np.clip(x, 0.001, 0.999)
    y = np.clip(y, 0.001, 0.999)
    return merc_to_lonlat(x, y)
