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
