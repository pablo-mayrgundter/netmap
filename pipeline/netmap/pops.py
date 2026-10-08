"""Points of presence: floating ASes split into their cities.

A global transit network is not "at" one place, so the hybrid layout leaves
it floating between the things it connects. On a map that reads as stubs
reaching up to a dot over the Atlantic, with no city-to-city structure. This
module gives each floating AS a set of PoPs at the sites its address space
lives in (from the geo join), then:

* re-attaches each of its links to the PoP nearest the other end (for two
  PoP'd ASes, to the closest pair: where they would interconnect),
* adds intra-AS "core routes" between its PoPs: a minimum spanning tree over
  great-circle distance, which reads as the network's long-haul backbone.

With router-level data (traceroutes + hostname airport codes, see iata.py)
the PoPs would come from measured router locations instead of address space.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import minimum_spanning_tree

from .geo import haversine_km

MERGE_KM = 150.0  # sites closer than this collapse into one PoP
MIN_SHARE = 0.005  # ignore sites holding less of the AS's address space
MAX_POPS = 12


@dataclass
class Pops:
    node: np.ndarray  # int32 [P] owning node index, sorted
    lat: np.ndarray  # float64 [P]
    lon: np.ndarray
    share: np.ndarray  # float32 [P] share of the AS's addresses
    city: list[str]
    offset: np.ndarray  # int64 [N+1] CSR: pops of node i are offset[i]:offset[i+1]
    edge_pop: np.ndarray  # int32 [E, 2] PoP used by each link end, -1 = node itself
    routes: np.ndarray  # int32 [Q, 2] intra-AS core routes between PoPs

    @property
    def count(self) -> int:
        return len(self.node)


def cluster_sites(sites, merge_km=MERGE_KM, min_share=MIN_SHARE, max_pops=MAX_POPS):
    """Greedy merge of (lat, lon, share, city) sites, biggest first."""
    out: list[list] = []  # [lat, lon, share, city]
    for lat, lon, share, city in sorted(sites, key=lambda s: -s[2]):
        for p in out:
            if haversine_km(p[0], p[1], lat, lon) <= merge_km:
                p[2] += share
                break
        else:
            if share >= min_share and len(out) < max_pops:
                out.append([lat, lon, share, city])
    return out


def build(n: int, src, dst, candidates, sites_of, node_lat, node_lon) -> Pops:
    """PoPs for ``candidates`` (node indices), links re-attached, core routes.

    ``sites_of(i)`` returns node i's sites; ``node_lat/lon`` is where every
    node sits (used to pick the PoP facing a neighbour without PoPs).
    """
    src = np.asarray(src, np.int64)
    dst = np.asarray(dst, np.int64)
    rows = []
    for i in candidates:
        cl = cluster_sites(sites_of(int(i)))
        if len(cl) >= 2:
            rows.extend((int(i), *c) for c in cl)
    rows.sort(key=lambda r: r[0])
    node = np.array([r[0] for r in rows], np.int32)
    lat = np.array([r[1] for r in rows], np.float64)
    lon = np.array([r[2] for r in rows], np.float64)
    share = np.array([r[3] for r in rows], np.float32)
    city = [r[4] for r in rows]
    counts = np.bincount(node, minlength=n) if len(node) else np.zeros(n, np.int64)
    offset = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)

    # Padded [N_pop_nodes, K] tables of PoP unit vectors for vectorised
    # nearest-PoP lookups.
    K = int(counts.max()) if len(node) else 0
    slot = np.full((n, max(K, 1)), -1, np.int64)
    if len(node):
        rank_in_node = np.arange(len(node)) - offset[node]
        slot[node, rank_in_node] = np.arange(len(node))

    def unit(la, lo):
        la, lo = np.radians(la), np.radians(lo)
        return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)

    pv = unit(lat, lon) if len(node) else np.zeros((0, 3))
    nv = unit(np.asarray(node_lat), np.asarray(node_lon))
    has = counts > 0
    e = len(src)
    edge_pop = np.full((e, 2), -1, np.int32)

    def nearest(owner, target_vec):
        """For each row: the PoP of owner[row] closest to target_vec[row]."""
        s = slot[owner]  # [m, K]
        vec = np.where(s[..., None] >= 0, pv[np.maximum(s, 0)], np.nan)
        dot = np.einsum("mkd,md->mk", vec, target_vec)
        dot = np.where(s >= 0, dot, -2.0)
        return s[np.arange(len(owner)), np.argmax(dot, 1)]

    CH = 40_000  # bounds the [m, K, K] pair tables
    for c0 in range(0, e, CH):
        a, b = src[c0 : c0 + CH], dst[c0 : c0 + CH]
        ha, hb = has[a], has[b]
        # One side with PoPs: the PoP facing the other node.
        m = ha & ~hb
        edge_pop[c0 : c0 + CH][m, 0] = nearest(a[m], nv[b[m]])
        m = hb & ~ha
        edge_pop[c0 : c0 + CH][m, 1] = nearest(b[m], nv[a[m]])
        # Both: closest pair of PoPs (they interconnect where both are).
        m = np.flatnonzero(ha & hb)
        if len(m):
            sa, sb = slot[a[m]], slot[b[m]]
            va = np.where(sa[..., None] >= 0, pv[np.maximum(sa, 0)], 0.0)
            vb = np.where(sb[..., None] >= 0, pv[np.maximum(sb, 0)], 0.0)
            dot = np.einsum("mid,mjd->mij", va, vb)
            valid = (sa[:, :, None] >= 0) & (sb[:, None, :] >= 0)
            dot = np.where(valid, dot, -2.0).reshape(len(m), -1)
            best = np.argmax(dot, 1)
            i, j = best // sa.shape[1], best % sb.shape[1]
            edge_pop[c0 + m, 0] = sa[np.arange(len(m)), i]
            edge_pop[c0 + m, 1] = sb[np.arange(len(m)), j]

    # Core routes: MST over each AS's PoPs.
    routes = []
    for i in np.flatnonzero(has):
        ids = np.arange(offset[i], offset[i + 1])
        k = len(ids)
        d = haversine_km(lat[ids][:, None], lon[ids][:, None], lat[ids][None], lon[ids][None])
        d = np.maximum(d, 1e-3)  # MST ignores zero weights
        iu, ju = np.triu_indices(k, 1)
        mst = minimum_spanning_tree(coo_matrix((d[iu, ju], (iu, ju)), shape=(k, k))).tocoo()
        routes.extend(zip(ids[mst.row], ids[mst.col]))
    routes = np.array(routes, np.int32).reshape(-1, 2)
    return Pops(node, lat, lon, share, city, offset, edge_pop, routes)

