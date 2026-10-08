"""Graph metrics that drive size, colour and (in 3D) altitude."""

from __future__ import annotations

from dataclasses import dataclass

import igraph as ig
import numpy as np

from .asrel import P2C, Topology


@dataclass
class Metrics:
    degree: np.ndarray  # int32
    providers: np.ndarray  # int32
    customers: np.ndarray  # int32
    peers: np.ndarray  # int32
    cone: np.ndarray  # int32 customer cone size (incl. self)
    coreness: np.ndarray  # int32 k-core number
    rank: np.ndarray  # int32 1 = largest cone
    level: np.ndarray  # float32 0 (edge) .. 1 (core): hierarchy for altitude


def graph_of(topo: Topology) -> ig.Graph:
    return ig.Graph(n=topo.n, edges=np.stack([topo.src, topo.dst], 1).tolist(), directed=False)


def compute(topo: Topology, g: ig.Graph | None = None) -> Metrics:
    n = topo.n
    g = g or graph_of(topo)
    deg = np.asarray(g.degree(), np.int32)
    p2c = topo.rel == P2C
    customers = np.bincount(topo.src[p2c], minlength=n).astype(np.int32)
    providers = np.bincount(topo.dst[p2c], minlength=n).astype(np.int32)
    peers = deg - customers - providers

    # Customer cone: everything reachable following provider->customer edges.
    dag = ig.Graph(n=n, edges=np.stack([topo.src[p2c], topo.dst[p2c]], 1).tolist(), directed=True)
    cone = np.ones(n, np.int32)
    has_cust = np.flatnonzero(customers > 0)
    if len(has_cust):
        sizes = dag.neighborhood_size(vertices=has_cust.tolist(), order=n, mode="out")
        cone[has_cust] = sizes

    coreness = np.asarray(g.coreness(), np.int32)
    order = np.lexsort((-deg, -cone))
    rank = np.empty(n, np.int32)
    rank[order] = np.arange(1, n + 1)

    # Hierarchy level: blend of log cone size and coreness, normalised.
    lc = np.log1p(cone - 1)
    lc = lc / max(lc.max(), 1e-9)
    kc = coreness / max(coreness.max(), 1)
    level = np.clip(0.65 * lc + 0.35 * kc**1.5, 0, 1).astype(np.float32)
    return Metrics(deg, providers, customers, peers, cone, coreness, rank, level)


def sample_rank(topo: Topology, g: ig.Graph | None = None, trees: int = 255, seed: int = 7,
                weights=None) -> np.ndarray:
    """Traceroute-style sampling order of links.

    Vantage ASes are taken in random order; from each, the BFS shortest-path
    tree to every other AS is what traceroutes from there would reveal. A
    link's rank is the index of the first tree that uses it (0 = the first
    vantage point's spanning tree), and ``trees`` for links no tree uses.
    Showing links with rank <= k sweeps from one spanning tree (the sparse
    Opte look) to the full AS graph.

    Runs natively in parallel (netmap/native/paths.c); ``weights`` (per edge,
    non-negative) switches the trees from BFS to Dijkstra.
    """
    n, e = topo.n, topo.e
    g = g or graph_of(topo)
    lo = np.minimum(topo.src, topo.dst).astype(np.int64)
    hi = np.maximum(topo.src, topo.dst).astype(np.int64)
    key = lo * n + hi
    order = np.argsort(key)
    skey = key[order]
    rank = np.full(e, trees, np.int32)
    rng = np.random.default_rng(seed)
    # Vantage points in the giant component only (others reach nothing).
    members = np.asarray(g.connected_components().membership)
    gid = int(np.argmax(np.bincount(members))) if n else 0
    cand = np.flatnonzero(members == gid)
    roots = rng.permutation(cand)[:trees]
    try:
        from . import native

        return native.sample_rank(n, topo.src, topo.dst, roots, weights=weights)
    except Exception as exc:  # no compiler: igraph BFS, one tree at a time
        if weights is not None:
            raise
        import sys

        print(f"  native sampling unavailable ({exc}); using igraph", file=sys.stderr)
    vs = np.arange(n)
    for k, r in enumerate(roots):
        _, _, parent = g.bfs(int(r))
        parent = np.asarray(parent)
        ok = (parent >= 0) & (parent != vs)
        a, b = vs[ok], parent[ok]
        q = np.minimum(a, b) * n + np.maximum(a, b)
        pos = np.searchsorted(skey, q)
        eid = order[pos]
        new = rank[eid] > k
        rank[eid[new]] = k
    return rank
