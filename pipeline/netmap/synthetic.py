"""Synthetic AS topology over *real* ASes.

Used when CAIDA's relationship files are unavailable (offline development,
CI, sandboxes). Nodes are the real ASNs, names, address space and geography
from the prefix/geo join; only the *edges* are invented, with a generator
that mimics the shape of the real AS graph:

* a full-mesh clique of well-known transit-free networks,
* tiered provider->customer edges, preferential by customer count and
  biased towards nearby providers (global providers are reachable anywhere),
* regional peering between transit networks,
* IXP-style peering among small networks sharing a metro,
* hypergiant/CDN networks peering with thousands of networks (the bright
  starbursts in the Opte-style maps).

Output is clearly flagged ``synthetic`` all the way through to the viewer.
"""

from __future__ import annotations

import numpy as np

from .asrel import P2C, P2P, Topology
from .geo import EARTH_R_KM, AsProfile

TIER1 = [174, 3356, 1299, 2914, 3257, 6762, 6453, 6461, 3491, 5511, 6830, 12956, 701, 7018, 3320, 6939]
HYPERGIANTS = [15169, 16509, 8075, 13335, 32934, 20940, 2906, 714, 16276, 24940, 14061, 54113, 46489, 36459]


def synthesize(prof: AsProfile, seed: int = 7, scale: float = 1.0) -> Topology:
    rng = np.random.default_rng(seed)
    n = len(prof.asns)
    idx = prof.index()
    lat, lon, conc = prof.lat, prof.lon, prof.concentration
    score = np.log2(prof.addrs + 1) + rng.gumbel(0, 0.8, n)
    # Unit vectors: chord distance via a dot product is plenty for affinities.
    la, lo = np.radians(lat), np.radians(lon)
    V = np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], 1)

    def dist_km(u, pool):
        dot = V[u] @ V[pool].T
        return EARTH_R_KM * np.sqrt(np.maximum(2.0 - 2.0 * dot, 0.0))

    t1 = np.array([idx[a] for a in TIER1 if a in idx], dtype=np.int64)
    hg = np.array([idx[a] for a in HYPERGIANTS if a in idx], dtype=np.int64)
    special = np.zeros(n, bool)
    special[t1] = True
    special[hg] = True

    rest = np.where(~special)[0]
    rest = rest[np.argsort(-score[rest])]
    n_t2 = max(int(len(rest) * 0.025), 5)
    n_t3 = max(int(len(rest) * 0.12), 10)
    t2 = rest[:n_t2]
    t3 = rest[n_t2 : n_t2 + n_t3]
    stubs = rest[n_t2 + n_t3 :]

    tier = np.full(n, 4, np.int8)
    tier[t3] = 3
    tier[t2] = 2
    tier[hg] = 2
    tier[t1] = 1

    src: list[np.ndarray] = []
    dst: list[np.ndarray] = []
    rel: list[np.ndarray] = []

    def add(a, b, r):
        a = np.atleast_1d(np.asarray(a, np.int64))
        b = np.atleast_1d(np.asarray(b, np.int64))
        if a.size == 1 and b.size != 1:
            a = np.repeat(a, b.size)
        elif b.size == 1 and a.size != 1:
            b = np.repeat(b, a.size)
        src.append(a)
        dst.append(b)
        rel.append(np.full(a.size, r, np.int8))

    # Transit-free clique.
    ii, jj = np.triu_indices(len(t1), 1)
    add(t1[ii], t1[jj], P2P)

    customers = np.zeros(n, np.float64)

    def pick(u, pool, k, lam_km, alpha=0.8):
        if len(pool) == 0 or k <= 0:
            return np.empty(0, np.int64)
        d = dist_km(u, pool)
        reach = np.maximum(np.exp(-d / lam_km), 0.6 * (1 - conc[pool]) ** 2 + 1e-4)
        w = (customers[pool] + 1) ** alpha * reach
        k = min(k, len(pool))
        return rng.choice(pool, size=k, replace=False, p=w / w.sum())

    # Hypergiants and large transit buy from tier-1s.
    for u in hg:
        ps = pick(u, t1, int(rng.integers(2, 5)), 4000.0)
        add(ps, u, P2C)
        customers[ps] += 1
    for i, u in enumerate(t2):
        pool = np.concatenate([t1, t2[:i]])  # only larger networks than u
        ps = pick(u, pool, int(rng.integers(2, 5)), 4000.0)
        add(ps, u, P2C)
        customers[ps] += 1

    pool_t12 = np.concatenate([t1, t2])
    for u in t3:
        ps = pick(u, pool_t12, int(rng.choice([1, 2, 3], p=[0.35, 0.45, 0.2])), 900.0)
        add(ps, u, P2C)
        customers[ps] += 1

    # Stubs: batched Gumbel-top-k sampling (same weights as pick()).
    pool = np.concatenate([t1, t2, t3])
    ks = rng.choice([1, 2, 3, 4], size=len(stubs), p=[0.52, 0.33, 0.11, 0.04])
    lw_pool = np.log(customers[pool] + 1)
    floor = 0.6 * (1 - conc[pool]) ** 2 + 1e-4
    for c0 in range(0, len(stubs), 512):
        u = stubs[c0 : c0 + 512]
        d = dist_km(u, pool)
        logw = lw_pool[None] + np.log(np.maximum(np.exp(-d / 350.0), floor[None]))
        keys = logw + rng.gumbel(size=logw.shape)
        top = np.argpartition(-keys, 4, axis=1)[:, :4]
        top = np.take_along_axis(top, np.argsort(-np.take_along_axis(keys, top, 1), 1), 1)
        for row, (uu, k) in enumerate(zip(u, ks[c0 : c0 + 512])):
            ps = pool[top[row, :k]]
            add(ps, uu, P2C)
            customers[ps] += 1

    # Regional peering between transit networks.
    for u in t2:
        k = int(rng.integers(8, 40) * scale)
        pool = t2[t2 != u]
        ps = pick(u, pool, k, 2500.0, alpha=0.5)
        add(u, ps, P2P)
    for u in t3:
        k = int(rng.poisson(4) * scale)
        pool = np.concatenate([t2, t3])
        ps = pick(u, pool[pool != u], k, 500.0, alpha=0.3)
        add(u, ps, P2P)

    # IXP-style metro peering among small networks sharing a ~1 degree cell.
    cell = np.floor(lat + 90).astype(np.int64) * 360 + np.floor(lon + 180).astype(np.int64)
    small = np.concatenate([t3, stubs])
    small = small[rng.random(len(small)) < 0.35]
    order = np.argsort(cell[small], kind="stable")
    small = small[order]
    cs = cell[small]
    bounds = np.flatnonzero(np.diff(cs)) + 1
    for grp in np.split(small, bounds):
        m = len(grp)
        if m < 2:
            continue
        k_each = np.minimum(rng.poisson(2.5 * scale, m), m - 1)
        a = np.repeat(grp, k_each)
        b = grp[rng.integers(0, m, a.size)]
        keep = a != b
        add(a[keep], b[keep], P2P)

    # Hypergiants peer everywhere.
    w_all = np.exp(0.25 * (score - score.max()))
    w_all[special] = 0
    w_all /= w_all.sum()
    for u in hg:
        k = int(rng.integers(1500, 6000) * scale)
        ps = rng.choice(n, size=min(k, n - 1), replace=False, p=w_all)
        add(u, ps, P2P)
    for u in hg:  # and with the tier-1s
        add(u, t1, P2P)

    s = np.concatenate(src)
    d = np.concatenate(dst)
    r = np.concatenate(rel)
    keep = s != d
    s, d, r = s[keep], d[keep], r[keep]
    # Dedupe undirected pairs, preferring the first (transit) relation.
    lo, hi = np.minimum(s, d), np.maximum(s, d)
    key = lo * n + hi
    order = np.lexsort((np.arange(len(key)), r != P2C, key))
    key_sorted = key[order]
    first = np.ones(len(order), bool)
    first[1:] = key_sorted[1:] != key_sorted[:-1]
    sel = order[first]

    return Topology(
        asns=prof.asns.copy(),
        src=s[sel].astype(np.int32),
        dst=d[sel].astype(np.int32),
        rel=r[sel],
        source="synthetic topology over real ASNs (netmap.synthetic)",
        synthetic=True,
        notes=[
            "Edges are generated, not measured. Node identities, names, address "
            "space and geography are real (RouteViews prefix->AS, DB-IP lite).",
        ],
    )
